// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type IEdge, type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createTestFactory, unwrapOk } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { projectForwardCurve, projectionCurveId } from "../src/features/projectedCurves";
import { idsOverlap } from "../src/features/trackedId";

const factory = createTestFactory();
beforeAll(() => {
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});

test("existing projection and exact swept-sheet intersection isolate a forward cylinder branch", () => {
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
    const target = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
        (face) => !face.surface().isPlanar(),
    );
    expect(target).not.toBeUndefined();
    if (target === undefined) throw new Error("Expected curved target");
    const source = unwrapOk(factory.line(new XYZ({ x: 0, y: -2, z: 10 }), new XYZ({ x: 0, y: 2, z: 10 })));
    const projected = unwrapOk(factory.curveProjection(source, target, XYZ.unitX));
    const sheet = unwrapOk(factory.prism(source, new XYZ({ x: 30, y: 0, z: 0 })));
    const forward = unwrapOk(factory.booleanCommon([projected], [sheet]));
    try {
        const edges = forward.findSubShapes(ShapeTypes.edge) as IEdge[];
        expect(edges.length).toBeGreaterThan(0);
        for (const edge of edges)
            for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
                const point = edge.pointAt(
                    edge.firstParameter() + (edge.lastParameter() - edge.firstParameter()) * fraction,
                );
                expect(point.x).toBeGreaterThan(0);
                expect(point.x * point.x + point.y * point.y).toBeCloseTo(100, 5);
                expect(point.z).toBeCloseTo(10, 6);
            }
        const onTarget = unwrapOk(factory.booleanCommon([forward], [target]));
        try {
            expect(
                onTarget
                    .findSubShapes(ShapeTypes.edge)
                    .reduce((sum, edge) => sum + (edge as IEdge).length(), 0),
            ).toBeCloseTo(
                edges.reduce((sum, edge) => sum + edge.length(), 0),
                5,
            );
        } finally {
            onTarget.dispose();
        }
    } finally {
        source.dispose();
        cylinder.dispose();
        projected.dispose();
        sheet.dispose();
        forward.dispose();
    }
});

test("existing projection retains distinct front and back branches when both are forward", () => {
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
    const target = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
        (face) => !face.surface().isPlanar(),
    );
    expect(target).not.toBeUndefined();
    if (target === undefined) throw new Error("Expected curved target");
    const source = unwrapOk(factory.line(new XYZ({ x: 15, y: -2, z: 10 }), new XYZ({ x: 15, y: 2, z: 10 })));
    const projected = unwrapOk(factory.curveProjection(source, target, XYZ.unitNX));
    const sheet = unwrapOk(factory.prism(source, new XYZ({ x: -30, y: 0, z: 0 })));
    const forward = unwrapOk(factory.booleanCommon([projected], [sheet]));
    try {
        const edges = forward.findSubShapes(ShapeTypes.edge) as IEdge[];
        const midpoints = edges.map(
            (edge) => edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2).x,
        );
        expect(midpoints.some((x) => x > 0)).toBe(true);
        expect(midpoints.some((x) => x < 0)).toBe(true);
    } finally {
        source.dispose();
        cylinder.dispose();
        projected.dispose();
        sheet.dispose();
        forward.dispose();
    }
});

test("forward projection helper proves full curved coverage and rejects both forward branches", () => {
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
    const target = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
        (face) => !face.surface().isPlanar(),
    );
    expect(target).not.toBeUndefined();
    if (target === undefined) throw new Error("Expected curved target");
    const inside = unwrapOk(factory.line(new XYZ({ x: 0, y: -2, z: 10 }), new XYZ({ x: 0, y: 2, z: 10 })));
    const outside = unwrapOk(factory.line(new XYZ({ x: 15, y: -2, z: 10 }), new XYZ({ x: 15, y: 2, z: 10 })));
    try {
        const result = projectForwardCurve(inside, target, XYZ.unitX);
        expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
        expect(
            (result.value.findSubShapes(ShapeTypes.edge) as IEdge[]).reduce(
                (sum, edge) => sum + edge.length(),
                0,
            ),
        ).toBeCloseTo(20 * Math.asin(0.2), 5);
        result.value.dispose();
        const ambiguous = projectForwardCurve(outside, target, XYZ.unitNX);
        expect(ambiguous.isOk).toBe(false);
        expect(ambiguous.error).toContain("ambiguous");
    } finally {
        cylinder.dispose();
        inside.dispose();
        outside.dispose();
    }
});

test.each(["behind", "disjoint", "partial"])("forward projection helper rejects %s targets", (kind) => {
    const source = unwrapOk(factory.line(new XYZ({ x: 0, y: 0, z: 0 }), new XYZ({ x: 4, y: 0, z: 0 })));
    const target = unwrapOk(
        factory.rect(
            new Plane({
                origin: new XYZ({ x: -1, y: kind === "disjoint" ? 10 : -1, z: kind === "behind" ? -10 : 10 }),
                normal: XYZ.unitZ,
                xvec: XYZ.unitX,
            }),
            kind === "partial" ? 3 : 6,
            3,
        ),
    );
    try {
        const result = projectForwardCurve(source, target, XYZ.unitZ);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(
            kind === "partial"
                ? /complete source/
                : kind === "disjoint"
                  ? /disjoint/
                  : /forward intersection/,
        );
    } finally {
        source.dispose();
        target.dispose();
    }
});

test("forward projection responds to source span and target radius edits with exact arc lengths", () => {
    for (const [span, radius] of [
        [2, 10],
        [3, 10],
        [3, 12],
    ]) {
        const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, radius, 20));
        const target = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (face) => !face.surface().isPlanar(),
        );
        expect(target).not.toBeUndefined();
        if (target === undefined) throw new Error("Expected curved target");
        const source = unwrapOk(
            factory.line(new XYZ({ x: 0, y: -span, z: 10 }), new XYZ({ x: 0, y: span, z: 10 })),
        );
        try {
            const result = projectForwardCurve(source, target, XYZ.unitX);
            expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
            try {
                expect(
                    (result.value.findSubShapes(ShapeTypes.edge) as IEdge[]).reduce(
                        (sum, edge) => sum + edge.length(),
                        0,
                    ),
                ).toBeCloseTo(2 * radius * Math.asin(span / radius), 5);
            } finally {
                result.value.dispose();
            }
        } finally {
            source.dispose();
            cylinder.dispose();
        }
    }
});

test("full projection coverage detects a trimmed target's interior gap despite valid endpoints", () => {
    const source = unwrapOk(factory.line(new XYZ({ x: 0, y: 0, z: 0 }), new XYZ({ x: 4, y: 0, z: 0 })));
    const outer = unwrapOk(
        factory.rect(
            new Plane({ origin: new XYZ({ x: -1, y: -1, z: 10 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            6,
            3,
        ),
    );
    const hole = unwrapOk(
        factory.rect(
            new Plane({ origin: new XYZ({ x: 1.5, y: -0.5, z: 10 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            1,
            1,
        ),
    );
    const cut = unwrapOk(factory.booleanCut([outer], [hole]));
    const faces = cut.findSubShapes(ShapeTypes.face) as IFace[];
    expect(faces).toHaveLength(1);
    try {
        const raw = unwrapOk(factory.curveProjection(source, faces[0], XYZ.unitZ));
        try {
            const points = (raw.findSubShapes(ShapeTypes.edge) as IEdge[]).flatMap((edge) => [
                edge.startPoint(),
                edge.endPoint(),
            ]);
            expect(points.some((point) => Math.abs(point.x) < 1e-6)).toBe(true);
            expect(points.some((point) => Math.abs(point.x - 4) < 1e-6)).toBe(true);
        } finally {
            raw.dispose();
        }
        const result = projectForwardCurve(source, faces[0], XYZ.unitZ);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/complete source|disconnected/);
    } finally {
        source.dispose();
        outer.dispose();
        hole.dispose();
        cut.dispose();
    }
});

test("forward projection preserves a fixed oblique direction", () => {
    const source = unwrapOk(factory.line(new XYZ({ x: 0, y: -2, z: 0 }), new XYZ({ x: 0, y: 2, z: 0 })));
    const target = unwrapOk(
        factory.rect(
            new Plane({ origin: new XYZ({ x: 0, y: -3, z: 10 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            5,
            6,
        ),
    );
    try {
        const result = projectForwardCurve(source, target, new XYZ({ x: 0.2, y: 0, z: 1 }));
        expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
        try {
            for (const edge of result.value.findSubShapes(ShapeTypes.edge) as IEdge[]) {
                expect(edge.startPoint().x).toBeCloseTo(2, 5);
                expect(edge.endPoint().x).toBeCloseTo(2, 5);
                expect(edge.startPoint().z).toBeCloseTo(10, 5);
                expect(edge.endPoint().z).toBeCloseTo(10, 5);
            }
        } finally {
            result.value.dispose();
        }
    } finally {
        source.dispose();
        target.dispose();
    }
});

test.each([
    XYZ.zero,
    { x: NaN, y: 0, z: 1 },
    { x: 0, y: 0, z: Infinity },
])("projection rejects malformed direction %j", (direction) => {
    const source = unwrapOk(factory.line(XYZ.zero, XYZ.unitX));
    const target = unwrapOk(factory.rect(Plane.XY, 4, 4));
    try {
        const result = projectForwardCurve(source, target, direction);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/nonzero|finite/);
    } finally {
        source.dispose();
        target.dispose();
    }
});

test("projected logical curve IDs use source/target ancestry and retain split-merge overlap", () => {
    const original = projectionCurveId(
        "projection-feature",
        "source-node",
        "edge-a",
        "target-node",
        "face-a",
    );
    const merged = projectionCurveId(
        "projection-feature",
        "source-node",
        "edge-b|edge-a",
        "target-node",
        "face-b|face-a",
    );
    expect(idsOverlap(original, merged)).toBe(true);
    expect(
        projectionCurveId(
            "projection-feature",
            "source-node",
            "edge-a|edge-b",
            "target-node",
            "face-a|face-b",
        ),
    ).toBe(merged);
    expect(
        idsOverlap(
            original,
            projectionCurveId("projection-feature", "other-source", "edge-a", "target-node", "face-a"),
        ),
    ).toBe(false);
    expect(
        idsOverlap(
            original,
            projectionCurveId("projection-feature", "source-node", "edge-a", "other-target", "face-a"),
        ),
    ).toBe(false);
});
