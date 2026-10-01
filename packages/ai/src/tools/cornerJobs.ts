// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, ParameterValue, Result } from "@spicy3d/core";
import type { EdgeRef, ParametricBodyNode } from "@spicy3d/parametric";
import type { Tool } from "../llm/types";
import type { ProgramProgress } from "./capabilityEngine";
import type { ProgramJobs } from "./programJobs";
import { holdDocumentReadSnapshot } from "./readTools";

type CornerRequest = {
    bodyId: string;
    featureId: string;
    distances: [ParameterValue, ParameterValue, ParameterValue];
    expectedEdgeRefs?: [EdgeRef, EdgeRef, EdgeRef];
};
type ApplyCorner = (
    body: ParametricBodyNode,
    featureId: string,
    corners: { edges: [EdgeRef, EdgeRef, EdgeRef]; distances: CornerRequest["distances"] }[],
    options?: { signal?: AbortSignal; label?: string },
) => Promise<Result<void>>;

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function vector(value: unknown): boolean {
    return (
        record(value) &&
        [value["x"], value["y"], value["z"]].every(
            (component) => typeof component === "number" && Number.isFinite(component),
        )
    );
}
function edgeReference(value: unknown): value is EdgeRef {
    if (
        !record(value) ||
        typeof value["edgeId"] !== "string" ||
        !value["edgeId"] ||
        value["edgeId"].length > 4096 ||
        (value["splitPiece"] !== undefined && typeof value["splitPiece"] !== "boolean")
    )
        return false;
    if (value["kind"] === "line") return vector(value["start"]) && vector(value["end"]);
    if (value["kind"] === "circle")
        return (
            vector(value["center"]) &&
            vector(value["axis"]) &&
            typeof value["radius"] === "number" &&
            Number.isFinite(value["radius"]) &&
            value["radius"] > 0
        );
    return (
        value["kind"] === "other" &&
        vector(value["mid"]) &&
        typeof value["length"] === "number" &&
        Number.isFinite(value["length"]) &&
        value["length"] > 0
    );
}
export function cornerJobRequest(args: Record<string, unknown>): CornerRequest {
    const { bodyId, featureId, distances, expectedEdgeRefs } = args;
    if (typeof bodyId !== "string" || !bodyId || typeof featureId !== "string" || !featureId)
        throw new Error("Corner job requires bodyId and featureId");
    if (
        !Array.isArray(distances) ||
        distances.length !== 3 ||
        distances.some((value) =>
            typeof value === "number"
                ? !Number.isFinite(value) || value <= 0
                : typeof value !== "string" || !value.trim(),
        )
    )
        throw new Error("Corner job requires three positive finite lengths or nonempty length expressions");
    if (
        expectedEdgeRefs !== undefined &&
        (!Array.isArray(expectedEdgeRefs) ||
            expectedEdgeRefs.length !== 3 ||
            expectedEdgeRefs.some((value) => !edgeReference(value)))
    )
        throw new Error(
            "expectedEdgeRefs requires three persistent edge references in the fillet's selected order",
        );
    return structuredClone({
        bodyId,
        featureId,
        distances,
        ...(expectedEdgeRefs === undefined ? {} : { expectedEdgeRefs }),
    }) as CornerRequest;
}

/** The manager supplies the queued caller's captured document; no active-document lookup after awaits. */
export async function executeCornerJob(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    progress: ((value: ProgramProgress) => void) | undefined,
    document: IDocument,
): Promise<string> {
    if (signal?.aborted) throw new Error("Corner job cancelled before preparation");
    const ops = args["ops"];
    if (!Array.isArray(ops) || ops.length !== 1 || !record(ops[0]))
        throw new Error("Corner job requires one edit");
    const request = cornerJobRequest(ops[0]);
    const parametric = await import("@spicy3d/parametric");
    if (signal?.aborted) throw new Error("Corner job cancelled before preparation");
    const node = document.modelManager.findNode((candidate) => candidate.id === request.bodyId);
    if (!(node instanceof parametric.ParametricBodyNode))
        throw new Error("Corner job body is missing from its captured document");
    const feature = node.features.find((candidate) => candidate.id === request.featureId);
    if (feature?.type !== "fillet" || feature.edges.length !== 3)
        throw new Error("Corner job requires an existing fillet with exactly three selected edges");
    if (
        request.expectedEdgeRefs?.some(
            (reference, index) =>
                reference.edgeId !== feature.edges[index].edgeId ||
                reference.splitPiece !== feature.edges[index].splitPiece,
        )
    )
        throw new Error("The fillet edge selection changed before this job started; no edits were made");
    const apply = (parametric as typeof parametric & { applyCornerSetbackEdit?: ApplyCorner })
        .applyCornerSetbackEdit;
    if (!apply) throw new Error("Cancelable corner edits require a newer parametric runtime");
    progress?.({ completed: 0, total: 1, method: "cornerSetback" });
    const edges = structuredClone(feature.edges) as [EdgeRef, EdgeRef, EdgeRef];
    const releaseSnapshot = holdDocumentReadSnapshot(document);
    try {
        const result = await apply(node, feature.id, [{ edges, distances: request.distances }], {
            signal,
            label: "MCP corner setback",
        });
        if (!result.isOk) throw new Error(result.error);
    } finally {
        releaseSnapshot();
    }
    progress?.({ completed: 1, total: 1 });
    return JSON.stringify({ documentId: document.id, bodyId: node.id, featureId: feature.id, status: "ok" });
}

export function cornerJobDefinitions(jobs: Pick<ProgramJobs, "start" | "read" | "cancel">): Tool[] {
    const xyz = {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        required: ["x", "y", "z"],
        additionalProperties: false,
    };
    const edge = {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["line", "circle", "other"] },
            edgeId: { type: "string", maxLength: 4096 },
            splitPiece: { type: "boolean" },
            start: xyz,
            end: xyz,
            center: xyz,
            axis: xyz,
            mid: xyz,
            radius: { type: "number" },
            length: { type: "number" },
        },
        required: ["kind", "edgeId"],
        additionalProperties: false,
    };
    const id = {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
        additionalProperties: false,
    };
    return [
        {
            name: "start_corner_setback_job",
            description:
                "Queue a cancelable worker corner-setback edit on an existing three-edge fillet in this document. bodyId is the actual document node ID, not a run_parametric op alias. Distances are in the fillet's persisted selected-edge order, in mm or length expressions. Optional expectedEdgeRefs rejects a changed selection. Returns immediately; poll get_corner_setback_job. Uses the page mutation FIFO, captures this document/session and clones arguments. One successful edit is one undo step; failure/cancel preserves committed edits. Native work has a strict 180s deadline and no synchronous fallback. Job retention is ten minutes, maximum sixteen retained corner jobs/four active corner jobs per caller, separate from program-job caps (combined maximum 32 retained/8 active); a running corner job occupies the mutation FIFO for up to its 180s native deadline, result limit 1 MiB; queue-inclusive deadline defaults to 240s, maximum 600s.",
            parameters: {
                type: "object",
                properties: {
                    bodyId: { type: "string" },
                    featureId: { type: "string" },
                    distances: {
                        type: "array",
                        items: {
                            anyOf: [
                                { type: "number", exclusiveMinimum: 0 },
                                { type: "string", minLength: 1 },
                            ],
                        },
                        minItems: 3,
                        maxItems: 3,
                    },
                    expectedEdgeRefs: { type: "array", items: edge, minItems: 3, maxItems: 3 },
                    timeoutMs: { type: "number", minimum: 1, maximum: 600_000 },
                },
                required: ["bodyId", "featureId", "distances"],
                additionalProperties: false,
            },
            handler: async (args, _signal, context) =>
                JSON.stringify(
                    jobs.start(
                        {
                            ops: [cornerJobRequest(args)],
                            timeoutMs: args["timeoutMs"] ?? 240_000,
                        },
                        context,
                    ),
                ),
        },
        {
            name: "get_corner_setback_job",
            description:
                "Read this session's corner job state and completed-operation progress without waiting for geometry or the mutation FIFO. Completed jobs include captured document/body/feature IDs. No native reads.",
            parameters: id,
            handler: async (args, _signal, context) => JSON.stringify(jobs.read(args, context)),
        },
        {
            name: "cancel_corner_setback_job",
            description:
                "Cancel this session's queued or running corner job without waiting for the mutation FIFO. Running jobs stay cancelling until strict worker termination and rollback finish. Completed edits remain completed.",
            parameters: id,
            handler: async (args, _signal, context) => JSON.stringify(jobs.cancel(args, context)),
        },
    ];
}
