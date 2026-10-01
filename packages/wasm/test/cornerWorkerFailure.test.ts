// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import { createBox } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

test("corner worker loading failure returns an error without enabling synchronous fallback", async () => {
    const transport = new NativeWorkerTransport();
    const post = rs.spyOn(transport, "postMessage").mockImplementation((_message) => {});
    const hybrid = new HybridShapeFactory(() => transport.client);
    const box = createBox(new ShapeFactory());
    try {
        const operation = hybrid.cornerSetbackTracked(box, [0, 1, 2], 2, [2.49, 2.5, 2.51]);
        transport.dispatchEvent(new Event("error"));
        await operation.ready;
        const answer = operation.take();
        expect(answer.isOk).toBe(false);
        expect(answer.error).toMatch(/worker/i);
        expect(operation.canFallback).toBe(false);
        expect(hybrid.available).toBe(false);
        const next = hybrid.cornerSetbackTracked(box, [0, 1, 2], 2, [2.49, 2.5, 2.51]);
        await next.ready;
        expect(next.canFallback).toBe(false);
        expect(next.take().error).toMatch(/worker/i);
    } finally {
        post.mockRestore();
        hybrid.dispose();
        box.dispose();
    }
});

test("invalid setback input is rejected before capturing geometry or starting a worker", async () => {
    const createWorker = rs.fn(() => new NativeWorkerTransport().client);
    const hybrid = new HybridShapeFactory(createWorker);
    const box = createBox(new ShapeFactory());
    const clone = rs.spyOn(wasm.Shape, "clone");
    try {
        const operation = hybrid.cornerSetbackTracked(box, [0, 0, 1], 2, [2.49, 2.5, 2.51]);
        await operation.ready;
        expect(operation.take().error).toBe("Corner setbacks require three distinct edges");
        expect(operation.canFallback).toBe(false);
        expect(createWorker).not.toHaveBeenCalled();
        expect(clone).not.toHaveBeenCalled();
    } finally {
        clone.mockRestore();
        hybrid.dispose();
        box.dispose();
    }
});
