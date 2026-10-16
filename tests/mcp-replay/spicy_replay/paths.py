# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""Response paths: how a step names a value inside an earlier (or its own) response.

    box.result.created[0].id          step "box", parsed result, first created node's id
    sk.result.created[name=Plate].id  the first element whose ``name`` is "Plate"
    q.result.results["b1.faces"].count  a key containing dots, quoted
    q.result.results.vol              plain keys

A binding is the object ``{"$ref": "<path>"}`` standing for a whole JSON value; strings are never
searched and rewritten. ``{"$literal": <value>}`` passes a value through untouched (for an argument
that really is an object with a ``$ref`` key).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

_TOKEN = re.compile(
    r"""
    (?P<dot>\.)?(?P<key>[A-Za-z_$][\w$-]*)       # .key
    | \[(?P<index>-?\d+)\]                        # [0], [-1]
    | \[(?P<quoted>"(?:[^"\\]|\\.)*")\]           # ["a.b"]
    | \[(?P<field>[A-Za-z_$][\w$-]*)=(?P<value>[^\]]*)\]   # [name=Plate]
    """,
    re.VERBOSE,
)


class PathError(ValueError):
    pass


@dataclass(frozen=True)
class Segment:
    kind: str  # "key" | "index" | "match"
    key: str = ""
    index: int = 0
    value: str = ""

    def __str__(self) -> str:
        if self.kind == "index":
            return f"[{self.index}]"
        if self.kind == "match":
            return f"[{self.key}={self.value}]"
        return f".{self.key}" if re.fullmatch(r"[A-Za-z_$][\w$-]*", self.key) else f"[{json.dumps(self.key)}]"


def parse_path(path: str) -> list[Segment]:
    if not isinstance(path, str) or not path:
        raise PathError("a path must be a non-empty string")
    segments: list[Segment] = []
    position = 0
    while position < len(path):
        match = _TOKEN.match(path, position)
        if not match or match.end() == position:
            raise PathError(f"invalid path {path!r} at {position}")
        if match["key"] is not None:
            if segments and not match["dot"]:
                raise PathError(f"invalid path {path!r}: missing '.' before {match['key']!r}")
            if not segments and match["dot"]:
                raise PathError(f"invalid path {path!r}: leading '.'")
            segments.append(Segment("key", key=match["key"]))
        elif match["index"] is not None:
            segments.append(Segment("index", index=int(match["index"])))
        elif match["quoted"] is not None:
            segments.append(Segment("key", key=json.loads(match["quoted"])))
        else:
            segments.append(Segment("match", key=match["field"], value=match["value"]))
        position = match.end()
    if segments[0].kind != "key":
        raise PathError(f"invalid path {path!r}: it must start with a name")
    return segments


class Missing:
    """No value at a path (distinct from JSON null)."""

    def __repr__(self) -> str:
        return "<missing>"


MISSING = Missing()


def lookup(value: Any, segments: list[Segment]) -> Any:
    """The value at `segments` below `value`, or `MISSING`."""
    for segment in segments:
        if segment.kind == "key":
            if not isinstance(value, dict) or segment.key not in value:
                return MISSING
            value = value[segment.key]
        elif segment.kind == "index":
            if not isinstance(value, list) or not -len(value) <= segment.index < len(value):
                return MISSING
            value = value[segment.index]
        else:
            if not isinstance(value, list):
                return MISSING
            found = next(
                (
                    item
                    for item in value
                    if isinstance(item, dict)
                    and segment.key in item
                    and _text(item[segment.key]) == segment.value
                ),
                MISSING,
            )
            if found is MISSING:
                return MISSING
            value = found
    return value


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return value if isinstance(value, str) else json.dumps(value)


def format_path(segments: list[Segment]) -> str:
    head, *rest = segments
    return head.key + "".join(str(s) for s in rest)


def is_ref(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {"$ref"}


def is_literal(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {"$literal"}


def collect_refs(value: Any) -> list[str]:
    """Every `$ref` path inside an argument tree (not inside `$literal`)."""
    if is_ref(value):
        return [value["$ref"]]
    if is_literal(value):
        return []
    if isinstance(value, dict):
        return [ref for item in value.values() for ref in collect_refs(item)]
    if isinstance(value, list):
        return [ref for item in value for ref in collect_refs(item)]
    return []


class UnresolvedBinding(Exception):
    def __init__(self, path: str, reason: str):
        super().__init__(f"binding {path!r} could not be resolved: {reason}")
        self.path = path


def resolve(value: Any, responses: dict[str, Any]) -> Any:
    """`value` with every `$ref` replaced by the value it names in `responses` (step id → response)."""
    if is_ref(value):
        path = value["$ref"]
        segments = parse_path(path)
        if segments[0].key not in responses:
            raise UnresolvedBinding(path, f"step {segments[0].key!r} has no response")
        found = lookup(responses[segments[0].key], segments[1:])
        if found is MISSING:
            raise UnresolvedBinding(path, "no value at that path in the actual response")
        return found
    if is_literal(value):
        return value["$literal"]
    if isinstance(value, dict):
        return {key: resolve(item, responses) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item, responses) for item in value]
    return value
