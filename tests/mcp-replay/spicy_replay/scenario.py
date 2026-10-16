# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""The replay scenario format (``spicy3d.mcp-replay``, schema version 1).

A scenario is its own artifact, versioned independently of the saved document format: it never
changes a document's shape, it only names a starting document (empty, or an existing ``.spicy``
fixture opened as is) and the MCP calls to make on it. See ``README.md`` for the full reference.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .assertions import validate_assertion
from .paths import PathError, collect_refs, parse_path

SCHEMA = "spicy3d.mcp-replay"
SCHEMA_VERSION = 1
STEP_ID = re.compile(r"^[A-Za-z_][\w-]*$")
OUTCOMES = ("ok", "toolError", "protocolError")
JOB_STATES_TERMINAL = ("completed", "failed", "cancelled")
# The job tools the page offers (programJobs.ts); a wait names one of them.
JOB_READ_TOOLS = ("get_program_job", "get_parametric_job", "get_corner_setback_job")
REBUILD_STATUS_TOOL = "get_rebuild_status"
STEP_KINDS = ("call", "waitJob", "waitRebuilds")
# Server-owned tools are used by the runner itself, never by a scenario: they pick the tab.
RUNNER_TOOLS = ("spicy3d_connect", "spicy3d_list_tabs", "spicy3d_select_tab")


class ScenarioError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("invalid scenario:\n  " + "\n  ".join(problems))
        self.problems = problems


@dataclass
class DocumentSetup:
    kind: str  # "empty" | "fixture"
    path: str = ""
    name: str = ""


@dataclass
class Expect:
    outcome: str = "ok"
    assertions: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Step:
    id: str
    kind: str
    tool: str
    args: Any
    expect: Expect
    timeout_s: float
    interval_s: float = 0.25
    note: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class Scenario:
    name: str
    description: str
    document: DocumentSetup
    steps: list[Step]
    required_tools: list[str]
    path: Path | None = None

    @property
    def directory(self) -> Path:
        return self.path.parent if self.path else Path.cwd()


def _require(value: Any, kind: type | tuple[type, ...], what: str, problems: list[str]) -> bool:
    if isinstance(value, kind) and not (kind in (int, float) and isinstance(value, bool)):
        return True
    problems.append(f"{what} must be {getattr(kind, '__name__', kind)}")
    return False


def _number(value: Any, what: str, problems: list[str], *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
        problems.append(f"{what} must be a number within {minimum}–{maximum}")
        return minimum
    return float(value)


def parse_scenario(data: Any, path: Path | None = None) -> Scenario:
    """A validated `Scenario`, or `ScenarioError` listing every problem found."""
    problems: list[str] = []
    if not isinstance(data, dict):
        raise ScenarioError(["a scenario must be a JSON object"])
    if data.get("schema") != SCHEMA:
        problems.append(f'"schema" must be "{SCHEMA}"')
    if data.get("schemaVersion") != SCHEMA_VERSION:
        problems.append(
            f'"schemaVersion" {data.get("schemaVersion")!r} is not supported '
            f"(this runner reads {SCHEMA_VERSION})"
        )
    unknown = set(data) - {"schema", "schemaVersion", "name", "description", "setup", "requires", "steps"}
    if unknown:
        problems.append(f"unknown top-level keys {sorted(unknown)}")
    name = data.get("name", "")
    _require(name, str, '"name"', problems)

    setup = data.get("setup", {})
    document = DocumentSetup(kind="empty")
    if _require(setup, dict, '"setup"', problems):
        unknown = set(setup) - {"document", "settings", "assets"}
        if unknown:
            problems.append(f"unknown setup keys {sorted(unknown)}")
        doc = setup.get("document", {"kind": "empty"})
        if _require(doc, dict, '"setup.document"', problems):
            kind = doc.get("kind")
            if kind not in ("empty", "fixture"):
                problems.append('"setup.document.kind" must be "empty" or "fixture"')
            document = DocumentSetup(kind=kind or "empty", path=doc.get("path", ""), name=doc.get("name", ""))
            if kind == "fixture" and not (isinstance(document.path, str) and document.path):
                problems.append('a fixture document needs "path" (relative to the scenario)')
        # Settings the runner applies would land here; v1 knows none, so a scenario that needs one
        # is refused instead of silently replayed in different conditions.
        if setup.get("settings"):
            problems.append(
                f'"setup.settings" {sorted(setup["settings"])} are not supported by schema version 1'
            )
        assets = setup.get("assets", [])
        if _require(assets, list, '"setup.assets"', problems):
            for asset in assets:
                if not isinstance(asset, str) or Path(asset).is_absolute() or ".." in Path(asset).parts:
                    problems.append(f"asset {asset!r} must be a relative path inside the scenario folder")
                elif path and not (path.parent / asset).is_file():
                    problems.append(f"asset {asset!r} not found next to the scenario")
        if (
            document.kind == "fixture"
            and path
            and document.path
            and not (path.parent / document.path).is_file()
        ):
            problems.append(f"fixture {document.path!r} not found next to the scenario")

    required = (
        list(data.get("requires", {}).get("tools", [])) if isinstance(data.get("requires"), dict) else []
    )
    steps: list[Step] = []
    seen: list[str] = []
    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        problems.append('"steps" must be a non-empty list')
        raw_steps = []
    for number, raw in enumerate(raw_steps, start=1):
        step = _parse_step(raw, number, seen, problems)
        if step:
            steps.append(step)
            seen.append(step.id)
            if step.tool not in required:
                required.append(step.tool)
    if problems:
        raise ScenarioError(problems)
    return Scenario(
        name=name,
        description=data.get("description", ""),
        document=document,
        steps=steps,
        required_tools=required,
        path=path,
    )


def _parse_step(raw: Any, number: int, earlier: list[str], problems: list[str]) -> Step | None:
    where = f"step {number}"
    if not isinstance(raw, dict):
        problems.append(f"{where} must be an object")
        return None
    step_id = raw.get("id")
    if not isinstance(step_id, str) or not STEP_ID.match(step_id):
        problems.append(f'{where}: "id" must match {STEP_ID.pattern}')
        step_id = f"#{number}"
    elif step_id in earlier:
        problems.append(f"{where}: duplicate id {step_id!r}")
    where = f"step {number} ({step_id})"
    kinds = [kind for kind in STEP_KINDS if kind in raw]
    if len(kinds) != 1:
        problems.append(f"{where}: needs exactly one of {', '.join(STEP_KINDS)}")
        return None
    kind = kinds[0]
    unknown = set(raw) - {"id", "note", "expect", "args", "timeoutSeconds", *STEP_KINDS}
    if unknown:
        problems.append(f"{where}: unknown keys {sorted(unknown)}")
    timeout = _number(
        raw.get("timeoutSeconds", 300), f"{where}: timeoutSeconds", problems, minimum=1, maximum=3600
    )
    interval = 0.25
    if kind == "call":
        tool = raw["call"]
        if not isinstance(tool, str) or not tool:
            problems.append(f'{where}: "call" must name a tool')
            tool = ""
        elif tool in RUNNER_TOOLS:
            problems.append(f"{where}: {tool} is the runner's (it selects the tab); scenarios never call it")
        args = raw.get("args", {})
        _require(args, dict, f"{where}: args", problems)
    else:
        if "args" in raw:
            problems.append(f"{where}: a wait takes no args")
        spec = raw[kind]
        if not _require(spec, dict, f"{where}: {kind}", problems):
            return None
        allowed = {"tool", "jobId", "intervalSeconds"} if kind == "waitJob" else {"intervalSeconds"}
        unknown = set(spec) - allowed
        if unknown:
            problems.append(f"{where}: unknown {kind} keys {sorted(unknown)}")
        interval = _number(
            spec.get("intervalSeconds", 0.25), f"{where}: intervalSeconds", problems, minimum=0.01, maximum=60
        )
        if kind == "waitJob":
            tool = spec.get("tool")
            if tool not in JOB_READ_TOOLS:
                problems.append(f"{where}: waitJob.tool must be one of {', '.join(JOB_READ_TOOLS)}")
            if "jobId" not in spec:
                problems.append(f"{where}: waitJob needs jobId (usually a $ref to the start call)")
            args = {"jobId": spec.get("jobId")}
        else:
            tool = REBUILD_STATUS_TOOL
            args = {}
    expect = _parse_expect(raw.get("expect"), kind, where, problems)
    for ref in collect_refs(args) + [
        r
        for a in expect.assertions
        for v in a.values()
        if isinstance(v, (dict, list))
        for r in collect_refs(v)
    ]:
        try:
            head = parse_path(ref)[0].key
        except PathError as error:
            problems.append(f"{where}: {error}")
            continue
        if head not in earlier:
            problems.append(f"{where}: $ref {ref!r} names no earlier step")
    return Step(
        id=step_id,
        kind=kind,
        tool=tool or "",
        args=args,
        expect=expect,
        timeout_s=timeout,
        interval_s=interval,
        note=raw.get("note", ""),
        raw=raw,
    )


def _parse_expect(raw: Any, kind: str, where: str, problems: list[str]) -> Expect:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        problems.append(f"{where}: expect must be an object")
        return Expect()
    unknown = set(raw) - {"outcome", "assert"}
    if unknown:
        problems.append(f"{where}: unknown expect keys {sorted(unknown)}")
    outcome = raw.get("outcome", "ok")
    if outcome not in OUTCOMES:
        problems.append(f"{where}: expect.outcome must be one of {', '.join(OUTCOMES)}")
    if kind != "call" and outcome != "ok":
        problems.append(f"{where}: a wait always expects outcome ok (assert on result.state instead)")
    assertions = raw.get("assert", [])
    if not isinstance(assertions, list):
        problems.append(f"{where}: expect.assert must be a list")
        assertions = []
    for i, assertion in enumerate(assertions, start=1):
        problems.extend(f"{where}: assertion {i}: {p}" for p in validate_assertion(assertion))
    # A finished job is "completed" unless the scenario says what it expects instead.
    if kind == "waitJob" and not any(
        isinstance(a, dict) and a.get("path") == "result.state" for a in assertions
    ):
        assertions = [{"path": "result.state", "equals": "completed"}, *assertions]
    return Expect(outcome=outcome, assertions=assertions)


def load_scenario(path: Path) -> Scenario:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ScenarioError([f"{path}: {error}"]) from error
    return parse_scenario(data, path.resolve())
