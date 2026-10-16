# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""A local stand-in for the parts of SpicySrv the replay runner goes through.

**Not** SpicySrv and not a target to accept results against: it exists so the runner, the browser
setup and the scenarios can be developed and smoke-tested on a machine without a SpicySrv (the
server lives in its own repository). It serves the built app (``dist/``) and fakes just enough of
the HTTP contract (``packages/cloud/openapi.json``) for the app to sign in with one fixed account and
start remote MCP: ``/api/config`` with ``features.mcp``, ``/api/auth/login``, ``/api/me``,
``/api/me/tokens``, ``/api/me/settings``, an empty ``/api/documents``. The MCP part mirrors the SRV-09
relay as the page sees it (``packages/ai/src/mcp/pageTransport.ts``): ``/ws/mcp-page`` with
``notifications/spicy3d/welcome``/``agents``/``tab``, every forwarded request naming its session in
``_meta["spicy3d/agent"]``, plus a Streamable HTTP ``/mcp`` (JSON answers, no SSE stream) with a
Bearer token and the server-owned ``spicy3d_list_tabs``/``spicy3d_select_tab``.

Pairing is untouched: the tab still asks Allow/Deny for every new session; the browser setup clicks
Allow exactly as it does against SpicySrv.

    python -m spicy_replay standin --dist ../../dist --port 8765
"""

from __future__ import annotations

import argparse
import asyncio
import json
import mimetypes
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

SESSION_COOKIE = "spicy3d_standin_session"
AGENT_META_KEY = "spicy3d/agent"
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
FORWARD_TIMEOUT_S = 600

SERVER_TOOLS = [
    {
        "name": "spicy3d_list_tabs",
        "description": "List the signed-in user's open Spicy3D tabs (stand-in relay).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "spicy3d_select_tab",
        "description": "Choose which open tab the tab tools act on (stand-in relay).",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "string"}},
            "required": ["tabId"],
        },
    },
]


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def problem(status: int, code: str, detail: str = "") -> JSONResponse:
    return JSONResponse(
        {"status": status, "code": code, "detail": detail, "traceId": uuid.uuid4().hex},
        status_code=status,
        media_type="application/problem+json",
    )


@dataclass
class Tab:
    id: str
    socket: WebSocket
    info: dict[str, Any] = field(default_factory=dict)
    focused_at: float = 0.0
    pending: dict[str, asyncio.Future] = field(default_factory=dict)

    async def send(self, message: dict[str, Any]) -> None:
        await self.socket.send_text(json.dumps(message))


@dataclass
class McpSession:
    id: str
    token_name: str
    client_info: dict[str, Any] = field(default_factory=dict)
    initialize: dict[str, Any] | None = None
    tab_id: str | None = None
    initialized_tabs: set[str] = field(default_factory=set)

    def agent(self) -> dict[str, Any]:
        return {"id": self.id, "clientInfo": self.client_info, "tokenName": self.token_name}


class StandIn:
    def __init__(self, dist: Path, email: str, password: str):
        self.dist = dist.resolve()
        self.email = email
        self.password = password
        self.user = {
            "id": str(uuid.UUID(int=0x0190_0000_0000_7000_8000_0000_0000_0001)),
            "email": email,
            "displayName": "Replay Test",
            "emailVerified": True,
            "roles": [],
            "createdAt": "2026-01-01T00:00:00Z",
        }
        self.web_sessions: set[str] = set()
        self.tokens: dict[str, dict[str, Any]] = {}  # secret -> token record
        self.tabs: dict[str, Tab] = {}
        self.sessions: dict[str, McpSession] = {}
        self.loop_clock = 0.0
        self.next_id = 0

    # ---- HTTP API --------------------------------------------------------------------------

    def signed_in(self, request: Request) -> bool:
        return request.cookies.get(SESSION_COOKIE) in self.web_sessions

    @staticmethod
    def csrf_ok(request: Request) -> bool:
        return request.method in ("GET", "HEAD", "OPTIONS") or request.headers.get("x-spicy3d-request") == "1"

    async def config(self, request: Request) -> Response:
        origin = f"{request.url.scheme}://{request.url.netloc}"
        ws = "wss" if request.url.scheme == "https" else "ws"
        return JSONResponse(
            {
                "version": "0.0.0-standin",
                "apiVersion": 1,
                "publicUrl": origin,
                "eventsSocket": f"{ws}://{request.url.netloc}/ws/events",
                "features": {"signup": False, "emailVerification": False, "email": False, "mcp": True},
                "mcp": {
                    "endpoint": f"{origin}/mcp",
                    "pageSocket": f"{ws}://{request.url.netloc}/ws/mcp-page",
                },
                "storage": {
                    "maxUploadBytes": 64 << 20,
                    "maxManifestBytes": 16 << 20,
                    "quotaBytes": None,
                    "trashRetentionDays": 30,
                    "autosaveRetention": {
                        "keepAllHours": 24,
                        "hourlyDays": 7,
                        "dailyDays": 30,
                        "mergeParentDays": 0,
                    },
                },
                "serverTime": now_iso(),
            }
        )

    async def api(self, request: Request) -> Response:
        path = request.url.path
        if not self.csrf_ok(request):
            return problem(403, "csrf_failed")
        if path == "/api/health":
            return JSONResponse({"status": "Healthy"})
        if path == "/api/auth/login" and request.method == "POST":
            body = await request.json()
            if body.get("email") != self.email or body.get("password") != self.password:
                return problem(401, "invalid_credentials")
            sid = secrets.token_urlsafe(24)
            self.web_sessions.add(sid)
            response = JSONResponse(self.user)
            response.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="strict")
            return response
        if path == "/api/auth/logout" and request.method == "POST":
            self.web_sessions.discard(request.cookies.get(SESSION_COOKIE, ""))
            response = Response(status_code=204)
            response.delete_cookie(SESSION_COOKIE)
            return response
        if not self.signed_in(request):
            return problem(401, "unauthorized")
        if path == "/api/me" and request.method == "GET":
            return JSONResponse(self.user)
        if path == "/api/me/settings":
            if request.method == "PUT":
                body = await request.json()
                return JSONResponse({**body, "updatedAt": now_iso()}, headers={"ETag": '"1"'})
            return JSONResponse(
                {"autosave": {"intervalMinutes": 5, "enabled": True}, "updatedAt": None},
                headers={"ETag": '"0"'},
            )
        if path == "/api/me/tokens" and request.method == "POST":
            body = await request.json()
            if body.get("currentPassword") != self.password:
                return problem(403, "invalid_password")
            secret = "spicy_pat_" + secrets.token_urlsafe(24)
            record = {
                "id": str(uuid.uuid4()),
                "name": body.get("name", ""),
                "prefix": secret[:14],
                "scopes": body.get("scopes", []),
                "createdAt": now_iso(),
                "expiresAt": None,
            }
            self.tokens[secret] = record
            return JSONResponse({"token": secret, **record}, status_code=201)
        if path == "/api/me/tokens" and request.method == "GET":
            return JSONResponse([{**t, "lastUsedAt": None} for t in self.tokens.values()])
        if path.startswith("/api/me/tokens/") and request.method == "DELETE":
            token_id = path.rsplit("/", 1)[-1]
            for secret, record in list(self.tokens.items()):
                if record["id"] == token_id:
                    del self.tokens[secret]
                    await self.end_token_sessions(record["name"])
                    return Response(status_code=204)
            return problem(404, "not_found")
        if path == "/api/documents" and request.method == "GET":
            return JSONResponse({"items": [], "nextCursor": None})
        return problem(404, "not_found", "not implemented by the stand-in relay")

    # ---- Static app ------------------------------------------------------------------------

    async def static(self, request: Request) -> Response:
        relative = request.url.path.lstrip("/") or "index.html"
        target = (self.dist / relative).resolve()
        if not target.is_relative_to(self.dist) or not target.is_file():
            if Path(relative).suffix:  # an asset that is not there
                return Response(status_code=404)
            target = self.dist / "index.html"  # SPA route
        media_type = "application/wasm" if target.suffix == ".wasm" else mimetypes.guess_type(target.name)[0]
        return FileResponse(target, media_type=media_type, headers={"Cache-Control": "no-store"})

    # ---- Page socket -----------------------------------------------------------------------

    async def page_socket(self, socket: WebSocket) -> None:
        if socket.cookies.get(SESSION_COOKIE) not in self.web_sessions:
            await socket.close(code=1008)
            return
        await socket.accept()
        tab = Tab(id=uuid.uuid4().hex[:12], socket=socket)
        self.tabs[tab.id] = tab
        await tab.send(
            {
                "jsonrpc": "2.0",
                "method": "notifications/spicy3d/welcome",
                "params": {"tabId": tab.id, "maxMessageBytes": MAX_MESSAGE_BYTES},
            }
        )
        try:
            while True:
                message = json.loads(await socket.receive_text())
                method = message.get("method")
                if method == "notifications/spicy3d/tab":
                    params = message.get("params") or {}
                    tab.info.update(params)
                    if params.get("focused"):
                        self.loop_clock += 1
                        tab.focused_at = self.loop_clock
                    continue
                if method is None and "id" in message:
                    future = tab.pending.pop(str(message["id"]), None)
                    if future and not future.done():
                        future.set_result(message)
                    continue
                if method is not None and "id" in message:
                    # A request of the tab to the client (elicitation, sampling): no client stream here.
                    await tab.send(
                        {
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "error": {
                                "code": -32601,
                                "message": "the stand-in relay forwards no client requests",
                            },
                        }
                    )
                # Notifications of the tab (logging, list_changed) have no stream to go to: dropped.
        except WebSocketDisconnect:
            pass
        finally:
            self.tabs.pop(tab.id, None)
            for future in tab.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("the tab disconnected"))

    async def events_socket(self, socket: WebSocket) -> None:
        if socket.cookies.get(SESSION_COOKIE) not in self.web_sessions:
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            while True:
                await socket.receive_text()
        except WebSocketDisconnect:
            pass

    # ---- MCP endpoint ----------------------------------------------------------------------

    def default_tab(self) -> Tab | None:
        if not self.tabs:
            return None
        return max(self.tabs.values(), key=lambda t: t.focused_at)

    def tab_of(self, session: McpSession) -> Tab | None:
        if session.tab_id and session.tab_id in self.tabs:
            return self.tabs[session.tab_id]
        return self.default_tab()

    async def announce_agents(self) -> None:
        for tab in list(self.tabs.values()):
            agents = [s.agent() for s in self.sessions.values() if self.tab_of(s) is tab]
            try:
                await tab.send(
                    {"jsonrpc": "2.0", "method": "notifications/spicy3d/agents", "params": {"agents": agents}}
                )
            except Exception:
                pass

    async def end_token_sessions(self, token_name: str) -> None:
        for sid in [s.id for s in self.sessions.values() if s.token_name == token_name]:
            del self.sessions[sid]
        await self.announce_agents()

    async def forward(self, tab: Tab, session: McpSession, message: dict[str, Any]) -> dict[str, Any]:
        self.next_id += 1
        relay_id = f"r{self.next_id}"
        params = dict(message.get("params") or {})
        meta = dict(params.get("_meta") or {})
        meta[AGENT_META_KEY] = session.agent()
        params["_meta"] = meta
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        tab.pending[relay_id] = future
        await tab.send({"jsonrpc": "2.0", "id": relay_id, "method": message["method"], "params": params})
        try:
            answer = await asyncio.wait_for(future, FORWARD_TIMEOUT_S)
        finally:
            tab.pending.pop(relay_id, None)
        return {**{k: v for k, v in answer.items() if k != "id"}, "id": message["id"]}

    async def ensure_initialized(self, tab: Tab, session: McpSession) -> None:
        """Replays the session's initialize to a tab that has not seen it (a late or newly selected tab)."""
        if tab.id in session.initialized_tabs or session.initialize is None:
            return
        await self.forward(tab, session, {"id": "init", "method": "initialize", "params": session.initialize})
        await tab.send(
            {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {"_meta": {AGENT_META_KEY: session.agent()}},
            }
        )
        session.initialized_tabs.add(tab.id)

    def server_tool(self, session: McpSession, message: dict[str, Any]) -> dict[str, Any] | None:
        params = message.get("params") or {}
        name = params.get("name")
        if name == "spicy3d_list_tabs":
            current = self.tab_of(session)
            tabs = [
                {
                    "tabId": tab.id,
                    "documentId": tab.info.get("documentId"),
                    "documentName": tab.info.get("documentName"),
                    "deviceName": tab.info.get("deviceName"),
                    "focused": bool(tab.info.get("focused")),
                    "selected": current is tab,
                }
                for tab in self.tabs.values()
            ]
            return self.tool_text(message, {"tabs": tabs})
        if name == "spicy3d_select_tab":
            tab_id = (params.get("arguments") or {}).get("tabId")
            if tab_id not in self.tabs:
                return self.tool_text(message, {"error": f"no open tab {tab_id}"}, is_error=True)
            session.tab_id = tab_id
            return self.tool_text(message, {"selected": tab_id})
        return None

    @staticmethod
    def tool_text(message: dict[str, Any], payload: Any, is_error: bool = False) -> dict[str, Any]:
        result: dict[str, Any] = {"content": [{"type": "text", "text": json.dumps(payload)}]}
        if is_error:
            result["isError"] = True
        return {"jsonrpc": "2.0", "id": message["id"], "result": result}

    async def mcp(self, request: Request) -> Response:
        auth = request.headers.get("authorization", "")
        token = self.tokens.get(auth.removeprefix("Bearer ").strip()) if auth.startswith("Bearer ") else None
        if not token:
            return problem(401, "invalid_token")
        if request.method == "GET":
            return Response(status_code=405)
        if request.method == "DELETE":
            self.sessions.pop(request.headers.get("mcp-session-id", ""), None)
            await self.announce_agents()
            return Response(status_code=200)
        message = await request.json()
        if isinstance(message, list):
            return problem(400, "bad_request", "batches are not supported")
        method = message.get("method")
        if method == "initialize":
            session = McpSession(id=uuid.uuid4().hex, token_name=token["name"])
            params = message.get("params") or {}
            session.client_info = params.get("clientInfo") or {}
            session.initialize = params
            self.sessions[session.id] = session
            # Like the relay, initialize never needs a tab: it is replayed to the tab the session
            # first reaches (ensure_initialized), so a client may connect before the browser does.
            answer = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {
                    "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                    "capabilities": {
                        "tools": {"listChanged": True},
                        "resources": {"listChanged": True},
                        "logging": {},
                    },
                    "serverInfo": {"name": "spicy3d", "version": "standin-relay"},
                },
            }
            return JSONResponse(answer, headers={"Mcp-Session-Id": session.id})
        session = self.sessions.get(request.headers.get("mcp-session-id", ""))
        if session is None:
            return problem(404, "not_found", "unknown MCP session")
        tab = self.tab_of(session)
        if "id" not in message:  # a notification
            if tab is not None:
                params = dict(message.get("params") or {})
                params["_meta"] = {**(params.get("_meta") or {}), AGENT_META_KEY: session.agent()}
                await tab.send({**message, "params": params})
            return Response(status_code=202)
        if method == "tools/call":
            own = self.server_tool(session, message)
            if own is not None:
                await self.announce_agents()
                return JSONResponse(own)
        if tab is None:
            if method == "tools/list":  # no tab: only the relay's own tools
                return JSONResponse(
                    {"jsonrpc": "2.0", "id": message["id"], "result": {"tools": SERVER_TOOLS}}
                )
            return JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {"code": -32000, "message": "no Spicy3D tab is connected"},
                }
            )
        try:
            await self.ensure_initialized(tab, session)
            answer = await self.forward(tab, session, message)
        except (ConnectionError, TimeoutError) as error:
            return JSONResponse(
                {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(error)}}
            )
        if method == "tools/list" and "result" in answer:
            answer["result"]["tools"] = [*answer["result"].get("tools", []), *SERVER_TOOLS]
        return JSONResponse(answer)

    def app(self) -> Starlette:
        return Starlette(
            routes=[
                Route("/api/config", self.config),
                Route("/api/{rest:path}", self.api, methods=["GET", "POST", "PUT", "PATCH", "DELETE"]),
                Route("/mcp", self.mcp, methods=["GET", "POST", "DELETE"]),
                WebSocketRoute("/ws/mcp-page", self.page_socket),
                WebSocketRoute("/ws/events", self.events_socket),
                Route("/{rest:path}", self.static),
            ]
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spicy_replay standin", description=__doc__.split("\n\n")[0])
    parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parents[3] / "dist")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--email", default="replay@standin.test")
    parser.add_argument("--password", default="standin-password")
    args = parser.parse_args(argv)
    if not (args.dist / "index.html").is_file():
        parser.error(f"no build in {args.dist}: run `npm run build` first")
    stand_in = StandIn(args.dist, args.email, args.password)
    uvicorn.run(
        stand_in.app(), host=args.host, port=args.port, log_level="warning", ws_max_size=MAX_MESSAGE_BYTES
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
