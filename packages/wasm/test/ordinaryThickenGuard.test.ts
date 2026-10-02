// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, ShapeTypes } from "@spicy3d/core";
import { ShapeFactory } from "../src/factory";
import { createBox, unwrapOk } from "./helpers";
import "./setup";

const owned: IDisposable[] = [];
afterEach(() => {
    for (const value of owned.splice(0).reverse()) value.dispose();
});
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}

test("ordinary arc thicken rejects the rebuilt unchanged all-fillet box", () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory, 30, 30, 20));
    const edges = box.findSubShapes(ShapeTypes.edge);
    owned.push(...edges);
    const input = keep(
        unwrapOk(
            factory.fillet(
                box,
                edges.map((_, index) => index),
                1,
            ),
        ),
    );
    const faces = input.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    const top = faces.find((face) => Math.abs(face.boundingBox().min.z - 20) < 1e-5);
    expect(top).not.toBeUndefined();
    const before = input.volume();
    const result = factory.makeThickSolidByJoin(input, [top!], -3.75, "arc");
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("input shape unchanged");
    expect(result.error).toContain("tolerant recovery has not been verified for this solid");
    expect(result.error).not.toContain("retry with tolerant mode");
    expect(input.volume()).toBeCloseTo(before, 6);
    expect(input.checkShape()).toBe(true);
});
