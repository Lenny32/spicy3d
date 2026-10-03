// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { queryApiDoc } from "../tools/capabilities.generated";
import type { Skill } from "./types";

/** The query half of the generated catalog — see modelingApi for the creation half. */
export const shapeQuery: Skill = {
    name: "shape-query",
    description:
        "Query and measure shapes, curves and surfaces: length/area/volume, bounding boxes, distances, parameter evaluation, sub-shape refs",
    content: `${queryApiDoc}

shape.selfIntersectionDetails uses the same bounded worker and 30 s deadline. It returns an empty string for a clean shape, otherwise zero-based output face indices, the number of intersecting pairs and, for up to four pairs (crossing faces first), "intersect at xyz (mm)" = a point on the actual intersection curve plus its extent, or "overlap within their tolerances near xyz (mm) ..., gap g mm" for sub-shapes that only touch through widened tolerances. A pair that cannot be located keeps an "approximate faulty region center". Output faces do not identify input loft sections. An error means the check could not complete.

shape.checkSelfIntersection runs in an isolated bounded worker through run_program. It returns true when no self-intersection is found, false when detected, or an error on timeout/cancellation/unavailable binding. Its deadline is a fixed 30 s; no synchronous fallback. For live status and cancellation use start_program_job with the same ops, get_program_job, and cancel_program_job. Metadata calls remain responsive; queued geometry mutations resume after completion or rollback. Simplify free-form skins before retrying a timeout.

run_program also pre-checks inspectionCommonVolume (both inputs) and inspectionSectionCaps using that worker and deadline. An unknown result (timeout/cancellation/worker failure) skips the inspection; self-intersection gives the inspection unavailable-result error. Skipping the explicit query cannot bypass this guard. Validated input objects select feature-detected prechecked bindings that omit the repeated analyzer (older kernels repeat it), but booleans, mass calculations, topology checks, and replica capture can still block; the inspection itself has no hard deadline. Missing bindings and inputs with >=200 faces skip the pre-check (the kernel bounded inspection analyzer already skips those inputs). Common volume skips all pre-checks when either input fails checkShape, letting the binding return its invalid-input error. inspectionMass does not use the self-intersection analyzer and does not pre-check; it only runs topology validity and mass calculations. Unrelated queries do not pre-check.`,
};
