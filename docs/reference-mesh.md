# Reference meshes

Use **Solid → Insert → Import reference mesh (STL, mm)** to load a scan as display triangles.
This path supports binary and ASCII STL. It does not convert triangles into OCCT faces or
create a parametric body. The ordinary **Import** command retains its CAD/BREP behavior.

STL does not record units. The ribbon command interprets coordinates as millimetres. For
another source unit, use the MCP tool's `lengthUnit`, or scale the imported mesh with the
existing transform controls. Moving, rotating and scaling a reference uses the same commands
as other visual nodes. Hide/show it with the project-tree visibility control. Its dedicated
material starts at opacity 0.35; edit the material to change opacity or color.

The MCP tool `import_reference_mesh` takes `filename` ending in `.stl` and raw `base64` file
bytes, up to 32 MiB decoded. Optional arguments are `lengthUnit` (`mm`, `cm`, `m`, `in`),
`translation` (`[x,y,z]` in millimetres), `opacity` (0–1) and `visible`. It returns the new
node's `id`, name and triangle count. Existing `transform_node`, `set_node_visible` and
`set_material` tools can adjust it afterwards. Data URLs and remote URLs are not inputs to
this tool.

Malformed, empty, truncated, non-finite or degenerate STL triangles are refused before
adding a mesh or material. Read-only documents refuse import. A successful ribbon or MCP
import is one undo step, including the dedicated material. Saving uses the existing
`MeshNode`, `Mesh` and `Material` payloads without a format change.
