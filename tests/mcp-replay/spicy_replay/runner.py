# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""Executes a scenario's steps, in order, against an MCP connection.

The runner never retries a call: a request that timed out or lost its connection may already have
committed in the page, so it is a failure of its own kind (``transport``) and the run stops there.
A JSON-RPC error answer is a ``protocolError`` outcome, a tool's ``isError`` result a ``toolError``
outcome — both can be expected by a step. Waits poll the page's job / rebuild status with a bounded
deadline; how many polls it took is reported, never asserted.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .assertions import check
from .paths import UnresolvedBinding, resolve
from .scenario import JOB_STATES_TERMINAL, REBUILD_STATUS_TOOL, Scenario, Step

MAX_REPORTED_CHARS = 20_000


class TransportFailure(Exception):
    """No answer for a request (timeout, connection lost): it may or may not have run in the page."""


@dataclass
class CallResponse:
    """What a step's assertions and later bindings see of an answer."""

    outcome: str  # "ok" | "toolError" | "protocolError"
    result: Any = None  # the first text part, parsed as JSON when it is JSON
    text: list[str] = field(default_factory=list)
    images: int = 0
    error: dict[str, Any] | None = None  # protocolError: {"code", "message"}
    # A wait's answer as the page flagged it, when the runner reads it differently (see _wait_job).
    page_outcome: str | None = None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "outcome": self.outcome,
            "result": self.result,
            "text": self.text,
            "images": self.images,
        }
        if self.error is not None:
            value["error"] = self.error
        if self.page_outcome is not None:
            value["pageOutcome"] = self.page_outcome
        return value


def parse_tool_result(content: list[dict[str, Any]], is_error: bool) -> CallResponse:
    texts = [part.get("text", "") for part in content if part.get("type") == "text"]
    images = sum(1 for part in content if part.get("type") == "image")
    result: Any = None
    if texts:
        try:
            result = json.loads(texts[0])
        except json.JSONDecodeError:
            result = texts[0]
    return CallResponse(outcome="toolError" if is_error else "ok", result=result, text=texts, images=images)


class ToolCaller(Protocol):
    async def list_tools(self) -> list[dict[str, Any]]: ...

    async def call(self, name: str, arguments: dict[str, Any], timeout_s: float) -> CallResponse: ...


@dataclass
class Failure:
    kind: str  # "outcome" | "assertion" | "binding" | "timeout" | "transport"
    message: str
    details: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class StepReport:
    id: str
    kind: str
    tool: str
    note: str = ""
    status: str = "skipped"  # "passed" | "failed" | "skipped"
    arguments: Any = None
    response: dict[str, Any] | None = None
    polls: int = 0
    seconds: float = 0.0
    failure: Failure | None = None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "tool": self.tool,
            "status": self.status,
            "seconds": round(self.seconds, 3),
        }
        if self.note:
            value["note"] = self.note
        if self.arguments is not None:
            value["arguments"] = self.arguments
        if self.polls:
            value["polls"] = self.polls
        if self.response is not None:
            value["response"] = _truncate(self.response)
        if self.failure is not None:
            value["failure"] = {
                "kind": self.failure.kind,
                "message": self.failure.message,
                "details": self.failure.details,
            }
        return value


def _truncate(value: Any) -> Any:
    text = json.dumps(value)
    if len(text) <= MAX_REPORTED_CHARS:
        return value
    return {"truncated": True, "chars": len(text), "head": text[:MAX_REPORTED_CHARS]}


@dataclass
class RunResult:
    steps: list[StepReport]

    @property
    def first_failure(self) -> StepReport | None:
        return next((s for s in self.steps if s.status == "failed"), None)

    @property
    def passed(self) -> bool:
        return self.first_failure is None and all(s.status == "passed" for s in self.steps)


class StepFailed(Exception):
    def __init__(self, failure: Failure):
        super().__init__(failure.message)
        self.failure = failure


def missing_tools(scenario: Scenario, tools: list[dict[str, Any]]) -> list[str]:
    names = {tool.get("name") for tool in tools}
    return [name for name in scenario.required_tools if name not in names]


class Runner:
    def __init__(
        self,
        caller: ToolCaller,
        scenario: Scenario,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_step: Callable[[StepReport], None] | None = None,
    ):
        self.caller = caller
        self.scenario = scenario
        self.clock = clock
        self.sleep = sleep
        self.on_step = on_step
        self.responses: dict[str, dict[str, Any]] = {}

    async def run(self) -> RunResult:
        reports = [StepReport(id=s.id, kind=s.kind, tool=s.tool, note=s.note) for s in self.scenario.steps]
        for step, report in zip(self.scenario.steps, reports, strict=True):
            started = self.clock()
            try:
                await self._run_step(step, report)
                report.status = "passed"
            except StepFailed as failed:
                report.status = "failed"
                report.failure = failed.failure
            report.seconds = self.clock() - started
            if self.on_step:
                self.on_step(report)
            if report.status == "failed":
                break  # later steps depend on this one's state: they are reported as skipped
        return RunResult(reports)

    async def _run_step(self, step: Step, report: StepReport) -> None:
        try:
            arguments = resolve(step.args, self.responses)
        except UnresolvedBinding as error:
            raise StepFailed(Failure("binding", str(error))) from error
        report.arguments = arguments
        if step.kind == "call":
            response = await self._call(step.tool, arguments, step.timeout_s)
        elif step.kind == "waitJob":
            response = await self._wait_job(step, arguments, report)
        else:
            response = await self._wait_rebuilds(step, report, self.clock() + step.timeout_s)
        report.response = response.as_dict()
        self.responses[step.id] = report.response
        if response.outcome != step.expect.outcome:
            raise StepFailed(
                Failure(
                    "outcome",
                    f"expected outcome {step.expect.outcome}, got {response.outcome}: {_summary(response)}",
                )
            )
        failures = []
        for assertion in step.expect.assertions:
            try:
                failure = check(assertion, report.response, self.responses)
            except UnresolvedBinding as error:
                raise StepFailed(Failure("binding", f"expected value: {error}")) from error
            if failure:
                failures.append(failure)
        if failures:
            raise StepFailed(
                Failure(
                    "assertion",
                    "; ".join(f.describe() for f in failures),
                    [
                        {"path": f.path, "operator": f.operator, "expected": f.expected, "actual": f.actual}
                        for f in failures
                    ],
                )
            )

    async def _call(self, tool: str, arguments: dict[str, Any], timeout_s: float) -> CallResponse:
        try:
            return await self.caller.call(tool, arguments, timeout_s)
        except TransportFailure as error:
            raise StepFailed(
                Failure(
                    "transport",
                    f"{tool}: no answer ({error}). The call may already have run in the page; "
                    "it is not retried — rerun the scenario from a fresh state.",
                )
            ) from error

    async def _wait_job(self, step: Step, arguments: dict[str, Any], report: StepReport) -> CallResponse:
        deadline = self.clock() + step.timeout_s
        while True:
            response = await self._call(step.tool, arguments, max(1.0, deadline - self.clock()))
            report.polls += 1
            state = response.result.get("state") if isinstance(response.result, dict) else None
            if state in JOB_STATES_TERMINAL:
                # The poll worked: a failed or cancelled job's snapshot carries "error", which the
                # page flags as isError. The wait succeeded; the job's fate is result.state/error.
                if response.outcome == "toolError":
                    response.page_outcome, response.outcome = response.outcome, "ok"
                break
            if response.outcome != "ok":
                return response  # an unknown job id and the like: the outcome check reports it
            if self.clock() >= deadline:
                raise StepFailed(
                    Failure(
                        "timeout",
                        f"job still {state!r} after {step.timeout_s:g}s",
                        [{"lastResponse": response.as_dict()}],
                    )
                )
            await self.sleep(step.interval_s)
        # A finished job can leave background rebuilds behind (sketch edits): wait for them too.
        settled = await self._wait_rebuilds(step, report, deadline)
        if settled.outcome != "ok":
            raise StepFailed(Failure("outcome", f"{REBUILD_STATUS_TOOL} failed: {_summary(settled)}"))
        return response

    async def _wait_rebuilds(self, step: Step, report: StepReport, deadline: float) -> CallResponse:
        while True:
            response = await self._call(REBUILD_STATUS_TOOL, {}, max(1.0, deadline - self.clock()))
            report.polls += 1
            if response.outcome != "ok":
                return response
            pending = response.result.get("pending") if isinstance(response.result, dict) else None
            if pending == 0:
                return response
            if self.clock() >= deadline:
                raise StepFailed(
                    Failure(
                        "timeout",
                        f"rebuilds still pending after {step.timeout_s:g}s",
                        [{"lastResponse": response.as_dict()}],
                    )
                )
            await self.sleep(step.interval_s)


def _summary(response: CallResponse, limit: int = 500) -> str:
    if response.error:
        text = f"[{response.error.get('code')}] {response.error.get('message')}"
    else:
        text = response.text[0] if response.text else "(no text)"
    return text if len(text) <= limit else text[: limit - 1] + "…"
