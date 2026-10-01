// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CurveUtils,
    type IDisposable,
    type IEdge,
    type IShape,
    ShapeTypes,
    type TrackedShape,
    XYZ,
} from "@spicy3d/core";
import { createBox, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
function edges(shape: IShape): IEdge[] {
    const result = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    owned.push(...result);
    return result;
}
afterEach(() => {
    const values = owned;
    owned = [];
    for (const value of values.reverse()) value.dispose();
});

describe("native variable-radius fillets", () => {
    test.each([
        ["filletVariableRadius", "forward", 40],
        ["filletVariableRadius", "reversed", 40],
        ["filletVariableRadiusTracked", "forward", 40],
        ["filletVariableRadiusTracked", "reversed", 40],
        ["filletVariableRadius", "forward", -40],
        ["filletVariableRadius", "reversed", -40],
        ["filletVariableRadiusTracked", "forward", -40],
        ["filletVariableRadiusTracked", "reversed", -40],
    ] as const)("%s maps a %s edge on a %i-deep prism to its current natural curve direction", (operation, orientation, depth) => {
        const box = keep(createBox(factory, 30, 30, depth));
        const originalEdges = edges(box);
        const index = originalEdges.findIndex(
            (edge) =>
                Math.abs(edge.endPoint().z - edge.startPoint().z) > 39 && edge.orientation() === orientation,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        const selected = originalEdges[index];
        const startZ = selected.pointAt(selected.firstParameter()).z;
        const endZ = selected.pointAt(selected.lastParameter()).z;
        const result = unwrapOk<IShape | TrackedShape>(
            factory[operation](
                box,
                [index],
                [
                    { position: 0, radius: 1 },
                    { position: 1, radius: 4 },
                ],
            ),
        );
        const rounded = keep("faceMap" in result ? result.shape : result);
        expect(rounded.checkShape()).toBe(true);
        expect(rounded.volume()).toBeLessThan(36000);
        expect(box.checkShape()).toBe(true);
        expect(box.volume()).toBeCloseTo(36000, 6);
        const endRadii = edges(rounded).flatMap((edge) => {
            const curve = keep(edge.curve);
            const parameter = (curve.firstParameter() + curve.lastParameter()) / 2;
            const middle = curve.value(parameter);
            const start = curve.value(curve.firstParameter());
            const end = curve.value(curve.lastParameter());
            if (Math.abs(start.z - middle.z) > 1e-5 || Math.abs(end.z - middle.z) > 1e-5) return [];
            const derivative = curve.d2(parameter);
            const cross = derivative.vec1.cross(derivative.vec2).length();
            return cross > 1e-8 ? [{ z: middle.z, radius: derivative.vec1.length() ** 3 / cross }] : [];
        });
        const first = endRadii.find((circle) => Math.abs(circle.z - startZ) < 1e-5);
        const last = endRadii.find((circle) => Math.abs(circle.z - endZ) < 1e-5);
        expect(first).not.toBeUndefined();
        expect(last).not.toBeUndefined();
        expect(first!.radius).toBeCloseTo(1, 3);
        expect(last!.radius).toBeCloseTo(4, 3);
    });

    test("tracked variable fillets report both single and multiple ancestor history channels", () => {
        const box = keep(createBox(factory, 30, 30, 40));
        const result = unwrapOk(
            factory.filletVariableRadiusTracked(
                box,
                [0],
                [
                    { position: 0, radius: 1 },
                    { position: 1, radius: 3 },
                ],
            ),
        );
        keep(result.shape);
        expect(result.shape.checkShape()).toBe(true);
        expect(result.edgeMap.length).toBeGreaterThan(0);
        expect(result.faceMap.length).toBeGreaterThan(0);
        expect(result.edgeAncestors?.length).toBeGreaterThan(0);
        expect(result.faceAncestors?.length).toBeGreaterThan(0);
    });

    test("closed contours reject inconsistent endpoint radii and accept a periodic smooth law", () => {
        const cylinder = keep(unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 20, 30)));
        const originalEdges = edges(cylinder);
        const index = originalEdges.findIndex((edge) => {
            const curve = keep(edge.curve);
            const basis = keep(curve.basisCurve);
            return CurveUtils.isCircle(basis) && Math.abs(basis.center.z - 30) < 1e-5;
        });
        expect(index).toBeGreaterThanOrEqual(0);
        const invalid = factory.filletVariableRadius(
            cylinder,
            [index],
            [
                { position: 0, radius: 1 },
                { position: 1, radius: 2 },
            ],
        );
        expect(invalid.isOk).toBe(false);
        expect(invalid.error).toContain("closed fillet contour requires equal");
        const rounded = keep(
            unwrapOk(
                factory.filletVariableRadius(
                    cylinder,
                    [index],
                    [
                        { position: 0, radius: 1 },
                        { position: 0.5, radius: 2 },
                        { position: 1, radius: 1 },
                    ],
                ),
            ),
        );
        expect(rounded.checkShape()).toBe(true);
        expect(rounded.volume()).toBeLessThan(cylinder.volume());
    });

    test("failed large laws leave the original shape usable for another fillet", () => {
        const box = keep(createBox(factory, 10, 10, 10));
        const invalid = factory.filletVariableRadius(
            box,
            [0],
            [
                { position: 0, radius: 100 },
                { position: 1, radius: 200 },
            ],
        );
        expect(invalid.isOk).toBe(false);
        expect(invalid.error).toContain("OCCT build failed");
        expect(box.checkShape()).toBe(true);
        const constant = keep(unwrapOk(factory.fillet(box, [0], 1)));
        expect(constant.checkShape()).toBe(true);
        expect(box.volume()).toBeCloseTo(1000, 6);
    });

    test("tangent-connected edge picks reject competing laws and a single pick propagates along the contour", () => {
        const points = [
            [0, 0],
            [15, 0],
            [30, 0],
            [30, 30],
            [0, 30],
        ];
        const profileEdges = points.map((point, index) => {
            const next = points[(index + 1) % points.length];
            return keep(
                unwrapOk(
                    factory.line(
                        new XYZ({ x: point[0], y: point[1], z: 0 }),
                        new XYZ({ x: next[0], y: next[1], z: 0 }),
                    ),
                ),
            );
        });
        const wire = keep(unwrapOk(factory.wire(profileEdges)));
        const face = keep(unwrapOk(factory.face([wire])));
        const block = keep(unwrapOk(factory.prism(face, XYZ.unitZ.multiply(40))));
        const originalEdges = edges(block);
        const indexes = originalEdges.flatMap((edge, index) => {
            const start = edge.startPoint();
            const end = edge.endPoint();
            return Math.abs(start.y) < 1e-6 &&
                Math.abs(end.y) < 1e-6 &&
                Math.abs(start.z) < 1e-6 &&
                Math.abs(end.z) < 1e-6
                ? [index]
                : [];
        });
        expect(indexes).toHaveLength(2);
        const law = [
            { position: 0, radius: 1 },
            { position: 1, radius: 2 },
        ];
        const rejected = factory.filletVariableRadius(block, indexes, law);
        expect(rejected.isOk).toBe(false);
        expect(rejected.error).toContain("one selected edge per tangent contour");
        const rounded = keep(unwrapOk(factory.filletVariableRadius(block, [indexes[0]], law)));
        expect(rounded.checkShape()).toBe(true);
        expect(rounded.volume()).toBeLessThan(block.volume());
    });
});
