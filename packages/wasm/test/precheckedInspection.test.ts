// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, Matrix4, Plane, precheckInspectionShapes, XYZ } from "@spicy3d/core";
import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import type { OccShape } from "../src/shape";
import { createBox, unwrapOk } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

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

test("common volume consumes checks for both exact inputs without entering legacy analyzer binding", async () => {
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const factory = new ShapeFactory(undefined, hybrid);
    const box = keep(createBox(factory) as unknown as OccShape);
    const other = keep(box.transformedMul(Matrix4.fromTranslation(3, 4, 5)) as OccShape);
    const oldBinding = rs.spyOn(wasm.Shape, "inspectionCommonVolume");
    const checkedBinding = rs.spyOn(wasm.Shape, "inspectionCommonVolumePrechecked");
    const analyzer = rs.spyOn(wasm.Shape, "checkSelfIntersection");
    const checked = unwrapOk(await precheckInspectionShapes([box, other], factory));
    const volume = unwrapOk(box.inspectionCommonVolume(other, checked));
    expect(volume).toBeCloseTo(7 * 16 * 25, 6);
    expect(analyzer).toHaveBeenCalledTimes(2);
    expect(checkedBinding).toHaveBeenCalledTimes(1);
    expect(oldBinding).toHaveBeenCalledTimes(0);
    unwrapOk(box.inspectionCommonVolume(other, new Set([box])));
    expect(oldBinding).toHaveBeenCalledTimes(1);
    const binding = wasm.Shape.inspectionCommonVolumePrechecked;
    try {
        wasm.Shape.inspectionCommonVolumePrechecked = undefined as never;
        expect(unwrapOk(box.inspectionCommonVolume(other, checked))).toBeCloseTo(volume, 6);
        expect(oldBinding).toHaveBeenCalledTimes(2);
    } finally {
        wasm.Shape.inspectionCommonVolumePrechecked = binding;
    }
});

test("section caps consume the worker verdict once and old binaries retain their original binding", async () => {
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const factory = new ShapeFactory(undefined, hybrid);
    const box = keep(createBox(factory) as unknown as OccShape);
    const oldBinding = rs.spyOn(wasm.Shape, "inspectionSectionCaps");
    const checkedBinding = rs.spyOn(wasm.Shape, "inspectionSectionCapsPrechecked");
    const analyzer = rs.spyOn(wasm.Shape, "checkSelfIntersection");
    const receipt = unwrapOk(await precheckInspectionShapes([box], factory));
    const plane = Plane.XY.translateTo(new XYZ(0, 0, 5));
    const caps = keep(unwrapOk(box.inspectionSectionCaps(plane, receipt)));
    expect(caps.checkShape()).toBe(true);
    expect(analyzer).toHaveBeenCalledTimes(1);
    expect(checkedBinding).toHaveBeenCalledTimes(1);
    expect(oldBinding).toHaveBeenCalledTimes(0);
    const binding = wasm.Shape.inspectionSectionCapsPrechecked;
    try {
        wasm.Shape.inspectionSectionCapsPrechecked = undefined as never;
        const fallback = keep(unwrapOk(box.inspectionSectionCaps(plane, receipt)));
        expect(fallback.checkShape()).toBe(true);
        expect(oldBinding).toHaveBeenCalledTimes(1);
    } finally {
        wasm.Shape.inspectionSectionCapsPrechecked = binding;
    }
});
