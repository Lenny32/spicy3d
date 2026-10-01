# Emboss and deboss

Use **Solid → Modify → Emboss / deboss**. Select target faces on one parametric body and confirm the selection, then select closed profiles from one sketch and confirm. Set a positive depth (a length expression is supported), enable **Deboss** for a recess, review the preview, and confirm to create one undo step.

Double-click the feature or use **Edit** to change depth or mode, replace the selected profiles, or reselect target faces. Target reselection temporarily displays the body before the relief feature. Cancel restores the display and leaves the saved document and undo history unchanged. Editing previews use the configured feature-edit preview mode and replay downstream features at rest.

## Geometry and supported surfaces

Planar faces and cylindrical faces are supported. Parallel planar targets use coplanar profile clipping; oblique planes use a through-prism. Cylinders are clipped at the projection silhouette before the profiles are intersected with the trimmed face. The resulting patches are thickened along the target's outward normals and fused to the entering solid, or thickened inward and cut for deboss. Profile holes and partial intersections are retained. A selection with no intersecting patches is an error.

Cylindrical relief is a **directional projection onto the near half**, with constant radial depth. It is not an arc-length-preserving unroll of the sketch and does not extend around the hidden half. Profiles can cross the cylinder's parameter seam. Projection parallel to the cylinder axis, or a sketch plane through the cylinder axis, is refused. Other curved surface types are refused. Inward-facing cavity surfaces and extreme offsets can fail; a failed offset or invalid boolean result is reported without committing the preview. Font and sketch-text creation are outside this change.

Target face references use host-local fingerprints and tracked ancestry on the shape entering the feature. Sketch profile references use existing profile/entity identity. Generated topology is scoped to the feature, target and profile, with local patch/subshape ordinals; fingerprint checks remain the fallback after topology changes. Translation and rotation of a host are covered by kernel tests. Removing or fundamentally changing the selected region can require reselection.

## Persistence

The approved feature payload is `{ id, type: "emboss", sketchId, profiles, faces, depth, deboss }`, plus the existing optional feature name and suppression fields. Both reference arrays are explicit and nonempty. References reuse `ProfileRef`; depth reuses `ParameterValue`; the boolean mode is always stored.

Parametric format **14** adds this feature. The **13 → 14** migration is an identity migration: existing feature payloads are preserved. Document format remains **2** and sketch format remains **3**. Older builds reject documents saved with parametric version 14. The new fixture is `packages/core/test/fixtures/documents/v2/parametric14-emboss.json`; earlier fixtures are unchanged.

Merge rules keep sketch/profile selection together, target faces as one selection, and depth/mode independent. Semantic comparisons distinguish deboss and label target-face and mode changes. Device `.spicy` exports and cloud manifests retain the same approved payload.

## Validation

Kernel tests cover exact planar/cylindrical volumes, profile holes, silhouette and parameter-seam crossings, target orientation, oblique projection, partial intersections, transformed hosts, invalid inputs, offset-failure cleanup, upstream rebuilds and downstream fillet references. Session tests cover creation/editing previews, cancellation, one-step undo/redo, profile replacement and target reselection. Persistence tests cover migration, save/reopen, manifests, `.spicy` export and merge/conflict behavior.
