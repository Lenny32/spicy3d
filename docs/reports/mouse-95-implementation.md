# Mouse #95: automatic next-face extrusion

Implemented on `mouse/95-to-next`, based on #83 parametric version 7 and corrected #94.
The necessary backward-compatible save change was directly approved by the user and assigned
parametric version 8 in root's `docs/reports/mouse-schema-plan.md` before implementation.
Document format 2 and sketch format 3 remain unchanged. Existing fixtures are untouched.

The runtime stores `extent` or `secondExtent` as `{type:"next",nodeIds:string[],offset?}`.
Visible, valid parametric candidate body IDs are captured automatically when authoring; the
host input is implicit. Consumed bodies, rolled-back bodies, and bodies depending on the host
are excluded. New bodies created afterward cannot silently enter the search universe. Edit
sessions offer an explicit refresh. Missing saved candidates fail clearly. Each rebuild resolves
host/linked target input timelines and external world transforms before searching, so upstream
geometry or placement edits can select a different nearest face without persisting a winner.

`prismNextTracked` uses exact splitter-generated tools with trimmed ending faces. It projects
bounded cap boundary curves onto the profile plane and compares the entire projected footprint,
including cap pieces, against the profile with OCCT booleans. It rejects folded/overlapping cap
layers. No flat cross section or center witness alone establishes coverage. Projecting trimmed
curves avoids precision loss from OCCT's parameter-preserving projection of unbounded inclined
lines. Pairwise exact solid containment proves the uniformly nearest complete candidate. Ties,
crossing candidates, and nearer partial boundaries fail; piecewise first boundaries are outside
this initial scope. The offset translates the selected face only after selection and revalidates
coverage. Direction follows the signed depth and never flips automatically.

Search limits apply after conservative ray bounds pruning: 64 intersecting bodies, 512 examined
faces, and 32 valid bounded tools. The authoring snapshot additionally has a 1024-ID guard with
an instruction to hide unrelated bodies. Profile-relative history and cap channels preserve the
existing tracked identity pipeline; runtime selected body/face indexes are unsaved diagnostics.
The native checkpoint is `86253ac5238d196e36cffd85a46c8da13164ecb4`, with matching WASM artifacts
built after #82 diagnostics, corrected #94, #103 mesher, and #83 variable fillets.

UI create/edit sessions expose To next and its expression offset without a face pick. Preview
failures gate confirmation; commit reconstructs the actual sketch profiles and validates the
native tool before adding a feature. Editing a refresh or offset is one undo step. MCP/program
callers use `extent:"next"` or `{type:"next",offset?}`; supplying candidate IDs is rejected.

Version 7→8 is a pure identity migration: absent Next fields preserve every prior extent.
The new immutable `v2/parametric8-next.json` fixture combines a selected starting face with a
2 mm expression offset and an automatic exact next cap. Its 4×4 profile spans z=2..10 and has
volume 128 mm³. The Next snapshot and offset merge atomically; candidate IDs retain dangling
node-reference validation. `splitManifest` and `assembleManifest` preserve the fixture exactly,
including its feature JSON through content-addressed blobs. This exercises the same core
payload path used by cloud manifests, while existing `.spicy`/local envelopes use the same
serialized feature JSON and pure module migration.

Validation covers exact cylindrical underside volume, a 0.05 mm thin curved wall with cap
height variation exceeding the wall thickness and no common axial cross section, partial/tied/
crossing caps, no direction reversal, all search budgets and pruning, upstream radius and
placement edits, captured downstream fillet edge identity, host input timeline cuts, MCP JSON
calls, UI create/edit/refresh/undo/refusal, cloud assembly, atomic/dangling merges, and every
historical document fixture rebuilding and saving unchanged. Checkout-local package aliases
were required because shared workspace symlinks otherwise mix root and worktree modules.
Temporary alias configs are validation helpers and are excluded from the implementation commit.

Final combined validation: 234 tests passed across 12 files; checkout-local TypeScript and required scoped npm check passed. The committed C++ was clang-formatted before rebuilding its artifacts.
