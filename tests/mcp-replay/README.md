# MCP replay scenarios

Integration tests that replay a fixed list of MCP tool calls through the real execution path —
**Python runner → SpicySrv `/mcp` → the browser tab's MCP server → WASM kernel** — with no AI in the
loop. Later calls bind to ids the current run's responses returned, and geometry is checked with
explicit numeric tolerances (ticket #149, first milestone).

```bash
# Against a test deployment (a SpicySrv serving the candidate build, MCP enabled):
SPICY3D_REPLAY_URL=https://spicy.test \
SPICY3D_REPLAY_EMAIL=replay@example.test SPICY3D_REPLAY_PASSWORD=… \
    npm run mcp:replay -- tests/mcp-replay/scenarios/*.json

# Without a SpicySrv: the local stand-in relay serving ./dist (npm run build first)
npm run mcp:replay -- --standin tests/mcp-replay/scenarios/*.json

# Options: --repeat N (each run from fresh state), --headed, --artifacts always,
#          --ignore-https-errors (internal CA), --report-dir DIR, -v
tests/mcp-replay/.venv/bin/python -m pytest tests/mcp-replay/tests   # the runner's own unit tests
PYTHONPATH=tests/mcp-replay tests/mcp-replay/.venv/bin/python -m spicy_replay validate <scenario…>
```

`run.sh` (what `npm run mcp:replay` calls) creates `.venv` from the hash-pinned `requirements.txt`
(uv if present, else `python3 -m venv` + pip; Python 3.12), installs Playwright's headless Chromium,
and runs `python -m spicy_replay run`. Exit codes: **0** all passed, **1** a step failed, **2** an
invalid scenario or usage, **3** the environment could not be set up (nothing was replayed).

## What a run does

For each scenario, from scratch:

1. **Browser** (`spicy_replay/browser.py`, Playwright): a fresh Chromium context; the tab gets a
   unique device name (`cloud.device` in localStorage) before the app starts; sign-in through
   `POST /api/auth/login`; a short-lived `mcp:read`+`mcp:write` access token named `mcp-replay <run>`
   (`POST /api/me/tokens`, revoked at the end); the app loads and the kernel comes up; the starting
   document opens as a **device** document (`app.repositories.local`, so no cloud sync or pulls
   touch it) — empty, or the scenario's `.spicy` fixture through `app.loadDocument` (migrations run).
2. **MCP** (`spicy_replay/session.py`, the official Python SDK, Streamable HTTP with the token): the
   endpoint comes from `/api/config` (`mcp.endpoint`); the runner waits for *its* tab in
   `spicy3d_list_tabs` (its device name showing its document id) and selects it with
   `spicy3d_select_tab` — never "the most recently focused tab"; then checks every tool the
   scenario names is offered.
3. **Pairing**: the first call that reaches the tab (`get_document_state`) waits for the tab's
   normal pairing prompt, which the browser half answers with **Allow** — only for this run's token
   name. That call also verifies the starting state: the right document, the kernel alive, an empty
   document with no nodes, no rebuild pending.
4. **Steps** (`spicy_replay/runner.py`), one at a time, each to its answer.
5. **Report** `reports/<time>/<scenario>/report.json`; on failure (or `--artifacts always`) also
   `page.png`, `console.log` and `document.json` (the document as `serialize()` gives it — gzip it
   and it is a `.spicy`).

One editing tab, one MCP caller, one document per run; nothing in the account is left behind but
the revoked token. Credentials only come from the environment; neither they nor the token are
written anywhere (console lines are redacted).

## Scenario format (`spicy3d.mcp-replay`, schema version 1)

A scenario is its own artifact, versioned independently of the saved document format (which it
never touches: a fixture is an ordinary `.spicy` opened as is).

```jsonc
{
  "schema": "spicy3d.mcp-replay",
  "schemaVersion": 1,
  "name": "direct-modeling",            // also the report folder's name
  "description": "…",
  "setup": {
    "document": { "kind": "empty" },    // or { "kind": "fixture", "path": "fixtures/x.spicy", "name"?: "…" }
    "settings": {},                     // none supported in v1: any entry is refused, never ignored
    "assets": []                        // files the scenario needs, relative to it (checked up front)
  },
  "requires": { "tools": [] },          // extra tools to check; every tool a step names is checked anyway
  "steps": [ … ]
}
```

Every scenario is validated completely before the browser starts (unknown keys, ids, `$ref`s to
later steps, assertion syntax, missing fixture/assets all fail with exit code 2).

### Steps

Each step has an `id` (letters, digits, `_`, `-`), an optional `note`, `timeoutSeconds` (default
300) and exactly one of:

| kind | shape | the step's response |
| --- | --- | --- |
| call | `"call": "<tool>", "args": { … }` | the tool's answer |
| job wait | `"waitJob": { "tool": "get_program_job" \| "get_parametric_job" \| "get_corner_setback_job", "jobId": …, "intervalSeconds"?: 0.25 }` | the last poll (terminal state) |
| rebuild wait | `"waitRebuilds": { "intervalSeconds"?: 0.25 }` | the last `get_rebuild_status` (`pending: 0`) |

A job wait polls until `completed`/`failed`/`cancelled`, then also until no rebuild is pending, all
within `timeoutSeconds`; it expects `completed` unless the step asserts `result.state` itself.
The number of polls is reported, never asserted, and neither is progress timing. The runner's own
tools (`spicy3d_connect`, `spicy3d_list_tabs`, `spicy3d_select_tab`) are not allowed in steps.

### Responses and bindings

What assertions and later steps see of a step:

```jsonc
{ "outcome": "ok" | "toolError" | "protocolError",
  "result": …,        // the first text part, parsed when it is JSON (the tools answer JSON)
  "text": ["…"],      // every text part (slow-op warnings come as a second part)
  "images": 0,        // number of image parts
  "error": { "code": -32602, "message": "…" } }   // protocolError only
```

`toolError` = the tool answered with `isError` (the page's `{"error": …}` convention);
`protocolError` = a JSON-RPC error (unknown tool, pairing refused `-32005`, …). A step expects
`ok` unless it says `"expect": { "outcome": "toolError" }` — an expected failure is then asserted
like any answer. A job that ended `failed`/`cancelled` is a finished wait (`outcome: ok`): the
page flags such a snapshot as `isError` because it carries `error`, which the report keeps as
`pageOutcome`.

A binding is an object standing for a whole value — strings are never searched and rewritten:

```jsonc
{ "$ref": "box.result.created[0].nodeId" }          // step id, then a path into its response
{ "$ref": "plate.result.created[id=b1].nodeId" }    // [field=value]: first element whose field is value
{ "$ref": "q.result.results[\"b1.faces\"].count" }  // a key containing dots, quoted
{ "$literal": { "$ref": "not a binding" } }          // passed through untouched
```

A `$ref` may only name an earlier step. A value missing at run time fails the step (`binding`)
before anything is sent. Modeling op aliases stay as the tools define them: `run_program` /
`run_parametric` op ids are plain strings inside `args` and keep working across calls in the same
document — but they live in per-document runtime maps a `.spicy` does not restore, so a fixture
scenario addresses its objects by the node and feature ids stored in the file
(`scenarios/fixture-editing.json`).

### Assertions

```jsonc
"expect": {
  "outcome": "ok",
  "assert": [
    { "path": "result.results.vol", "approx": 24000, "tol": 1e-6 },          // |a−e| ≤ max(tol, rel·|e|)
    { "path": "result.results.bb", "approx": { "min": { "x": 0, "y": 0, "z": 0 }, "max": { "x": 40, "y": 30, "z": 20 } }, "tol": 1e-6 },
    { "path": "result.created", "length": 1 },
    { "path": "result.nodes[0].id", "equals": { "$ref": "box.result.created[0].nodeId" } },
    { "path": "result", "includes": { "state": "completed" } },              // objects may have more keys
    { "path": "result.error", "contains": "radius" },                        // substring / list item / key
    { "path": "result.error", "matches": "(?i)fillet" },                     // regex search
    { "path": "result.error", "exists": false },
    { "path": "result.results.vol", "gt": 0 }                                // gt / gte / lt / lte
  ]
}
```

Paths start at `result`, `text`, `outcome`, `error` or `images`. `equals` is exact JSON equality
(`true` is not `1`); `approx` compares numbers inside numbers/lists/objects with the tolerance
written in the scenario (default: none worth the name — geometry tolerances are always explicit).
The expected side may be a `$ref` (the volume after undo equals the one before). An optional
`message` prefixes the failure text.

Geometry oracles are the kernel's own queries through `run_program` — `shape.volume`,
`shape.boundingBox`, `shape.checkShape`, `shape.findSubShapes` counts — with analytic expected
values where possible; never BREP bytes or screenshot pixels. Structure comes from
`get_document_state`, `run_parametric`'s `features`, `document_variables`. Nothing in a response is
normalized: assert the fields that matter, leave generated ids and timings to bindings.

## Scenarios

| scenario | covers |
| --- | --- |
| `direct-modeling` | `run_program` box, a fillet the kernel refuses + rollback check, the real fillet bound to the box's node id (analytic volume, validity, face/solid counts), undo/redo |
| `parametric-editing` | variables, sketch + extrude + pocket cut, a variable change and `editFeature` replaying later features, a refused edit + rollback, undo |
| `background-job` | `start_parametric_job` moving sketch entities bound by their ids, `start_program_job`, a parametric job that fails and rolls back its first op, waits through terminal state + rebuilds |
| `fixture-editing` | starts from `fixtures/pocket-plate.spicy`, checks the loaded geometry and variables, edits by stored ids |

A new baseline is reviewed like code: write the expected values from the model's intent (analytic
volumes, known topology), not by copying whatever the current build answered.

## What is and is not deterministic

Supported (repeatable, `--repeat` from fresh state): sequential modeling scenarios — every call
awaited before the next, background jobs awaited to a terminal state. Not supported, and not to be
faked by replaying delays: cancellation timing, deadlines, reconnects, concurrency between callers.
Those need controlled lifecycle tests of their own.

## The stand-in relay (`spicy_replay/standin.py`)

SpicySrv lives in its own repository. To develop the runner and scenarios without it,
`--standin` serves `dist/` with just enough of the HTTP contract (`packages/cloud/openapi.json`) for
the app to sign in with one fixed account and start remote MCP, plus the relay as the page sees it
(`/ws/mcp-page`: welcome/agents/tab notifications, `_meta["spicy3d/agent"]` on every request; a JSON
Streamable HTTP `/mcp` with Bearer tokens and `spicy3d_list_tabs`/`spicy3d_select_tab`). The page,
its pairing prompt and the kernel are the real ones. **It is not SpicySrv**: a pass there says the
runner, the scenarios and the app work; acceptance of the full path needs a real deployment.

Assumed about SpicySrv and to be confirmed on the first real run: `spicy3d_list_tabs` answers JSON
with a list of tabs carrying `tabId` (or `id`), `deviceName` and `documentId`;
`spicy3d_select_tab` takes the tab id as its single required argument (read from its schema).
