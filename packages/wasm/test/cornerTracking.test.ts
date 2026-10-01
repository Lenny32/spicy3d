// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { validateCornerReplica } from "../src/cornerTracking";
import type { CornerReplica, ReplicaTopology } from "../src/workerProtocol";

const input: ReplicaTopology = { graph: "input", faces: ["a", "b", "c"], edges: ["x", "y", "z"] };
function validReply(): CornerReplica {
    return {
        brep: "output",
        topology: { graph: "output", faces: ["corner"], edges: ["section"] },
        tracking: {
            faceMap: new Int32Array([0]),
            edgeMap: new Int32Array([0]),
            faceEdgeMap: new Int32Array([0]),
            faceAncestors: new Int32Array([0, 0, 0, 1, 0, 2]),
            edgeAncestors: new Int32Array([0, 0]),
            capFaces: new Int32Array(),
        },
        cornerFaces: new Int32Array([0]),
        g0Error: 1e-4,
        g1Error: 1e-3,
        fitDistanceError: 1e-4,
        fitAngleError: 1e-3,
    };
}

test("accepts bounded CAD joins and reported fit metrics with complete corner support ancestry", () => {
    expect(validateCornerReplica(validReply(), input)).toBeUndefined();
});

test.each([
    "g0Error",
    "g1Error",
    "fitDistanceError",
    "fitAngleError",
] as const)("rejects invalid %s independently of the other continuity metrics", (key) => {
    for (const value of [NaN, Infinity, -Infinity, -1, 1]) {
        const reply = validReply();
        reply[key] = value;
        expect(validateCornerReplica(reply, input)).toBe("Corner worker output violates continuity limits");
    }
});

test.each([
    new Int32Array([0, 0, 0, 1]),
    new Int32Array([0, 0, 0, 1, 0, 1]),
])("rejects missing or duplicate-only support ancestry %j", (ancestors) => {
    const reply = validReply();
    reply.tracking.faceAncestors = ancestors;
    expect(validateCornerReplica(reply, input)).toBe(
        "Corner worker support ancestry is incomplete or ambiguous",
    );
});

test.each([
    new Int32Array([0, 0, 0, 1, 0, 3]),
    new Int32Array([1, 0, 0, 1, 0, 2]),
    new Int32Array([0, 0, 0, 1, 0]),
])("rejects out-of-range or incomplete history pairs %j", (ancestors) => {
    const reply = validReply();
    reply.tracking.faceAncestors = ancestors;
    expect(validateCornerReplica(reply, input)).toBe("Corner worker construction history is invalid");
});

test.each([
    new Int32Array(),
    new Int32Array([0, 0]),
    new Int32Array([-1]),
    new Int32Array([1]),
])("rejects missing, duplicated or invalid corner role indexes %j", (indexes) => {
    const reply = validReply();
    reply.cornerFaces = indexes;
    expect(validateCornerReplica(reply, input)).toBe("Corner worker construction history is invalid");
});
