# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""The MCP side of a replay: the official Python SDK over Streamable HTTP to the server's ``/mcp``,
then the explicit choice of this run's tab before anything else is sent to a tab."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.exceptions import McpError
from mcp.types import CONNECTION_CLOSED, Implementation

from .runner import CallResponse, TransportFailure, parse_tool_result

CLIENT_INFO = Implementation(name="spicy3d-mcp-replay", version="1")
LIST_TABS = "spicy3d_list_tabs"
SELECT_TAB = "spicy3d_select_tab"
CLIENT_TIMEOUT_CODE = 408  # what the SDK raises itself when its read timeout passes


class SetupFailure(Exception):
    """The run never reached its first step (no tab, pairing refused, unexpected initial state)."""


class SdkCaller:
    """`ToolCaller` over an SDK `ClientSession`."""

    def __init__(self, session: ClientSession):
        self.session = session

    async def list_tools(self) -> list[dict[str, Any]]:
        try:
            result = await self.session.list_tools()
        except McpError as error:
            raise SetupFailure(f"tools/list failed: [{error.error.code}] {error.error.message}") from error
        return [tool.model_dump(by_alias=True, exclude_none=True) for tool in result.tools]

    async def call(self, name: str, arguments: dict[str, Any], timeout_s: float) -> CallResponse:
        try:
            result = await self.session.call_tool(
                name, arguments, read_timeout_seconds=timedelta(seconds=timeout_s)
            )
        except McpError as error:
            code, message = error.error.code, error.error.message
            if code == CLIENT_TIMEOUT_CODE or (code == CONNECTION_CLOSED and message == "Connection closed"):
                raise TransportFailure(message) from error
            return CallResponse(outcome="protocolError", error={"code": code, "message": message})
        except Exception as error:  # HTTP failures, a dropped stream
            raise TransportFailure(f"{type(error).__name__}: {error}") from error
        content = [part.model_dump(by_alias=True, exclude_none=True) for part in result.content]
        return parse_tool_result(content, bool(result.isError))


@dataclass
class Connected:
    caller: SdkCaller
    server_info: dict[str, Any]
    tools: list[dict[str, Any]]
    tab: dict[str, Any]


@contextlib.asynccontextmanager
async def connect(
    endpoint: str, token: str, read_timeout_s: float
) -> AsyncIterator[tuple[ClientSession, dict[str, Any]]]:
    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(
        endpoint, headers=headers, timeout=30, sse_read_timeout=read_timeout_s
    ) as (
        read,
        write,
        _session_id,
    ):
        async with ClientSession(read, write, client_info=CLIENT_INFO) as session:
            initialized = await session.initialize()
            yield session, initialized.serverInfo.model_dump(exclude_none=True)


def _tabs_of(result: Any) -> list[dict[str, Any]]:
    """The tab records of a `spicy3d_list_tabs` answer: a list, or the first list found in an object."""
    if isinstance(result, list):
        return [t for t in result if isinstance(t, dict)]
    if isinstance(result, dict):
        for value in result.values():
            if isinstance(value, list) and all(isinstance(t, dict) for t in value):
                return value
    return []


def _tab_id(tab: dict[str, Any]) -> Any:
    return tab.get("tabId", tab.get("id"))


def _select_argument(tools: list[dict[str, Any]]) -> str:
    """The argument name `spicy3d_select_tab` takes the tab id under (from its own input schema)."""
    schema = next((t.get("inputSchema", {}) for t in tools if t.get("name") == SELECT_TAB), {})
    required = schema.get("required") or list(schema.get("properties", {}))
    return required[0] if required else "tabId"


async def select_tab(
    caller: SdkCaller, tools: list[dict[str, Any]], device_name: str, document_id: str, timeout_s: float
) -> dict[str, Any]:
    """Waits for this run's tab (its unique device name, showing the starting document) and selects it.

    Never falls back to "the most recently focused tab": a scenario must not run in someone else's.
    """
    names = {t.get("name") for t in tools}
    if LIST_TABS not in names or SELECT_TAB not in names:
        raise SetupFailure(
            f"the server offers no {LIST_TABS}/{SELECT_TAB}: is this a SpicySrv /mcp endpoint?"
        )
    deadline = time.monotonic() + timeout_s
    seen: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        listed = await caller.call(LIST_TABS, {}, 30)
        if listed.outcome == "ok":
            seen = _tabs_of(listed.result)
            mine = [
                t for t in seen if t.get("deviceName") == device_name and t.get("documentId") == document_id
            ]
            if len(mine) > 1:
                raise SetupFailure(f"{len(mine)} tabs claim this run's device name and document")
            if mine:
                selected = await caller.call(SELECT_TAB, {_select_argument(tools): _tab_id(mine[0])}, 30)
                if selected.outcome != "ok":
                    raise SetupFailure(f"{SELECT_TAB} failed: {selected.text or selected.error}")
                return mine[0]
        await asyncio.sleep(0.5)
    raise SetupFailure(
        f"no tab of device {device_name!r} with document {document_id} appeared within {timeout_s:g}s "
        f"(tabs seen: {json.dumps(seen)[:500]})"
    )


async def check_initial_state(
    caller: SdkCaller, document_name: str, empty: bool, timeout_s: float
) -> dict[str, Any]:
    """The first call that reaches the tab (it waits for the pairing prompt's Allow): the document
    the scenario starts from must be the one open, the kernel alive, and no rebuild pending."""
    state = await caller.call("get_document_state", {}, timeout_s)
    if state.outcome != "ok":
        raise SetupFailure(f"get_document_state failed (pairing refused?): {state.error or state.text}")
    result = state.result if isinstance(state.result, dict) else {}
    if result.get("name") != document_name:
        raise SetupFailure(
            f"the selected tab shows {result.get('name')!r}, not the scenario's {document_name!r}"
        )
    if "kernel" in result:
        raise SetupFailure(f"the geometry kernel is not available: {result['kernel']}")
    if empty and result.get("nodeCount") != 0:
        raise SetupFailure(f"the empty starting document has {result.get('nodeCount')} nodes")
    deadline = time.monotonic() + timeout_s
    while True:
        status = await caller.call("get_rebuild_status", {}, 30)
        if status.outcome == "ok" and isinstance(status.result, dict) and status.result.get("pending") == 0:
            return result
        if time.monotonic() >= deadline:
            raise SetupFailure(f"the starting document is still rebuilding: {status.text}")
        await asyncio.sleep(0.25)
