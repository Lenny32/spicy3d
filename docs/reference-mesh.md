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

## Measuring deviation

Choose **Solid → Inspect → Reference mesh deviation**, select the CAD body and the reference
mesh, and review the mean, RMS and maximum sampled deviation. The command's **Samples**
parameter defaults to 4096. The dialog formats lengths in the project's display unit. Its
red segment connects the worst sampled model point to its nearest reference point (green).
Closing the dialog or document removes the temporary overlay. Measurement does not create
document nodes, edit geometry or save analysis settings; read-only documents can be measured.

MCP `measure_reference_deviation` takes `modelId`, `referenceId`, and optional `sampleCount`
(1–65536) and `timeBudgetMs` (1–60000, default 15000). The model may be a CAD body or another
triangle MeshNode; the reference must be a triangle MeshNode in the same document. Results
include `unit: "mm"`, `sampleCount`, mean/RMS/`maxSampledDeviation`, both triangle counts,
the worst sample and its nearest point, and an accuracy note. Node and parent placement,
rotation, reflection and nonuniform scale are applied to both surfaces. Normals and winding
do not determine the sign: all reported distances are unsigned.

Samples use equal intervals of the model's cumulative triangle area in world coordinates.
Deterministic low-discrepancy barycentric coordinates place a point within each chosen
triangle. For every sample, an AABB hierarchy finds the nearest point on all reference
triangles, including their interiors and boundaries. No reference triangle is decimated or
replaced by its vertices. Mean and RMS approximate area-weighted model-to-reference error.

These are measurements of the **current tessellation**, not exact CAD surfaces. Float32
mesh coordinates and model tessellation affect accuracy; no certified CAD-surface error
bound is available. A larger sample count reduces missed detail but cannot guarantee a
continuous maximum. Small high-error regions may be missed. `maxSampledDeviation` is neither
the continuous maximum nor a Hausdorff distance. This one-way comparison also does not
measure reference regions that the model omits. Incorrect STL import units are not inferred
or corrected automatically; confirm them before comparing.

Meshes are limited to one million triangles each. Mesh preparation, hierarchy construction
and sample queries yield to the browser, honor cancellation and share the processing time
budget. CAD rebuild and initial tessellation happen before that budget; cancellation stops
waiting for a rebuild, but cannot interrupt a synchronous kernel tessellation already running.
Empty, incomplete, non-finite or degenerate triangles fail with an error. An edit during
measurement invalidates its result; rerun after changing geometry or placement.
