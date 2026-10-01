// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IFace, type IShape, Matrix4, ShapeTypes, XYZ } from "@spicy3d/core";
import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import type { OccShape } from "../src/shape";
import { createBox, unwrapOk } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

const factory = new ShapeFactory();
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

function invalidSolid(): IShape {
    const box = keep(createBox(factory));
    const faces = box.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    const shell = keep(unwrapOk(factory.shell(faces.slice(0, 5) as IFace[])));
    const solid = keep(unwrapOk(factory.solid([shell])));
    expect(solid.checkShape()).toBe(false);
    return solid;
}

function mixedOrientation(): IShape {
    const large = keep(createBox(factory));
    const small = keep(createBox(factory, 1, 2, 3));
    small.reserve();
    expect(small.volume()).toBeCloseTo(-6, 6);
    const compound = keep(unwrapOk(factory.combine([large, small])));
    expect(compound.volume()).toBeCloseTo(5994, 6);
    return compound;
}

test.each(["fuse", "cut", "common"] as const)("tracked %s analyzes only the result", async (operation) => {
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const input = keep(createBox(factory));
    const tool = keep(createBox(factory, 5, 10, 15));
    const check = rs.spyOn(wasm.Shape, "check");
    const pending = hybrid.booleanTracked(operation, [input], [tool]);
    expect(pending).not.toBeUndefined();
    await pending!.ready;
    const result = pending!.take();
    expect(result.isOk).toBe(true);
    owned.push(...result.value.inputs, result.value.result.shape);
    expect(check).toHaveBeenCalledOnce();
    expect(result.value.result.shape.volume()).toBeCloseTo(
        operation === "cut" ? 5250 : operation === "common" ? 750 : 6000,
        5,
    );
});

test.each([
    "booleanFuse",
    "booleanCut",
    "booleanCommon",
] as const)("%s rejects a negative component even when the compound total is positive", async (method) => {
    const input = mixedOrientation();
    const tool = keep(createBox(factory, 5, 10, 15));
    const sync = factory[method]([input], [tool], false);
    expect(sync.isOk).toBe(false);
    expect(sync.error).toMatch(/solid 1 has invalid volume \(-[\d.]+ mm³\)/);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method, left: [input], right: [tool] });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toMatch(/solid 1 has invalid volume \(-[\d.]+ mm³\)/);
});

test.each([
    "booleanFuse",
    "booleanCut",
    "booleanCommon",
] as const)("%s refuses an invalid result before exporting it", async (method) => {
    const input = keep(createBox(factory));
    const tool = keep(createBox(factory, 5, 10, 15));
    const invalid = invalidSolid() as OccShape;
    const original = wasm.ShapeFactory[method];
    rs.spyOn(wasm.ShapeFactory, method).mockImplementation((left, right) => {
        const result = original(left, right);
        Object.defineProperty(result, "shape", { get: () => invalid.shape });
        return result;
    });
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method, left: [input], right: [tool] });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain(`${method} result: invalid shape`);
});

test.each(["fillet", "chamfer"] as const)("bounded %s refuses an invalid preceding solid", async (method) => {
    const input = invalidSolid();
    const invoke = rs.spyOn(wasm.ShapeFactory, method);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method, shape: input, edges: [0], value: 1 });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain(`${method} input 0: invalid shape`);
    expect(invoke).not.toHaveBeenCalled();
});

test("a 13-section free-form loft rejects an exploding open-face inward thicken", async () => {
    const sections = Array.from({ length: 13 }, (_, index) => {
        const z = -60 + index * 10;
        const points = [new XYZ(-10, 0, z), new XYZ(-1, 15, z), new XYZ(1, 15, z), new XYZ(10, 0, z)];
        const skin = keep(unwrapOk(factory.bezier(points)));
        const corners = [points[3], new XYZ(10, -15, z), new XYZ(-10, -15, z), points[0]];
        const edges = [
            skin,
            ...corners.slice(1).map((point, i) => keep(unwrapOk(factory.line(corners[i], point)))),
        ];
        return keep(unwrapOk(factory.wire(edges)));
    });
    const loft = keep(unwrapOk(factory.loft(sections, true, false, "c2")));
    expect(loft.checkShape()).toBe(true);
    expect(loft.volume()).toBeCloseTo(52740, 4);
    const faces = loft.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    const openings = faces.filter((face) => keep((face as IFace).surface()).isPlanar());
    expect(openings).toHaveLength(5);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({
        method: "makeThickSolidByJoin",
        shape: loft,
        closingFaces: openings,
        thickness: -3.75,
        joinType: "arc",
        mode: "skin",
        intersection: false,
    });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("Thick solid is invalid (BRepCheck_Analyzer)");
    expect(result.error).toContain("curvature radius 3.025 mm <= |thickness| 3.75 mm");
    expect(loft.checkShape()).toBe(true);
    expect(loft.volume()).toBeCloseTo(52740, 4);
    // A successful kernel call can still return invalid geometry. Geometry-code failures
    // receive the same local-curvature advice as the kernel's invalid-code failures.
    const invalid = invalidSolid() as OccShape;
    rs.spyOn(wasm.ShapeFactory, "makeThickSolidByJoin").mockImplementation(
        () =>
            ({
                isOk: true,
                shape: invalid.shape,
                error: "",
                delete: () => {},
            }) as ReturnType<typeof wasm.ShapeFactory.makeThickSolidByJoin>,
    );
    const invalidOutput = hybrid.shapeOperation({
        method: "makeThickSolidByJoin",
        shape: loft,
        closingFaces: openings,
        thickness: -3.75,
        joinType: "arc",
        mode: "skin",
        intersection: false,
    });
    await invalidOutput.ready;
    const geometry = invalidOutput.take();
    expect(geometry.isOk).toBe(false);
    expect(geometry.error).toContain("makeThickSolidByJoin result: invalid shape");
    expect(geometry.error).toContain("curvature radius 3.025 mm <= |thickness| 3.75 mm");
});

test.each([
    "booleanFuseTracked",
    "booleanCutTracked",
    "booleanCommonTracked",
] as const)("%s rejects a negative output component without disabling the worker", async (method) => {
    const output = mixedOrientation() as OccShape;
    const original = wasm.ShapeFactory[method];
    rs.spyOn(wasm.ShapeFactory, method).mockImplementation((left, right) => {
        const result = original(left, right);
        Object.defineProperty(result, "shape", { get: () => output.shape });
        return result;
    });
    const transport = new NativeWorkerTransport();
    const hybrid = keep(new HybridShapeFactory(() => transport.client));
    const operation =
        method === "booleanCutTracked" ? "cut" : method === "booleanCommonTracked" ? "common" : "fuse";
    const pending = hybrid.booleanTracked(
        operation,
        [keep(createBox(factory))],
        [keep(createBox(factory, 5, 10, 15))],
    );
    expect(pending).not.toBeUndefined();
    await pending!.ready;
    const result = pending!.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain(`Boolean ${operation} result: solid 1 has invalid volume`);
    expect(pending!.canFallback).toBe(false);
    expect(hybrid.failure).toBeUndefined();
});

test.each([
    "fillet",
    "chamfer",
] as const)("a valid %s box remains accepted by the bounded bridge", async (method) => {
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method, shape: keep(createBox(factory)), edges: [0], value: 1 });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(true);
    const shape = keep(result.value);
    expect(shape.checkShape()).toBe(true);
    expect(shape.volume()).toBeGreaterThan(5900);
    expect(shape.volume()).toBeLessThan(6000);
});

test("the bounded bridge accepts valid loft sections and rejects a broken section before lofting", async () => {
    const sections = [0, 20].map((z) => keep(unwrapOk(factory.circle(XYZ.unitZ, new XYZ(0, 0, z), 5))));
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({
        method: "loft",
        sections,
        isSolid: true,
        isRuled: false,
        continuity: "c2",
    });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(true);
    const loft = keep(result.value);
    expect(loft.checkShape()).toBe(true);
    expect(loft.volume()).toBeCloseTo(Math.PI * 25 * 20, 5);
    const check = rs.spyOn(wasm.Shape, "check").mockReturnValue(false);
    const invoke = rs.spyOn(wasm.ShapeFactory, "loft");
    const broken = hybrid.shapeOperation({
        method: "loft",
        sections,
        isSolid: true,
        isRuled: false,
        continuity: "c2",
    });
    await broken.ready;
    const failure = broken.take();
    expect(check).toHaveBeenCalledOnce();
    expect(failure.isOk).toBe(false);
    expect(failure.error).toContain("loft input 0: invalid shape");
    expect(invoke).not.toHaveBeenCalled();
});

test.each([
    "booleanFuseTracked",
    "booleanCutTracked",
    "booleanCommonTracked",
] as const)("%s rejects a topologically invalid output", async (method) => {
    const output = invalidSolid() as OccShape;
    const original = wasm.ShapeFactory[method];
    rs.spyOn(wasm.ShapeFactory, method).mockImplementation((left, right) => {
        const result = original(left, right);
        Object.defineProperty(result, "shape", { get: () => output.shape });
        return result;
    });
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const operation =
        method === "booleanCutTracked" ? "cut" : method === "booleanCommonTracked" ? "common" : "fuse";
    const pending = hybrid.booleanTracked(
        operation,
        [keep(createBox(factory))],
        [keep(createBox(factory, 5, 10, 15))],
    );
    expect(pending).not.toBeUndefined();
    await pending!.ready;
    const result = pending!.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain(`Boolean ${operation} result: invalid shape`);
    expect(pending!.canFallback).toBe(false);
    expect(hybrid.failure).toBeUndefined();
});

test("synchronous valid booleans pre-check volume without calling a main-thread analyzer", () => {
    const input = keep(createBox(factory));
    const tool = keep(createBox(factory, 5, 10, 15));
    const check = rs.spyOn(wasm.Shape, "check");
    const self = rs.spyOn(wasm.Shape, "checkSelfIntersection");
    const cut = keep(unwrapOk(factory.booleanCut([input], [tool])));
    expect(cut.volume()).toBeCloseTo(5250, 5);
    expect(check).not.toHaveBeenCalled();
    expect(self).not.toHaveBeenCalled();
});

test("synchronous volume validation never allocates face wrappers", () => {
    const input = keep(createBox(factory));
    const tool = keep(createBox(factory, 5, 10, 15));
    const find = rs.spyOn(wasm.Shape, "findSubShapes");
    const result = factory.booleanCut([input], [tool]);
    expect(result.isOk).toBe(true);
    keep(result.value);
    expect(find.mock.calls.some(([, type]) => type === wasm.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(false);
    expect(find.mock.calls.filter(([, type]) => type === wasm.TopAbs_ShapeEnum.TopAbs_SOLID)).toHaveLength(3);
});

function tubeSkin(): IShape {
    const sections = [0, 20].map((z) => keep(unwrapOk(factory.circle(XYZ.unitZ, new XYZ(0, 0, z), 10))));
    return keep(unwrapOk(factory.loft(sections, false, false, "c2")));
}

test.each([
    2, -2,
])("bounded thicken at %s preserves valid walls and repairs orientation", async (thickness) => {
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method: "makeThickSolidBySimple", shape: tubeSkin(), thickness });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(true);
    const wall = keep(result.value);
    expect(wall.checkShape()).toBe(true);
    expect(wall.volume()).toBeGreaterThan(2000);
    expect(wall.volume()).toBeLessThan(3000);
});

test("bounded thicken rejects a negative component hidden by the compound total", async () => {
    const input = tubeSkin();
    const output = mixedOrientation() as OccShape;
    const original = wasm.ShapeFactory.makeThickSolidBySimple;
    rs.spyOn(wasm.ShapeFactory, "makeThickSolidBySimple").mockImplementation((shape, thickness) => {
        const result = original(shape, thickness);
        Object.defineProperty(result, "shape", { get: () => output.shape });
        return result;
    });
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method: "makeThickSolidBySimple", shape: input, thickness: -2 });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("makeThickSolidBySimple result: solid 1 has invalid volume");
});

test("an unavailable volume pre-check returns an operation error before starting a boolean", () => {
    const input = keep(createBox(factory));
    const tool = keep(createBox(factory, 5, 10, 15));
    rs.spyOn(wasm.Shape, "volume").mockImplementation(() => {
        throw new Error("cannot measure solid");
    });
    const invoke = rs.spyOn(wasm.ShapeFactory, "booleanCut");
    const result = factory.booleanCut([input], [tool]);
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("BooleanCut input validation failed: cannot measure solid");
    expect(invoke).not.toHaveBeenCalled();
});

test.each([2, -2])("synchronous thicken at %s also repairs orientation", (thickness) => {
    const wall = keep(unwrapOk(factory.makeThickSolidBySimple(tubeSkin(), thickness)));
    expect(wall.checkShape()).toBe(true);
    expect(wall.volume()).toBeGreaterThan(2000);
    expect(wall.volume()).toBeLessThan(3000);
});

test.each([
    "booleanCut",
    "booleanCommon",
    "booleanFuse",
] as const)("%s tolerates tiny negative integration roundoff in both paths", async (method) => {
    const input = keep(createBox(factory));
    const tool = keep(createBox(factory, 5, 10, 15));
    rs.spyOn(wasm.Shape, "volume").mockReturnValue(-1e-12);
    const sync = factory[method]([input], [tool], false);
    expect(sync.isOk).toBe(true);
    keep(sync.value);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.shapeOperation({ method, left: [input], right: [tool] });
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(true);
    keep(result.value);
});

test("worker booleans accept an operand failing BRepCheck when the result is valid", async () => {
    const input = invalidSolid() as OccShape;
    expect(input.volume()).toBeGreaterThan(0);
    const tool = keep(createBox(factory, 5, 10, 15));
    const validInput = keep(createBox(factory)) as unknown as OccShape;
    const native = wasm.ShapeFactory.booleanCutTracked;
    // Model a successful boolean on imported tolerance defects; the result is an actual valid cut.
    const invoke = rs
        .spyOn(wasm.ShapeFactory, "booleanCutTracked")
        .mockImplementation((_left, right) => native([validInput.shape], right));
    const sync = factory.booleanCutTracked([input], [tool]);
    expect(sync.isOk).toBe(true);
    keep(sync.value.shape);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.booleanTracked("cut", [input], [tool])!;
    await task.ready;
    const result = task.take();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.isOk).toBe(true);
    owned.push(...result.value.inputs, result.value.result.shape);
    expect(result.value.result.shape.checkShape()).toBe(true);
    expect(result.value.result.shape.volume()).toBeCloseTo(sync.value.shape.volume(), 6);
});

test("a worker chain does not revalidate a resident boolean result as an operand", async () => {
    const transport = new NativeWorkerTransport();
    try {
        const a = await transport.client.request("box", {
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 10, y: 10, z: 10 },
        });
        const b = await transport.client.request("box", {
            origin: { x: 5, y: 0, z: 0 },
            size: { x: 10, y: 10, z: 10 },
        });
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        if (!a.ok || !b.ok) throw new Error("box creation failed");
        const check = rs.spyOn(wasm.Shape, "check");
        const first = await transport.client.request("boolean", {
            operation: "fuse",
            left: [a.value],
            right: [b.value],
        });
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error(first.error.message);
        const volume = rs.spyOn(wasm.Shape, "volume");
        const second = await transport.client.request("boolean", {
            operation: "cut",
            left: [first.value.handle],
            right: [b.value],
        });
        expect(second.ok).toBe(true);
        expect(check).toHaveBeenCalledTimes(2);
        // Only the new tool and result: total and per-solid volume for each.
        expect(volume).toHaveBeenCalledTimes(4);
    } finally {
        transport.client.dispose();
    }
});

test("several positive solids are accepted by sync and worker booleans", async () => {
    const a = keep(createBox(factory));
    const b = keep(createBox(factory)).transformedMul(Matrix4.fromTranslation(30, 0, 0));
    keep(b);
    const compound = keep(unwrapOk(factory.combine([a, b])));
    const tool = keep(createBox(factory, 5, 10, 15));
    const sync = keep(unwrapOk(factory.booleanCut([compound], [tool])));
    expect(sync.checkShape()).toBe(true);
    const solids = sync.findSubShapes(ShapeTypes.solid);
    owned.push(...solids);
    expect(solids).toHaveLength(2);
    expect(solids.every((solid) => solid.volume() > 0)).toBe(true);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const task = hybrid.booleanTracked("cut", [compound], [tool])!;
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(true);
    owned.push(...result.value.inputs, result.value.result.shape);
    expect(result.value.result.shape.volume()).toBeCloseTo(sync.volume(), 6);
});
