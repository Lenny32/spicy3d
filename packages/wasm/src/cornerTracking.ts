// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CORNER_SETBACK_ANGLE_TOLERANCE, CORNER_SETBACK_DISTANCE_TOLERANCE } from "@spicy3d/core";
import type { CornerReplica, ReplicaTopology } from "./workerProtocol";

/** Reject malformed worker construction history before importing an output into the main heap. */
export function validateCornerReplica(result: CornerReplica, input: ReplicaTopology): string | undefined {
    if (!result.topology || !Array.isArray(result.topology.faces) || !Array.isArray(result.topology.edges))
        return "Corner worker output topology is missing";
    const { tracking, cornerFaces } = result;
    const faceCount = result.topology.faces.length;
    const edgeCount = result.topology.edges.length;
    const map = (values: unknown, count: number, inputs: number): boolean =>
        values instanceof Int32Array &&
        values.length === count &&
        values.every((value) => value >= -1 && value < inputs);
    const pairs = (values: unknown, count: number, inputs: number): boolean =>
        values instanceof Int32Array &&
        values.length % 2 === 0 &&
        values.every((value, index) => value >= 0 && value < (index % 2 === 0 ? count : inputs));
    if (
        !tracking ||
        !map(tracking.faceMap, faceCount, input.faces.length) ||
        !map(tracking.edgeMap, edgeCount, input.edges.length) ||
        !map(tracking.faceEdgeMap, faceCount, input.edges.length) ||
        !pairs(tracking.faceAncestors, faceCount, input.faces.length) ||
        !pairs(tracking.edgeAncestors, edgeCount, input.edges.length) ||
        !(cornerFaces instanceof Int32Array) ||
        cornerFaces.length !== 1 ||
        cornerFaces[0] < 0 ||
        cornerFaces[0] >= faceCount
    )
        return "Corner worker construction history is invalid";
    const supportAncestors = new Set<number>();
    for (let i = 0; i < tracking.faceAncestors.length; i += 2)
        if (tracking.faceAncestors[i] === cornerFaces[0]) supportAncestors.add(tracking.faceAncestors[i + 1]);
    if (supportAncestors.size !== 3) return "Corner worker support ancestry is incomplete or ambiguous";
    if (
        !Number.isFinite(result.g0Error) ||
        result.g0Error < 0 ||
        result.g0Error > CORNER_SETBACK_DISTANCE_TOLERANCE ||
        !Number.isFinite(result.g1Error) ||
        result.g1Error < 0 ||
        result.g1Error > CORNER_SETBACK_ANGLE_TOLERANCE ||
        !Number.isFinite(result.fitDistanceError) ||
        result.fitDistanceError < 0 ||
        result.fitDistanceError > CORNER_SETBACK_DISTANCE_TOLERANCE ||
        !Number.isFinite(result.fitAngleError) ||
        result.fitAngleError < 0 ||
        result.fitAngleError > CORNER_SETBACK_ANGLE_TOLERANCE
    )
        return "Corner worker output violates continuity limits";
    return undefined;
}
