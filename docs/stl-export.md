# STL export tolerances

Choose `.stl` or `.stl binary` in **Export**, then enable **Custom STL tessellation** to
set linear and angular deflection. The linear editor uses the project's length unit;
the underlying value is millimetres. Angular deflection is in degrees. Smaller values
usually produce more triangles, a larger file and closer facets on curved surfaces.
They change the exported approximation, not the CAD geometry.

The MCP `export_nodes` tool accepts optional `linearTolerance` in millimetres and
`angularTolerance` in degrees for either STL format, in both merged and separate modes.
For example: `{ "format": ".stl binary", "linearTolerance": 0.02,
"angularTolerance": 5, "delivery": "base64" }`. Linear tolerance must be finite and
greater than zero; angular tolerance must be finite, greater than zero and at most 180.
Other formats refuse these arguments. Existing download and byte delivery limits apply.

Omitting both values preserves the existing STL export bytes from the display mesh.
Supplying either value creates a fresh mesh on an independent copy of the CAD shape,
without changing the model's topology, geometry, display mesh or triangulation cache.
With only angular tolerance supplied, linear deflection retains the legacy relative
factor of 0.005. With only linear tolerance supplied, angular deflection retains the
legacy 0.2 radians (about 11.46 degrees). Older kernel builds refuse custom settings
explicitly while continuing to support default STL export.

`IDataExchange.export` accepts runtime `DataExportOptions.stl` with the same units;
linear tolerance is converted together with output coordinates when writing another
length unit. The lower-level `IShapeConverter.convertToSTL` accepts these properties
directly on `StlExportOptions`; its linear tolerance uses the input shape's coordinate
unit. STL records no length unit, so the receiving application must use the chosen
export unit.

These are OCCT tessellation controls, not a certified global error bound. Very small
settings can cost considerable meshing time and memory. Native meshing is synchronous.
The kernel tests compare cylinder and sphere facets at 1 mm / 60 degrees versus
0.02 mm / 5 degrees: finer settings increase triangle count and reduce facet-centroid
radial error while CAD volume and cached default STL bytes remain unchanged.
