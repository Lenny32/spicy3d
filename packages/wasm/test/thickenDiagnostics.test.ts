// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IFace, type IShape, Matrix4, ShapeTypes, XYZ } from "@spicy3d/core";
import type { ShapeResult } from "../lib/spicy-wasm";
import { thickenFailureDiagnostic } from "../src/thickenDiagnostics";
import { createBox, createSphere, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
const ERROR = "Failed to create thick solid: BRepOffset_UnknownError";
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    rs.restoreAllMocks();
    for (const value of owned.reverse()) value.dispose();
    owned = [];
});

test("a sampled inward curvature limit names its face, location, radius and remedy", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const message = thickenFailureDiagnostic(ERROR, sphere, -3.75);
    expect(message).toContain(ERROR);
    expect(message).toContain("input face index 0 near (");
    expect(message).toContain("curvature radius 2 mm <= |thickness| 3.75 mm");
    expect(message).toContain("Try |thickness| below 2 mm or smooth this region");
    expect(message).toContain("not a guaranteed maximum");
    expect(sphere.checkShape()).toBe(true);
});

const SELF_INTERSECTION =
    "Thicken result intersects itself: Shape intersects itself; output face indices (zero-based): 0 1; 1 intersecting pair";

test("a self-intersecting wall over a sharper curvature than its thickness names the collapse", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const message = thickenFailureDiagnostic(SELF_INTERSECTION, sphere, -3.75);
    expect(message.startsWith(SELF_INTERSECTION)).toBe(true);
    expect(message).toContain("possible offset collapse on input face index 0 near (");
    expect(message).toContain("curvature radius 2 mm <= |thickness| 3.75 mm");
});

test("a self-intersecting wall over gentler curvature reports the minimum radius against the thickness", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const message = thickenFailureDiagnostic(SELF_INTERSECTION, sphere, -1);
    expect(message.startsWith(SELF_INTERSECTION)).toBe(true);
    expect(message).toContain(
        "minimum sampled curvature radius toward the offset side 2 mm on input face index 0 near (",
    );
    expect(message).toContain("larger than |thickness| 1 mm");
    expect(message).toContain("local curvature does not explain the crossing");
    expect(message).not.toContain("possible offset collapse");
});

test("a self-intersecting planar wall keeps the verdict as it is", () => {
    const box = keep(createBox(factory));
    expect(thickenFailureDiagnostic(SELF_INTERSECTION, box, -1)).toBe(SELF_INTERSECTION);
});

test.each([3.75, -1])("curvature in the safe direction at thickness %s is not blamed", (thickness) => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const message = thickenFailureDiagnostic(ERROR, sphere, thickness);
    expect(message).toContain("No limiting face was found");
    expect(message).not.toContain("likely offset collapse on input face");
});

test("a concave cavity's reversed normal limits outward thickness", () => {
    const outer = keep(createSphere(factory, undefined, 10));
    const inner = keep(createSphere(factory, undefined, 2));
    const hollow = keep(unwrapOk(factory.booleanCut([outer], [inner])));
    const message = thickenFailureDiagnostic(ERROR, hollow, 3.75);
    expect(message).toContain("input face index 1 near (");
    expect(message).toContain("curvature radius 2 mm <= |thickness| 3.75 mm");
    expect(thickenFailureDiagnostic(ERROR, hollow, -3.75)).toContain("No limiting face was found");
});

test("removed opening faces are excluded from the curvature estimate", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const faces = sphere.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    expect(faces).toHaveLength(1);
    const message = thickenFailureDiagnostic(ERROR, sphere, -3.75, faces);
    expect(message).toContain("No limiting face was found");
});

test("an unavailable surface query preserves the kernel error and offers a qualified hint", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const faces = sphere.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const query = rs.spyOn(Object.getPrototypeOf(faces[0]), "surface").mockImplementation(() => {
        throw new Error("surface unavailable");
    });
    const message = thickenFailureDiagnostic(ERROR, sphere, -3.75);
    expect(query).toHaveBeenCalled();
    expect(message).toContain(ERROR);
    expect(message).toContain("A maximum successful thickness is not known");
});

test("trapped kernels are never queried for a diagnostic", () => {
    const sphere = keep(createSphere(factory));
    const query = rs.spyOn(sphere, "findSubShapes");
    const error = "MakeThickSolidBySimple failed: RuntimeError: Aborted(undefined)";
    expect(thickenFailureDiagnostic(error, sphere, -20)).toBe(error);
    expect(query).not.toHaveBeenCalled();
});

test("a native trap during sampling stops queries and retains the original operation error", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const faces = sphere.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const surface = keep(faces[0].surface());
    rs.spyOn(Object.getPrototypeOf(faces[0]), "surface").mockReturnValue(surface);
    const release = rs.spyOn(surface, "dispose");
    const derivative = rs.spyOn(surface, "d2").mockImplementation(() => {
        throw new WebAssembly.RuntimeError("unreachable");
    });
    expect(thickenFailureDiagnostic(ERROR, sphere, -3.75)).toBe(ERROR);
    expect(derivative).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
});

test.each(["simple", "join"])("%s enriches a native offset failure without retrying it", (api) => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const release = rs.fn(() => {});
    const binding = rs
        .spyOn(wasm.ShapeFactory, api === "simple" ? "makeThickSolidBySimple" : "makeThickSolidByJoin")
        .mockReturnValue({ isOk: false, error: ERROR, delete: release } as unknown as ShapeResult);
    const result =
        api === "simple"
            ? factory.makeThickSolidBySimple(sphere, -3.75)
            : factory.makeThickSolidByJoin(sphere, [], -3.75, "arc");
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("input face index 0");
    expect(result.error).toContain("curvature radius 2 mm");
    expect(binding).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
});

test("planar validation failures retain their original meaning", () => {
    const box = keep(createBox(factory));
    const error = "MakeThickSolidByJoin failed: the offset did not remove an opening face";
    expect(thickenFailureDiagnostic(error, box, -3.75)).toBe(error);
});

function c0Skin(): IShape {
    const sections = [0, 10].map((z) =>
        keep(
            unwrapOk(
                factory.bspline(
                    [
                        new XYZ(0, 0, z),
                        new XYZ(2, 0, z),
                        new XYZ(4, 0, z),
                        new XYZ(6, 0, z),
                        new XYZ(6, 2, z),
                        new XYZ(6, 4, z),
                        new XYZ(6, 6, z),
                    ],
                    [0, 0.5, 1],
                    [4, 3, 4],
                    3,
                    false,
                ),
            ),
        ),
    );
    return keep(unwrapOk(factory.loft(sections, false, false, "c0")));
}

test("a C0 free-form surface names its face and continuity remedy without estimating curvature", () => {
    const skin = c0Skin();
    const faces = skin.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    expect(faces).toHaveLength(1);
    const surface = keep(faces[0].surface());
    expect(surface.continuity()).toBe("c0");
    const derivative = rs.spyOn(Object.getPrototypeOf(surface), "d2");
    const error = "Failed to create thick solid: BRepOffset_C0Geometry";
    const message = thickenFailureDiagnostic(error, skin, -3.75);
    expect(message).toContain(error);
    expect(message).toContain("C0 surface on input face index 0");
    expect(message).toContain("at least C1 continuity or split");
    expect(message).toContain("Reducing |thickness| does not fix");
    expect(message).not.toContain("curvature radius");
    expect(derivative).not.toHaveBeenCalled();
});

test("a native join failure on a C0 skin forwards the face-specific continuity diagnostic", () => {
    const skin = c0Skin();
    const result = factory.makeThickSolidByJoin(skin, [], -3.75, "arc");
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("BRepOffset_C0Geometry");
    expect(result.error).toContain("C0 surface on input face index 0");
    expect(result.error).toContain("at least C1 continuity");
    expect(result.error).not.toContain("Try |thickness| below");
});

test("C0 diagnosis excludes opening faces and preserves the cause when no face is identified", () => {
    const skin = c0Skin();
    const faces = skin.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    expect(faces).toHaveLength(1);
    const message = thickenFailureDiagnostic("BRepOffset_C0Geometry", skin, -3.75, faces);
    expect(message).toContain("no C0 input face was identified among the first 1 faces");
    expect(message).toContain("at least C1 continuity");
    expect(message).not.toContain("on input face index");
});

test("C0 diagnosis checks at most 64 surfaces and does not blame an uninspected face", () => {
    const box = keep(createBox(factory));
    const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const surface = rs.spyOn(faces[0], "surface");
    rs.spyOn(faces[0], "dispose").mockImplementation(() => {});
    const input = { findSubShapes: () => Array.from({ length: 65 }, () => faces[0]) } as unknown as IShape;
    const message = thickenFailureDiagnostic("BRepOffset_C0Geometry", input, -3.75);
    expect(surface).toHaveBeenCalledTimes(64);
    expect(message).toContain("no C0 input face was identified among the first 64 faces");
    expect(message).not.toContain("curvature radius");
});

test("a trap during a continuity query stops diagnosis and preserves the kernel error", () => {
    const skin = c0Skin();
    const faces = skin.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const surface = keep(faces[0].surface());
    rs.spyOn(Object.getPrototypeOf(faces[0]), "surface").mockReturnValue(surface);
    const release = rs.spyOn(surface, "dispose");
    const continuity = rs.spyOn(surface, "continuity").mockImplementation(() => {
        throw new WebAssembly.RuntimeError("unreachable");
    });
    const error = "Failed to create thick solid: BRepOffset_C0Geometry";
    expect(thickenFailureDiagnostic(error, skin, -3.75)).toBe(error);
    expect(continuity).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
});

test("diagnostics sample only the first 64 faces and name the sampling cap", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const faces = sphere.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const sample = rs.spyOn(faces[0], "surface");
    const input = { findSubShapes: () => Array.from({ length: 65 }, () => faces[0]) } as unknown as IShape;
    rs.spyOn(faces[0], "dispose").mockImplementation(() => {});
    const message = thickenFailureDiagnostic(ERROR, input, -3.75);
    expect(sample).toHaveBeenCalledTimes(64);
    expect(message).toContain("(sampled the first 64 of 65 faces)");
    expect(message).toContain("possible offset collapse");
});

test("a located face reports the translated sampling position", () => {
    const sphere = keep(createSphere(factory, undefined, 2));
    sphere.matrix = Matrix4.fromTranslation(100, 200, 300);
    const message = thickenFailureDiagnostic(ERROR, sphere, -3.75);
    expect(message).toContain("input face index 0 near (");
    const coordinates = /near \(([^)]+)\)/.exec(message);
    expect(coordinates).not.toBeNull();
    const [x, y, z] = coordinates![1].split(", ").map(Number);
    expect(x).toBeGreaterThan(97);
    expect(x).toBeLessThan(103);
    expect(y).toBeGreaterThan(197);
    expect(z).toBeGreaterThan(297);
    expect(message).toContain("curvature radius 2 mm");
});

test.each([
    "Tolerant envelope wall boolean failed",
    "Tolerant envelope failed: unrecognized cavity collapse",
    "Tolerant envelope failed volume sanity check",
])("%s retains the limiting region", (error) => {
    const sphere = keep(createSphere(factory, undefined, 2));
    const message = thickenFailureDiagnostic(error, sphere, -3.75);
    expect(message).toContain(error);
    expect(message).toContain("input face index 0 near (");
    expect(message).toContain("curvature radius 2 mm");
    expect(message).toContain("this analytic collapse was not resolved by tolerant mode");
    expect(message).not.toContain("retry with tolerant mode");
});

test.each([
    3.75, -3.75,
])("18 open control-point sections with shared knots thicken at %s mm and support a boolean trim", (thickness) => {
    // Issue #143's workaround: cubic sections, 12 poles, one clamped uniform knot vector.
    const knots = Array.from({ length: 10 }, (_, i) => i / 9);
    const multiplicities = knots.map((_, i) => (i === 0 || i === 9 ? 4 : 1));
    const sections = Array.from({ length: 18 }, (_, section) =>
        keep(
            unwrapOk(
                factory.bspline(
                    Array.from({ length: 12 }, (_, pole) => {
                        const t = pole / 11;
                        return new XYZ(50 * t, (5 + section / 10) * Math.sin(Math.PI * t), section * 3);
                    }),
                    knots,
                    multiplicities,
                    3,
                    false,
                ),
            ),
        ),
    );
    const skin = keep(unwrapOk(factory.loft(sections, false, false, "c2")));
    const wall = keep(unwrapOk(factory.makeThickSolidBySimple(skin, thickness)));
    expect(wall.shapeType).toBe(ShapeTypes.solid);
    expect(wall.checkShape()).toBe(true);
    expect(wall.volume()).toBeGreaterThan(0);
    const cutter = keep(createBox(factory, 25, 20, 60));
    cutter.matrix = Matrix4.fromTranslation(0, -10, -1);
    const trimmed = keep(unwrapOk(factory.booleanCut([wall], [cutter])));
    expect(trimmed.checkShape()).toBe(true);
    expect(trimmed.volume()).toBeGreaterThan(wall.volume() * 0.3);
    expect(trimmed.volume()).toBeLessThan(wall.volume() * 0.7);
});
