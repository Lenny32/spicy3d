# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""Assertions on a step's response. Discrete values compare exactly; numbers from geometry compare
with the explicit tolerance written in the scenario (``approx`` + ``tol``/``rel``) — never by
default. The expected side may itself be a ``{"$ref": …}`` to an earlier response (e.g. the volume
after an undo equals the one before the edit).

    {"path": "result.results.vol", "approx": 24000, "tol": 1e-6}
    {"path": "result.results.bb.min", "approx": [0, 0, 0], "tol": 1e-6}
    {"path": "result.created", "length": 1}
    {"path": "result", "includes": {"state": "completed"}}
    {"path": "result.error", "contains": "radius"}
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from .paths import MISSING, PathError, format_path, lookup, parse_path, resolve

OPERATORS = (
    "equals",
    "notEquals",
    "approx",
    "includes",
    "length",
    "exists",
    "contains",
    "matches",
    "gt",
    "gte",
    "lt",
    "lte",
)
NUMERIC_OPTIONS = ("tol", "rel")
DEFAULT_TOL = 1e-9
DEFAULT_REL = 0.0


@dataclass
class AssertionFailure:
    path: str
    operator: str
    expected: Any
    actual: Any
    detail: str

    def describe(self) -> str:
        return self.detail if self.detail.startswith(self.path) else f"{self.path}: {self.detail}"


def validate_assertion(assertion: Any) -> list[str]:
    """Static problems of one assertion (before anything runs)."""
    if not isinstance(assertion, dict):
        return ["an assertion must be an object"]
    problems: list[str] = []
    try:
        segments = parse_path(assertion.get("path", ""))
        if segments[0].key not in ("result", "text", "outcome", "error", "images"):
            problems.append(
                f"assertion path {assertion['path']!r} must start with result/text/outcome/error/images"
            )
    except PathError as error:
        problems.append(str(error))
    operators = [key for key in assertion if key in OPERATORS]
    unknown = [key for key in assertion if key not in (*OPERATORS, *NUMERIC_OPTIONS, "path", "message")]
    if len(operators) != 1:
        problems.append(
            f"an assertion needs exactly one of {', '.join(OPERATORS)} (got {operators or 'none'})"
        )
    if unknown:
        problems.append(f"unknown assertion keys {unknown}")
    if any(key in assertion for key in NUMERIC_OPTIONS) and operators != ["approx"]:
        problems.append("tol/rel only apply to approx")
    if operators == ["matches"]:
        try:
            re.compile(assertion["matches"])
        except (re.error, TypeError) as error:
            problems.append(f"invalid regular expression: {error}")
    return problems


def _close(actual: Any, expected: Any, tol: float, rel: float, where: str) -> str | None:
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        return None if actual == expected else f"{where}: {actual!r} != {expected!r}"
    if isinstance(expected, (int, float)):
        if isinstance(actual, bool) or not isinstance(actual, (int, float)):
            return f"{where}: expected a number near {expected}, got {actual!r}"
        if math.isnan(actual) or abs(actual - expected) > max(tol, rel * abs(expected)):
            off = abs(actual - expected)
            return f"{where}: {actual} differs from {expected} by {off:.3g} (tol {tol}, rel {rel})"
        return None
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return f"{where}: expected a list of {len(expected)}, got {actual!r}"
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            if problem := _close(a, e, tol, rel, f"{where}[{i}]"):
                return problem
        return None
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return f"{where}: expected an object, got {actual!r}"
        for key, e in expected.items():
            if key not in actual:
                return f"{where}.{key}: missing"
            if problem := _close(actual[key], e, tol, rel, f"{where}.{key}"):
                return problem
        return None
    return f"{where}: cannot compare {expected!r}"


def _includes(actual: Any, expected: Any, where: str) -> str | None:
    """Partial match: objects may have more keys; lists and scalars must match exactly (recursively)."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return f"{where}: expected an object, got {actual!r}"
        for key, e in expected.items():
            if key not in actual:
                return f"{where}.{key}: missing"
            if problem := _includes(actual[key], e, f"{where}.{key}"):
                return problem
        return None
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return f"{where}: expected a list of {len(expected)}, got {actual!r}"
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            if problem := _includes(a, e, f"{where}[{i}]"):
                return problem
        return None
    return None if _scalar_equal(actual, expected) else f"{where}: {actual!r} != {expected!r}"


def _scalar_equal(actual: Any, expected: Any) -> bool:
    """JSON equality: `true` is not `1`, `1` is `1.0`."""
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    return actual == expected


def check(
    assertion: dict[str, Any], response: dict[str, Any], responses: dict[str, Any]
) -> AssertionFailure | None:
    """None when `assertion` holds on `response`; the expected side is resolved against `responses`."""
    segments = parse_path(assertion["path"])
    path = format_path(segments)
    actual = lookup(response, segments)
    operator = next(key for key in assertion if key in OPERATORS)
    expected = resolve(assertion[operator], responses)

    def fail(detail: str) -> AssertionFailure:
        if message := assertion.get("message"):
            detail = f"{message}: {detail}"
        return AssertionFailure(path, operator, expected, None if actual is MISSING else actual, detail)

    if operator == "exists":
        present = actual is not MISSING
        return (
            None
            if present == bool(expected)
            else fail("expected a value" if expected else f"unexpected value {actual!r}")
        )
    if actual is MISSING:
        return fail("no value at this path")
    if operator == "equals":
        return (
            None
            if _includes(actual, expected, path) is None and _same_shape(actual, expected)
            else fail(f"{_short(actual)} != {_short(expected)}")
        )
    if operator == "notEquals":
        return fail(f"unexpectedly equal to {_short(expected)}") if actual == expected else None
    if operator == "approx":
        problem = _close(
            actual, expected, assertion.get("tol", DEFAULT_TOL), assertion.get("rel", DEFAULT_REL), path
        )
        return fail(problem) if problem else None
    if operator == "includes":
        problem = _includes(actual, expected, path)
        return fail(problem) if problem else None
    if operator == "length":
        if not isinstance(actual, (list, str, dict)):
            return fail(f"has no length: {_short(actual)}")
        return None if len(actual) == expected else fail(f"length {len(actual)} != {expected}")
    if operator == "contains":
        if isinstance(actual, str):
            ok = isinstance(expected, str) and expected in actual
        elif isinstance(actual, (list, dict)):
            ok = expected in actual
        else:
            ok = False
        return None if ok else fail(f"{_short(actual)} does not contain {_short(expected)}")
    if operator == "matches":
        if not isinstance(actual, str):
            return fail(f"not a string: {_short(actual)}")
        return None if re.search(expected, actual) else fail(f"{_short(actual)} does not match /{expected}/")
    if isinstance(actual, bool) or not isinstance(actual, (int, float)):
        return fail(f"not a number: {_short(actual)}")
    holds = {
        "gt": actual > expected,
        "gte": actual >= expected,
        "lt": actual < expected,
        "lte": actual <= expected,
    }[operator]
    return None if holds else fail(f"{actual} is not {operator} {expected}")


def _same_shape(actual: Any, expected: Any) -> bool:
    """Exact equality: `includes` plus no extra object keys."""
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and set(actual) == set(expected)
            and all(_same_shape(actual[k], expected[k]) for k in expected)
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(_same_shape(a, e) for a, e in zip(actual, expected, strict=True))
        )
    return True


def _short(value: Any, limit: int = 200) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"
