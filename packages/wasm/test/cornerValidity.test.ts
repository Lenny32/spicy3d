// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDisposable,
    type IEdge,
    type IFace,
    type IShape,
    Plane,
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
afterEach(() => {
    const values = owned;
    owned = [];
    for (const value of values.reverse()) value.dispose();
});

function freeFormPrism(): IShape {
    const curved = keep(
        unwrapOk(
            factory.bezier([new XYZ(0, 0, 0), new XYZ(8, -5, 0), new XYZ(22, -5, 0), new XYZ(30, 0, 0)]),
        ),
    );
    const rest = [new XYZ(30, 0, 0), new XYZ(30, 20, 0), new XYZ(0, 20, 0), new XYZ(0, 0, 0)];
    const lines = rest.slice(0, -1).map((point, i) => keep(unwrapOk(factory.line(point, rest[i + 1]))));
    const wire = keep(unwrapOk(factory.wire([curved, ...lines])));
    const face = keep(unwrapOk(factory.face([wire])));
    const prism = keep(unwrapOk(factory.prism(face, new XYZ(0, 0, 10))));
    expect(prism.checkShape()).toBe(true);
    return prism;
}

const corners = ["fillet", "chamfer", "filletTracked", "chamferTracked"] as const;

describe("corner result validity", () => {
    test.each(corners)("%s preserves a valid free-form perimeter for a later boolean", (operation) => {
        const prism = freeFormPrism();
        const edges = prism.findSubShapes(ShapeTypes.edge) as IEdge[];
        owned.push(...edges);
        // The Bezier boundary on the upper cap (rather than a box or a vertical corner).
        const perimeter = edges.findIndex((edge) => {
            const curve = keep(edge.curve);
            const mid = curve.value((curve.firstParameter() + curve.lastParameter()) / 2);
            return Math.abs(mid.z - 10) < 1e-7 && mid.y < -1;
        });
        expect(perimeter).toBeGreaterThanOrEqual(0);
        const result = unwrapOk<IShape | TrackedShape>(factory[operation](prism, [perimeter], 0.5));
        const rounded = keep("faceMap" in result ? result.shape : result);
        expect(rounded.checkShape()).toBe(true);
        expect(rounded.volume()).toBeLessThan(prism.volume());
        const tool = keep(
            unwrapOk(
                factory.box(
                    new Plane({ origin: new XYZ(12, 5, -1), normal: XYZ.unitZ, xvec: XYZ.unitX }),
                    6,
                    6,
                    12,
                ),
            ),
        );
        const cut = keep(unwrapOk(factory.booleanCut([rounded], [tool])));
        expect(cut.checkShape()).toBe(true);
        const solids = cut.findSubShapes(ShapeTypes.solid);
        owned.push(...solids);
        expect(solids).toHaveLength(1);
        expect(rounded.volume() - cut.volume()).toBeCloseTo(360, 5);
    });

    test.each(
        corners,
    )("%s preserves legacy corner results on already-invalid imported geometry", (operation) => {
        const box = keep(createBox(factory));
        const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
        owned.push(...faces);
        const shell = keep(unwrapOk(factory.shell(faces.slice(0, 5))));
        // OCCT completes this corner operation despite leaving the open solid invalid.
        const invalid = keep(unwrapOk(factory.solid([shell])));
        expect(invalid.checkShape()).toBe(false);
        const result = factory[operation](invalid, [0], 0.5);
        expect(result.isOk).toBe(true);
        const value = keep("faceMap" in result.value ? result.value.shape : result.value);
        expect(value.checkShape()).toBe(false);
    });
});
