# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

import asyncio
import json
from pathlib import Path

import pytest

from spicy_replay.runner import CallResponse, Runner, TransportFailure, missing_tools, parse_tool_result
from spicy_replay.scenario import ScenarioError, load_scenario, parse_scenario

SCENARIOS = sorted((Path(__file__).parents[1] / "scenarios").glob("*.json"))


def scenario(*steps, **extra):
    return parse_scenario(
        {"schema": "spicy3d.mcp-replay", "schemaVersion": 1, "name": "t", "steps": list(steps), **extra}
    )


def ok(result):
    return CallResponse(outcome="ok", result=result, text=[json.dumps(result)])


class FakeCaller:
    """Answers calls from a script: name → list of responses (or exceptions), consumed in order."""

    def __init__(self, script):
        self.script = {name: list(answers) for name, answers in script.items()}
        self.calls = []

    async def list_tools(self):
        return [{"name": name} for name in self.script]

    async def call(self, name, arguments, timeout_s):
        self.calls.append((name, arguments))
        answer = self.script[name].pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


def run(caller, sc, clock=None):
    clock = clock or FakeClock()
    return asyncio.run(Runner(caller, sc, clock=clock, sleep=clock.sleep).run())


@pytest.mark.parametrize("path", SCENARIOS, ids=lambda p: p.stem)
def test_committed_scenarios_are_valid(path):
    loaded = load_scenario(path)
    assert loaded.name == path.stem
    assert loaded.steps


def test_committed_scenarios_cover_the_first_milestone():
    assert {p.stem for p in SCENARIOS} >= {"direct-modeling", "parametric-editing", "background-job"}


def test_later_calls_use_ids_from_earlier_responses():
    sc = scenario(
        {"id": "box", "call": "run_program", "args": {"ops": []}},
        {"id": "fil", "call": "run_program", "args": {"target": {"$ref": "box.result.created[0].nodeId"}}},
    )
    caller = FakeCaller({"run_program": [ok({"created": [{"nodeId": "GEN-1"}]}), ok({})]})
    result = run(caller, sc)
    assert result.passed
    assert caller.calls[1] == ("run_program", {"target": "GEN-1"})
    assert result.steps[1].arguments == {"target": "GEN-1"}


def test_the_first_failing_step_stops_the_run_and_later_steps_are_skipped():
    sc = scenario(
        {"id": "a", "call": "t", "expect": {"assert": [{"path": "result.v", "approx": 1, "tol": 0.1}]}},
        {"id": "b", "call": "t"},
    )
    caller = FakeCaller({"t": [ok({"v": 2})]})
    result = run(caller, sc)
    assert not result.passed
    assert result.first_failure.id == "a"
    assert result.first_failure.failure.kind == "assertion"
    assert result.first_failure.failure.details[0]["actual"] == 2
    assert [s.status for s in result.steps] == ["failed", "skipped"]
    assert len(caller.calls) == 1


def test_tool_errors_fail_unless_expected():
    failing = CallResponse(
        outcome="toolError", result={"error": "radius too large"}, text=['{"error":"radius too large"}']
    )
    unexpected = run(FakeCaller({"t": [failing]}), scenario({"id": "a", "call": "t"}))
    assert unexpected.first_failure.failure.kind == "outcome"
    assert "radius too large" in unexpected.first_failure.failure.message
    expected = run(
        FakeCaller({"t": [failing]}),
        scenario(
            {
                "id": "a",
                "call": "t",
                "expect": {
                    "outcome": "toolError",
                    "assert": [{"path": "result.error", "contains": "radius"}],
                },
            }
        ),
    )
    assert expected.passed


def test_protocol_errors_are_their_own_outcome():
    error = CallResponse(outcome="protocolError", error={"code": -32602, "message": 'unknown tool "x"'})
    result = run(
        FakeCaller({"t": [error]}),
        scenario(
            {
                "id": "a",
                "call": "t",
                "expect": {"outcome": "protocolError", "assert": [{"path": "error.code", "equals": -32602}]},
            }
        ),
    )
    assert result.passed


def test_a_transport_failure_is_never_retried():
    caller = FakeCaller({"t": [TransportFailure("read timeout"), ok({})]})
    result = run(caller, scenario({"id": "a", "call": "t"}, {"id": "b", "call": "t"}))
    assert result.first_failure.failure.kind == "transport"
    assert "not retried" in result.first_failure.failure.message
    assert len(caller.calls) == 1


def test_an_unresolvable_binding_fails_before_calling():
    caller = FakeCaller({"t": [ok({"created": []})]})
    result = run(
        caller,
        scenario(
            {"id": "a", "call": "t"},
            {"id": "b", "call": "t", "args": {"x": {"$ref": "a.result.created[0].nodeId"}}},
        ),
    )
    assert result.first_failure.id == "b"
    assert result.first_failure.failure.kind == "binding"
    assert len(caller.calls) == 1


def job(state, **extra):
    return ok({"jobId": "J", "state": state, "progress": {"completed": 0, "total": 1}, **extra})


def test_wait_job_polls_until_terminal_then_waits_for_rebuilds():
    sc = scenario(
        {"id": "start", "call": "start_parametric_job", "args": {"ops": [{}]}},
        {"id": "done", "waitJob": {"tool": "get_parametric_job", "jobId": {"$ref": "start.result.jobId"}}},
    )
    caller = FakeCaller(
        {
            "start_parametric_job": [job("queued")],
            "get_parametric_job": [job("queued"), job("running"), job("completed", result={"ok": 1})],
            "get_rebuild_status": [ok({"pending": 1}), ok({"pending": 0})],
        }
    )
    result = run(caller, sc)
    assert result.passed
    assert [c[0] for c in caller.calls].count("get_parametric_job") == 3
    assert caller.calls[1] == ("get_parametric_job", {"jobId": "J"})
    assert result.steps[1].response["result"]["state"] == "completed"
    assert result.steps[1].polls == 5


def test_wait_job_expects_completed_by_default():
    sc = scenario(
        {"id": "start", "call": "start_program_job", "args": {"ops": [{}]}},
        {"id": "done", "waitJob": {"tool": "get_program_job", "jobId": {"$ref": "start.result.jobId"}}},
    )
    failed = CallResponse(outcome="toolError", result={"jobId": "J", "state": "failed", "error": "boom"})
    caller = FakeCaller(
        {
            "start_program_job": [job("queued")],
            "get_program_job": [failed],
            "get_rebuild_status": [ok({"pending": 0})],
        }
    )
    result = run(caller, sc)
    assert result.first_failure.id == "done"
    assert "'failed' != 'completed'" in result.first_failure.failure.message
    # The page flags a failed job's snapshot as isError; the wait reads it as a finished poll.
    assert result.first_failure.response["pageOutcome"] == "toolError"


def test_an_expected_job_failure_passes():
    sc = scenario(
        {"id": "start", "call": "start_program_job", "args": {"ops": [{}]}},
        {
            "id": "done",
            "waitJob": {"tool": "get_program_job", "jobId": {"$ref": "start.result.jobId"}},
            "expect": {
                "assert": [
                    {"path": "result.state", "equals": "failed"},
                    {"path": "result.error", "contains": "boom"},
                ]
            },
        },
    )
    failed = CallResponse(outcome="toolError", result={"jobId": "J", "state": "failed", "error": "boom"})
    caller = FakeCaller(
        {
            "start_program_job": [job("queued")],
            "get_program_job": [failed],
            "get_rebuild_status": [ok({"pending": 0})],
        }
    )
    assert run(caller, sc).passed


def test_wait_job_times_out_with_the_last_state():
    sc = scenario(
        {"id": "start", "call": "start_program_job", "args": {"ops": [{}]}},
        {
            "id": "done",
            "waitJob": {"tool": "get_program_job", "jobId": "J", "intervalSeconds": 1},
            "timeoutSeconds": 3,
        },
    )
    caller = FakeCaller({"start_program_job": [job("queued")], "get_program_job": [job("running")] * 10})
    result = run(caller, sc)
    assert result.first_failure.failure.kind == "timeout"
    assert "'running'" in result.first_failure.failure.message


def test_wait_rebuilds_polls_until_none_pending():
    caller = FakeCaller({"get_rebuild_status": [ok({"pending": 2}), ok({"pending": 0})]})
    result = run(caller, scenario({"id": "settle", "waitRebuilds": {}}))
    assert result.passed
    assert result.steps[0].polls == 2


def test_parse_tool_result_reads_json_text_and_counts_images():
    parsed = parse_tool_result(
        [
            {"type": "text", "text": '{"a": 1}'},
            {"type": "image", "data": "x"},
            {"type": "text", "text": "warning"},
        ],
        False,
    )
    assert (parsed.outcome, parsed.result, parsed.images, parsed.text[1]) == ("ok", {"a": 1}, 1, "warning")
    assert parse_tool_result([{"type": "text", "text": "plain"}], True).result == "plain"


def test_required_tools_are_checked_before_anything_runs():
    sc = scenario({"id": "a", "call": "run_program"}, requires={"tools": ["get_rebuild_status"]})
    assert missing_tools(sc, [{"name": "run_program"}]) == ["get_rebuild_status"]


@pytest.mark.parametrize(
    ("data", "problem"),
    [
        ({"schemaVersion": 2}, "not supported"),
        ({"steps": []}, "non-empty"),
        ({"steps": [{"id": "a", "call": "t"}, {"id": "a", "call": "t"}]}, "duplicate id"),
        (
            {
                "steps": [
                    {"id": "a", "call": "t", "args": {"x": {"$ref": "b.result.id"}}},
                    {"id": "b", "call": "t"},
                ]
            },
            "names no earlier step",
        ),
        (
            {"steps": [{"id": "a", "call": "t", "args": {"x": {"$ref": "a.result.id"}}}]},
            "names no earlier step",
        ),
        ({"steps": [{"id": "a", "call": "spicy3d_select_tab"}]}, "the runner's"),
        ({"steps": [{"id": "a", "call": "t", "waitJob": {}}]}, "exactly one of"),
        ({"steps": [{"id": "a", "waitJob": {"tool": "get_program_job"}}]}, "needs jobId"),
        ({"steps": [{"id": "a", "waitJob": {"tool": "run_program", "jobId": "x"}}]}, "waitJob.tool"),
        ({"steps": [{"id": "a", "waitRebuilds": {}, "expect": {"outcome": "toolError"}}]}, "a wait always"),
        ({"steps": [{"id": "a", "call": "t", "expect": {"outcome": "maybe"}}]}, "expect.outcome"),
        ({"steps": [{"id": "a", "call": "t", "expect": {"assert": [{"path": "result.x"}]}}]}, "assertion 1"),
        (
            {"setup": {"settings": {"units": "inch"}}, "steps": [{"id": "a", "call": "t"}]},
            "not supported by schema version 1",
        ),
        ({"setup": {"document": {"kind": "fixture"}}, "steps": [{"id": "a", "call": "t"}]}, 'needs "path"'),
        (
            {"setup": {"assets": ["../secret"]}, "steps": [{"id": "a", "call": "t"}]},
            "inside the scenario folder",
        ),
        ({"extra": 1, "steps": [{"id": "a", "call": "t"}]}, "unknown top-level"),
    ],
)
def test_invalid_scenarios_list_every_problem(data, problem):
    base = {
        "schema": "spicy3d.mcp-replay",
        "schemaVersion": 1,
        "name": "t",
        "steps": [{"id": "a", "call": "t"}],
    }
    with pytest.raises(ScenarioError) as raised:
        parse_scenario({**base, **data})
    assert any(problem in p for p in raised.value.problems), raised.value.problems


def test_fixture_and_assets_must_exist_next_to_the_scenario(tmp_path):
    path = tmp_path / "s.json"
    data = {
        "schema": "spicy3d.mcp-replay",
        "schemaVersion": 1,
        "name": "s",
        "setup": {"document": {"kind": "fixture", "path": "start.spicy"}, "assets": ["mesh.stl"]},
        "steps": [{"id": "a", "call": "t"}],
    }
    path.write_text(json.dumps(data))
    with pytest.raises(ScenarioError) as raised:
        load_scenario(path)
    assert len([p for p in raised.value.problems if "not found" in p]) == 2
    (tmp_path / "start.spicy").write_bytes(b"{}")
    (tmp_path / "mesh.stl").write_bytes(b"solid")
    assert load_scenario(path).document.path == "start.spicy"
