// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type IEdge, type IFace, Matrix4, ShapeTypes, XYZ } from "@spicy3d/core";
import { createTestFactory, unwrapOk } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { captureProfileRef } from "../src/features/profileRef";
import { buildProjectionResult } from "../src/features/projectionResult";

const factory = createTestFactory();
beforeAll(() => {
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});

function inputs(radius = 10, halfWidth = 2) {
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, radius, 20));
    const face = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
        (candidate) => !candidate.surface().isPlanar(),
    );
    expect(face).not.toBeUndefined();
    if (!face) throw new Error("Cylinder wall missing");
    const line = unwrapOk(
        factory.line(new XYZ({ x: 0, y: -halfWidth, z: 10 }), new XYZ({ x: 0, y: halfWidth, z: 10 })),
    );
    return {
        source: [{ edges: [line], seed: "sketch:source:path:ent42", stable: true }],
        target: {
            face,
            seed: "cylinder:wall:ent7",
            stableIdentity: true,
            anchor: captureProfileRef(face),
            dispose() {},
        },
        dispose() {
            line.dispose();
            cylinder.dispose();
        },
    };
}

test("projected output IDs retain actual source and target ancestry across geometry edits", () => {
    let previous: string[] | undefined;
    for (const [radius, span] of [
        [10, 2],
        [12, 3],
    ]) {
        const scene = inputs(radius, span);
        try {
            const projected = buildProjectionResult(
                "project",
                "source",
                scene.source,
                "target",
                scene.target,
                XYZ.unitX,
                Matrix4.identity(),
            );
            if (!projected.isOk) throw new Error(projected.error);
            try {
                expect(projected.value.edgeIds.length).toBeGreaterThan(0);
                if (previous !== undefined) expect(projected.value.edgeIds).toEqual(previous);
                previous = projected.value.edgeIds;
                const length = projected.value.shape
                    .findSubShapes(ShapeTypes.edge)
                    .reduce((sum, edge) => sum + (edge as IEdge).length(), 0);
                expect(length).toBeCloseTo(2 * radius * Math.asin(span / radius), 5);
            } finally {
                projected.value.shape.dispose();
            }
        } finally {
            scene.dispose();
        }
    }
});

test("fixed world direction is converted into rotated host coordinates", () => {
    const scene = inputs();
    const host = Matrix4.fromAxisRad(XYZ.zero, XYZ.unitZ, Math.PI / 2);
    try {
        const projected = buildProjectionResult(
            "project",
            "source",
            scene.source,
            "target",
            scene.target,
            XYZ.unitY,
            host,
        );
        if (!projected.isOk) throw new Error(projected.error);
        try {
            for (const edge of projected.value.shape.findSubShapes(ShapeTypes.edge) as IEdge[]) {
                const local = edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
                const world = host.ofPoint(local);
                expect(world.y).toBeGreaterThan(9);
                expect(world.x).toBeCloseTo(-local.y, 5);
                expect(world.x * world.x + world.y * world.y).toBeCloseTo(100, 5);
            }
        } finally {
            projected.value.shape.dispose();
        }
    } finally {
        scene.dispose();
    }
});

test.each(["source", "target"])("projection rejects untracked %s provenance explicitly", (kind) => {
    const scene = inputs();
    try {
        const result = buildProjectionResult(
            "project",
            "source",
            scene.source.map((span) => ({ ...span, stable: kind !== "source" })),
            "target",
            { ...scene.target, stableIdentity: kind !== "target" },
            XYZ.unitX,
            Matrix4.identity(),
        );
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("tracked source edges and a tracked target face");
    } finally {
        scene.dispose();
    }
});
