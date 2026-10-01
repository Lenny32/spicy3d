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

shape.checkSelfIntersection runs in an isolated bounded worker through run_program. It returns true when no self-intersection is found, false when detected, or an error on timeout/cancellation/unavailable binding. Its deadline is at most 30 s (shorter with a lower slow-op budget); no synchronous fallback. For live status and cancellation use start_program_job with the same ops, get_program_job, and cancel_program_job. Metadata calls remain responsive; queued geometry mutations resume after completion or rollback. Simplify free-form skins before retrying a timeout.`,
};
