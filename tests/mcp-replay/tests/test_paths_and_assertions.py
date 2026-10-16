# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

import pytest

from spicy_replay.assertions import check, validate_assertion
from spicy_replay.paths import MISSING, PathError, UnresolvedBinding, lookup, parse_path, resolve

RESPONSE = {
    "outcome": "ok",
    "result": {
        "created": [
            {"id": "s1", "nodeId": "N1", "name": "Sketch1"},
            {"id": "b1", "nodeId": "N2", "name": "Plate"},
        ],
        "results": {"vol": 24000.0000001, "b1.faces": {"count": 6}, "ok": True},
        "bodies": [{"features": [{"parameters": [{"key": "depth", "value": 20}]}]}],
    },
}


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("result.created[0].nodeId", "N1"),
        ("result.created[-1].name", "Plate"),
        ("result.created[id=b1].nodeId", "N2"),
        ('result.results["b1.faces"].count', 6),
        ("result.bodies[0].features[0].parameters[key=depth].value", 20),
        ("result.results.ok", True),
    ],
)
def test_lookup_follows_keys_indexes_and_matches(path, expected):
    assert lookup(RESPONSE, parse_path(path)) == expected


@pytest.mark.parametrize(
    "path", ["result.created[5].id", "result.created[id=zz].id", "result.nope", "result.results.vol.x"]
)
def test_lookup_reports_missing_values(path):
    assert lookup(RESPONSE, parse_path(path)) is MISSING


@pytest.mark.parametrize("path", ["", ".a", "a..b", "[0]", "a b", "a[x"])
def test_invalid_paths_are_refused(path):
    with pytest.raises(PathError):
        parse_path(path)


def test_resolve_replaces_refs_only_where_written():
    responses = {"plate": RESPONSE}
    args = {
        "body": {"$ref": "plate.result.created[id=b1].nodeId"},
        "label": "plate.result.created[0].nodeId",  # a string is never rewritten
        "list": [{"$ref": "plate.result.results.vol"}],
        "raw": {"$literal": {"$ref": "kept"}},
    }
    assert resolve(args, responses) == {
        "body": "N2",
        "label": "plate.result.created[0].nodeId",
        "list": [24000.0000001],
        "raw": {"$ref": "kept"},
    }


def test_unresolved_binding_names_the_path():
    with pytest.raises(UnresolvedBinding, match="created\\[9\\]"):
        resolve({"$ref": "plate.result.created[9].nodeId"}, {"plate": RESPONSE})


@pytest.mark.parametrize(
    "assertion",
    [
        {"path": "result.results.vol", "approx": 24000, "tol": 1e-6},
        {"path": "result.created", "length": 2},
        {"path": "result.created[0]", "includes": {"name": "Sketch1"}},
        {"path": "result.created[0]", "equals": {"id": "s1", "nodeId": "N1", "name": "Sketch1"}},
        {"path": "result.results.ok", "equals": True},
        {"path": "result.created[1].name", "matches": "^Pl"},
        {"path": "result.created[1].name", "contains": "late"},
        {"path": "result.results.missing", "exists": False},
        {"path": "result.results.vol", "gt": 23999},
        {"path": "result.results.vol", "approx": {"$ref": "before.result.v"}, "tol": 1e-3},
    ],
)
def test_assertions_that_hold(assertion):
    assert validate_assertion(assertion) == []
    assert check(assertion, RESPONSE, {"before": {"result": {"v": 24000}}}) is None


@pytest.mark.parametrize(
    ("assertion", "detail"),
    [
        ({"path": "result.results.vol", "approx": 24001, "tol": 1e-6}, "differs from 24001"),
        ({"path": "result.results.vol", "equals": 24000}, "!="),
        ({"path": "result.created[0]", "equals": {"id": "s1"}}, "!="),
        ({"path": "result.results.ok", "equals": 1}, "!="),  # true is not 1
        ({"path": "result.created", "length": 3}, "length 2 != 3"),
        ({"path": "result.nope", "includes": {}}, "no value"),
        ({"path": "result.created[0].name", "exists": False}, "unexpected value"),
    ],
)
def test_assertions_that_fail_say_why(assertion, detail):
    failure = check(assertion, RESPONSE, {})
    assert failure is not None
    assert detail in failure.describe()


def test_approx_needs_the_tolerance_to_be_explicit():
    # Without tol/rel the comparison is (almost) exact: geometry tolerances are always written down.
    assert check({"path": "result.results.vol", "approx": 24000}, RESPONSE, {}) is not None


@pytest.mark.parametrize(
    ("assertion", "problem"),
    [
        ({"path": "result.x"}, "exactly one of"),
        ({"path": "result.x", "equals": 1, "length": 1}, "exactly one of"),
        ({"path": "x.y", "equals": 1}, "must start with"),
        ({"path": "result.x", "equals": 1, "tol": 1}, "tol/rel only"),
        ({"path": "result.x", "matches": "("}, "regular expression"),
        ({"path": "result.x", "equals": 1, "colour": "red"}, "unknown assertion keys"),
    ],
)
def test_invalid_assertions_are_reported(assertion, problem):
    assert any(problem in p for p in validate_assertion(assertion))
