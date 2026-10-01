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

shape.checkSelfIntersection runs in an isolated bounded worker through run_program. It returns true when no self-intersection is found, false when detected, or an error on timeout/cancellation/unavailable binding. Its deadline is at most 30 s (shorter with a lower slow-op budget); no synchronous fallback. For live status and cancellation use start_program_job with the same ops, get_program_job, and cancel_program_job. Metadata calls remain responsive; queued geometry mutations resume after completion or rollback. Simplify free-form skins before retrying a timeout.

run_program also pre-checks inspectionCommonVolume (both inputs) and inspectionSectionCaps using that worker and deadline. An unknown result (timeout/cancellation/worker failure) skips the inspection; self-intersection gives the inspection unavailable-result error. Skipping the explicit query cannot bypass this guard. It duplicates analyzer work: after a quick worker pass, the same geometry should also analyze quickly in the synchronous inspection, but booleans, mass calculations, topology checks, and replica capture can still block; the inspection itself has no hard deadline. Missing bindings and inputs with >=200 faces skip the pre-check (the kernel bounded inspection analyzer already skips those inputs). Common volume skips all pre-checks when either input fails checkShape, letting the binding return its invalid-input error. inspectionMass does not use the self-intersection analyzer and does not pre-check; it only runs topology validity and mass calculations. Unrelated queries do not pre-check.`,
};
