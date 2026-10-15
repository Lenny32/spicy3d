# 3MF export

**Export → `.3mf`** writes a [3MF](https://3mf.io/) package (Core Specification, namespace
`http://schemas.microsoft.com/3dmanufacturing/core/2015/02`) that slicers (PrusaSlicer, Bambu
Studio, OrcaSlicer, Cura) and Windows 3D Viewer / 3D Builder open directly.

## What the file holds

- `[Content_Types].xml`, `_rels/.rels` (the StartPart relationship) and `3D/3dmodel.model`.
- `<model unit="…">`: the export unit is **recorded**, not baked into a scale (`mm` → `millimeter`,
  `cm` → `centimeter`, `m` → `meter`, `in` → `inch`); the vertex values are in that unit, so a
  20 mm cube is 20 mm in the slicer whatever unit was chosen.
- Metadata: `Title` (the document name), `Application` (`Spicy3D`), `CreationDate`.
- One `<object type="model" name="…">` and one build `<item>` per exported body, so slicers list
  the parts separately. The world transform is baked into the vertices (no `item transform`).
- Colours: one `<base name displaycolor="#RRGGBB">` per material used (sRGB, alpha dropped);
  each object points at its body's first material through `pid`/`pindex`.

## Mesh

Each body is meshed by OCCT exactly like STL (`IShapeConverter.convertToIndexedMesh`), then
the per-face triangles are welded into one indexed mesh: coincident vertices merged (within
1e-7 of the body's size), triangles collapsed by the merge dropped, winding kept
(counter-clockwise from outside), so a closed solid comes out watertight with outward normals.
Open shells and loose faces are written as they mesh, as for STL; slicers report their open
edges. Bodies without faces are skipped (listed in `skipped`).

The **custom tessellation** options of the export dialog (linear deflection in mm, angular
deflection in degrees) apply to STL and 3MF, and so do the MCP `export_nodes`
`linearTolerance`/`angularTolerance` arguments. The linear deflection is converted to the export
unit with the coordinates.

**Merged** export writes one 3MF with several objects; **one file per object** writes a `.zip` of
`.3mf` files. MCP exports use the MIME type `model/3mf`.

## Not supported (yet)

3MF import; the Production, Materials & Properties, Slice and Beam Lattice extensions;
slicer project settings; thumbnails.
