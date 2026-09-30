# Mouse project schema coordination

The boss approval in [mouse-plan.md](../../mouse-plan.md) permits necessary backward-compatible
payload changes for #81–#106. Existing fixtures and unknown-node/userData content remain unchanged.
After the approval reviewer rejected file-based authorization, the user directly confirmed
"Approve the plan’s backward-compatible format changes" in response to the explicit approval
question covering #81–106 and the sketch-3 proposal below. No further approval is needed within
that scope; unrelated format redesign remains outside the authorization.
The document envelope stays at version 2. Parametric remains version 5 until a separate feature
payload design is approved and assigned here.

## #93: control-point and weighted sketch B-splines

Approved owning module version: **sketch 3**, from sketch 2. Worker: `mouse_86`, in the isolated
`mouse/93-control-nurbs` branch. This is the only authorized sketch payload change in this wave.

Add optional `SketchEntityData.control` for existing `type: "bspline"` entities:

```ts
control?: {
    degree: number;
    knots: number[];
    multiplicities: number[];
    weights?: number[];
};
```

When present, the existing `params` coordinate vector holds UV control poles. The existing
`periodic` flag retains its meaning. Absent `control` preserves fit-point behavior and all existing
defaults. Control mode rejects simultaneous fit parametrization. Omitted weights mean unit weights.
Control mode must preserve entity ids while editing poles, weights, degree and knots.

Initial open control curves require clamped endpoint multiplicities, keeping existing endpoint and
end-tangent point references honest. Periodic control curves support the existing uniform,
multiplicity-one periodic layout initially; unsupported custom periodic layouts receive a clear
validation error. These restrictions must be explicit in the UI, MCP schema and documentation.
No rational approximation is silently substituted on older kernels lacking the B-spline binding.

The sketch 2→3 migration is pure identity: every earlier sketch remains valid without data rewrite.
The existing atomic entity `params` merge rule remains; the new `control` definition is atomic as
one coherent layout, preserving unknown fields through existing merge behavior. Geometry validation
must identify incompatible merged layout/pole combinations as rebuild failures.

Root assigns `mouse_86` ownership of the sketch-only version/migration registration in
`parametric/src/migrations.ts`, the sketch entity rule in `parametric/src/mergeRules.ts`, a NEW
`core/test/fixtures/documents/v2/sketch3-control-nurbs.json` fixture and affected current-version
assertions. Existing fixtures are immutable. No other worker may edit those sections in this wave.

Required validation: old documents/fit splines, rational known geometry, solver constraints and
editing/picking previews, native parity, persistence/undo, pure migration, merge rules and conflict
fixtures, document compare/history/restore/cloud-compatible payload paths. Older application
releases need not read the newly saved sketch-3 payload.

## Reserved later feature payloads

#83/#84, #85, #88/#89/#90 and #94/#95 remain pending kernel feasibility and concrete design.
No worker may bump parametric versions or introduce these fields independently. Assign consecutive
versions and serialize migration/rule ownership after each payload design is reviewed.
