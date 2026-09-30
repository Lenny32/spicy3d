# Variable-radius fillets

Select edges in the Fillet command, enable **Variable radius**, then **Edit radius law**.
The table uses positions from 0% to 100% and radii in the project's length unit. Radius
cells also accept explicit units and length expressions. Double-click the feature to
edit the law; confirming the owning fillet command records one undo step. Cancelling
the table or command leaves the document unchanged.

Each law has 2–64 samples with strictly increasing positions, including both endpoints.
Resolved radii must be positive finite lengths. Position is normalized **arc length of
the selected edge**, following its natural curve parameter direction. OCCT interpolates
smoothly through the samples; this is not a piecewise-linear radius function. Positive
samples do not guarantee a positive interpolant everywhere. Building the fillet and
checking the resulting BREP can reject an otherwise well-formed law.

OCCT extends the fillet along a tangent-connected contour. Select one edge per contour;
the law applies along that selected edge, with endpoint values propagated to adjoining
edges. Selecting two edges in the same contour is rejected to avoid conflicting laws.
Closed contours require equal endpoint radii.

Existing persistent edge references and kernel history identify the selected edge
after upstream edits. They do not anchor the law to a fixed point in world space: if an
upstream edit reverses the edge's natural parameterization, its physical start and end
radius can exchange. A periodic edge's seam similarly follows its current geometry.

`run_parametric` accepts the same law on `fillet` operations:

```json
{
  "op": "fillet",
  "id": "corner",
  "body": "mouse",
  "edgeIndexes": [0],
  "radiusLaw": [
    { "position": 0, "radius": "noseRadius" },
    { "position": 0.5, "radius": "2 mm" },
    { "position": 1, "radius": "tailRadius" }
  ]
}
```

Use the existing `edges` report and `edgeRefs` to retain selected-edge identity. An
`editFeature` operation with `action: "setRadiusLaw"` replaces the entire law; omitting
`radiusLaw` clears it and restores the feature's retained constant `radius`. Individual
radii are editable through `setParameter` keys `radiusLaw.0`, `radiusLaw.1`, and so on.

The approved saved payload adds only optional `FilletFeatureData.radiusLaw`. Parametric
format 7 follows version 6; its pure identity migration preserves old constant fillets.
Merge treats the complete law as one value, preventing independent edits from combining
into invalid sample order. Older kernels report that variable fillets are unavailable
instead of substituting a constant radius.
