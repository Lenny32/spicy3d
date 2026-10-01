// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Skill } from "./types";

export const modelingRecipes: Skill = {
    name: "modeling-recipes",
    description:
        "Proven op compositions for common parts and edits: flange/bracket patterns, fillet & chamfer workflow, hole patterns, compounds",
    content: `Modeling recipes (units: mm, angles: degrees). Compose these in ONE run_program when possible.

General loop:
1. Plan exact dimensions first (footprint, heights, hole positions as coordinates).
2. Chain ops with ids in a single run_program; later ops reference earlier ids. A dimension held in a document variable can be passed by name — thickness: "wall_t" (any numeric arg takes an expression string) — but run_program evaluates it once and the node keeps that number; when the part must follow later changes of the variable, build it with run_parametric instead.
3. Edit-style ops (booleanCut/booleanFuse/booleanCommon, fillet, chamfer, pushPull, makeThickSolid*, removeFeature/removeFillet/removeSubShape/replaceSubShapes, simplifyShape, fillet2d/chamfer2d) CONSUME their input nodes and create a replacement node — afterwards reference the NEW op id, the old node is gone. Creation ops (box, cylinder, prism, revolve, sweep, loft, sewing, combine, transformedMul, ...) keep their inputs in the scene — hide or delete the ones that were only scaffolding (a tool solid cut away by a later boolean), and leave the parts the user asked for in the scene.
4. Default to separate parts: a model of several parts is several nodes. Do NOT booleanFuse unrelated bodies just to end up with fewer nodes. fuse only when the parts really are one solid (a boss fused onto its plate); to group parts without merging them, use combine([...]).
   Grouping in the MODEL TREE is a different thing from combining geometry: create_folder (pass the part ids as nodeIds) puts nodes under one collapsible folder and changes no shape, and move_nodes re-parents them later or sends them back to the root. Reach for a folder to keep a multi-part result tidy for the user; reach for combine only when the parts must become one compound shape.

Cleanup: use delete_node({ ids: [...] }) or set_node_visible({ ids: [...], visible: false }) to clean up many scaffolding nodes in one call and one undo step. Pass either id or ids, never both; id keeps the single-node response. Batches accept 1–100 ids of at most 128 characters. Batch results are in input order: each entry has id and deleted/visible on success or error on failure. Missing ids do not block valid nodes; any failure also sets a top-level error, so inspect results and retry only failed ids. Duplicates are applied once. Deleting a folder deletes its descendants; hiding a folder hides its descendants through inherited visibility. A mutation failure rolls back the whole batch and reports every valid target as failed.

Fillet / chamfer workflow:
- { method: "shape.findSubShapes", target: "body", id: "e", args: { subshapeType: "edge" } } -> results.e = { count, refs }.
- Identify the edges you want by geometry: query edge.ends (or edge.length, edge.curve) on candidates like e#0, e#1 — e.g. vertical edges have equal x/y at both ends; top edges have max z.
- { method: "fillet", id: "f1", args: { shape: "body", edges: [<indices>], radius: 2 } } — the number in an edge ref e#3 IS the index for "edges". fillet consumes "body"; the result is the new node f1. Too-large radius fails — keep radius below half the smallest adjacent face dimension.

Validity checks (offset / thickened results):
- Run shape.checkShape on offset/thickened results (makeThickSolid*, offsets of lofted or swept skins) before booleans or inspections; the kernel cannot recover from a failed boolean on a self-intersecting solid. shape.checkFaces names the faulty faces.
- checkShape does not test self-intersection (offset faces crossing at steep, narrow ends). shape.checkSelfIntersection does (true = none found); it is expensive on shapes with many faces, and older kernel builds answer an error "not available in this kernel build".
- makeThickSolid* already fail with "Thick solid is invalid" when the result does not pass checkShape; shape.inspectionCommonVolume / shape.inspectionMass refuse an input that does not pass it.
- Offset failures may identify a likely input face index, position (mm, local shape coordinates), and sampled curvature radius <= |thickness| in the offset direction. Reduce the absolute thickness below that radius or smooth the named region. This is bounded sampling, not a proven maximum thickness: narrow creases and collisions between distant walls may be missed. No self-intersection-trimming envelope mode is exposed; simple thickening is already used for open skins, and skin/pipe or arc/intersection do not guarantee a valid envelope.
- makeThickSolid* (and the thicken feature) also fail with "offset edge curves are inconsistent with their surfaces" when an offset edge leaves its face between sample points — seen on open ruled lofts between periodic bsplines. Such a solid would pass checkShape but break every later boolean. Instead build the skin as a solid loft and thicken it with its end caps as open faces (makeThickSolidByJoin / thicken openFaces), or change the thickness or the sections.

Long kernel ops (the tab freezes while one runs):
- run_program sends supported expensive factory operations to the bounded geometry worker. Those operations have a finite deadline; cancellation terminates their worker generation and rolls back the program. Other queries and operations can still run synchronously in the page and delay tools until they return. Metadata status tools remain available during bounded work. A main-kernel crash requires recover_kernel (when listed, clearing undo/redo) or Reload.
- makeThickSolidByJoin with joinType "intersection" on a shell with many faces (a lofted or swept skin, G2 lofts in particular) may NEVER finish: OCCT intersects the offset faces pairwise. It is refused above 40 input faces (error "MakeThickSolidByJoin refused: … N faces (limit 40) …"). Use joinType "arc", or makeThickSolidBySimple for an open skin; build the skin with fewer sections before thickening.
- An op that took longer than the slow-op budget (30 s by default) is reported as a "Warning: op … took N s" line in the next tool result: do not repeat it as it was; choose a cheaper variant.

Flange (base plate + boss + bolt circle):
1. base: box(plane at corner, dx, dy, dz) id "base".
2. boss: cylinder(normal +Z, center at plate center on top face, radius r, dz h) id "boss".
3. body: booleanFuse(["base"], ["boss"], true) id "body" — consumes both: plate and boss really are one solid, so fusing is right here.
4. one hole tool: cylinder at first bolt position, radius holeR, dz = plate+boss height + margin, id "h0".
5. copies: transformedMul rotate around the flange axis (axis {0,0,1} through the center) by 90/180/270 degrees, ids "h1".."h3" — transformedMul does NOT consume h0.
6. cut: booleanCut(["body"], ["h0","h1","h2","h3"]) id "flange" — one op cuts all holes and consumes the tools.

Loft through sketches:
- run_program loft takes sketch node ids directly as sections: { method: "loft", id: "skin", args: { sections: ["<sketchA>", "<sketchB>"], isSolid: true, isRuled: false, continuity: "c2" } }. A sketch's loose edges are chained into the section wire for you — no scaffold wire ops. OPEN chains are fine (isSolid: false gives an open skin); a sketch with several separate chains (e.g. an outline plus a hole) is refused with "Section <i> has <n> separate edge chains": pick one with shape.findSubShapes + wire.
- For single-profile sketches (closed, or one open wire per sketch with solid: false) the user may want to re-edit, prefer run_parametric's loft op (load_skill parametric-modeling): it follows the sketches when they change.

Patterns / arrays:
- Linear: transformedMul with translate = i * spacing per copy. Circular: transformedMul with rotate around the pattern axis. Create copies first, then one boolean op with all of them in shape2.

Placement reminders (details in the modeling-api skill):
- box/rect/pyramid: plane.origin is a CORNER. Center a box at P: origin = P - (dx/2, dy/2, dz/2).
- cylinder/cone: center is the BASE-face center, extends +dz along normal.

Compounds:
- combine([...]) groups shapes into one compound node without fusing them; shape.volume and shape.boundingBox work on compounds (volume sums the solids inside). Fusing disjoint solids is not a recipe — it yields a compound of loose solids anyway.

Verify: after the build, select_nodes the result, fit_content, capture_screenshot — check proportions, and check that no scaffolding node is left behind (hide or delete those). The parts the user asked for stay in the scene as nodes of their own.`,
};
