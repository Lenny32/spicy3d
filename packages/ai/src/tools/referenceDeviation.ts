// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { MeshNode, measureNodeDeviation, VisualNode } from "@spicy3d/core";
import type { Tool } from "../llm/types";

export function buildReferenceDeviationTool(): Tool {
    return {
        name: "measure_reference_deviation",
        description:
            "Measure unsigned model-to-reference STL mesh deviation in millimetres. Uses deterministic area-weighted samples on the current model tessellation and exact nearest reference triangles (all triangles, not nearest vertices). Returns meanDeviation, rmsDeviation, maxSampledDeviation, sampleCount, worst sample points and accuracy notes. This is a sampled one-way comparison, not an exact CAD-surface measurement or Hausdorff distance. Winding/normals do not affect distance; nodes include their parent transforms. Does not edit or save documents.",
        parameters: {
            type: "object",
            properties: {
                modelId: { type: "string", description: "CAD body or triangle MeshNode id" },
                referenceId: {
                    type: "string",
                    description: "Reference triangle MeshNode id from import_reference_mesh",
                },
                sampleCount: {
                    type: "integer",
                    minimum: 1,
                    maximum: 65536,
                    description: "Area-weighted samples, default 4096",
                },
                timeBudgetMs: {
                    type: "number",
                    minimum: 1,
                    maximum: 60000,
                    description: "Mesh processing budget, default 15000; excludes CAD rebuild/tessellation",
                },
            },
            required: ["modelId", "referenceId"],
        },
        handler: async (args, signal) => {
            const document = globalThis.app.activeView?.document;
            const fail = (error: string) => JSON.stringify({ error });
            if (!document) return fail("No active document");
            if (typeof args["modelId"] !== "string" || typeof args["referenceId"] !== "string")
                return fail("modelId and referenceId must be node ids");
            const samples = args["sampleCount"];
            if (
                samples !== undefined &&
                (typeof samples !== "number" || !Number.isInteger(samples) || samples < 1 || samples > 65536)
            )
                return fail("sampleCount must be an integer from 1 to 65536");
            const budget = args["timeBudgetMs"];
            if (
                budget !== undefined &&
                (typeof budget !== "number" || !Number.isFinite(budget) || budget < 1 || budget > 60000)
            )
                return fail("timeBudgetMs must be from 1 to 60000");
            const model = document.modelManager.findNode((node) => node.id === args["modelId"]);
            const reference = document.modelManager.findNode((node) => node.id === args["referenceId"]);
            if (!(model instanceof VisualNode)) return fail("Model node not found");
            if (!(reference instanceof MeshNode)) return fail("Reference must be a MeshNode");
            const result = await measureNodeDeviation(model, reference, {
                sampleCount: args["sampleCount"] as number | undefined,
                timeBudgetMs: args["timeBudgetMs"] as number | undefined,
                signal,
            });
            return result.isOk
                ? JSON.stringify({ ...result.value, modelId: model.id, referenceId: reference.id })
                : fail(result.error);
        },
    };
}
