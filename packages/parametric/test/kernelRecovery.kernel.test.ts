// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IEdge,
    type IFace,
    KernelRecoveryCheckpoints,
    KernelState,
    Plane,
    ShapeTypes,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { createWasmRecoveryContext, initWasm, ShapeFactory } from "@spicy3d/wasm";
import { retireKernelModule } from "../../wasm/src/kernelGuard";
import { captureEdgeRef } from "../src/features/edgeRef";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "../src";
import "./sketch/setup";

const wasmBinary = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);

async function setup() {
    await initWasm({ wasmBinary });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        configurable: true,
        writable: true,
    });
    return [0, 1].map((index) => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc);
        const serialize = doc.serialize.bind(doc);
        doc.serialize = () => ({ ...serialize(), models: doc.modelManager.serialize() });
        const sketch = new SketchNode({
            document: doc,
            id: `sketch-${index}`,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 20, 0] },
                    { id: 2, type: "line", params: [20, 0, 20, 20] },
                    { id: 3, type: "line", params: [20, 20, 0, 20] },
                    { id: 4, type: "line", params: [0, 20, 0, 0] },
                ],
                constraints: [],
            },
        });
        doc.modelManager.addNode(sketch);
        const profiles =
            sketch.mesh.faces?.range.filter((item) => item.shape.shapeType === ShapeTypes.face) ?? [];
        expect(profiles).toHaveLength(1);
        const body = new ParametricBodyNode({
            document: doc,
            id: `body-${index}`,
            features: [
                {
                    id: "extrude",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 20,
                    profiles: [captureProfileRef(profiles[0].shape as unknown as IFace)],
                },
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        const edge = body.shape.value.findSubShapes(ShapeTypes.edge)[0] as IEdge;
        const ref = captureEdgeRef(edge, body.edgeIdAt(0));
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "fillet", type: "fillet", radius: 1, edges: [ref] },
        ]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(KernelRecoveryCheckpoints.capture(doc)).toBe(true);
        return {
            doc,
            body,
            edgeIds: body.shape.value.findSubShapes(ShapeTypes.edge).map((_, index) => body.edgeIdAt(index)),
        };
    });
}

afterEach(() => KernelState.current.reset());

test("real fillet references survive preparation in a fresh module while retired native handles stay blocked", async () => {
    const entries = await setup();
    const oldModule = globalThis.wasm;
    const oldShape = entries[0].body.shape.value;
    const roots = entries.map(({ doc }) => doc.modelManager.rootNode);
    const positions = entries.map(({ doc }) => doc.history.position());
    retireKernelModule(oldModule, "injected fatal crash");
    KernelState.current.markCrashed("injected fatal crash");
    const recovered: ParametricBodyNode[] = [];
    const prepared = await KernelRecoveryCheckpoints.prepare(
        entries.map(({ doc }) => doc),
        () => createWasmRecoveryContext({ wasmBinary }),
        (doc, checkpoint) => {
            return ParametricBodyNode.withSynchronousEvaluation(doc, () =>
                doc.modelManager.prepareRecoveryNodes(checkpoint.data["models"].nodes, () => {
                    const body = doc.modelManager.findNode(
                        (node) => node instanceof ParametricBodyNode,
                    ) as ParametricBodyNode;
                    expect(body).toBeInstanceOf(ParametricBodyNode);
                    expect(body.shape.isOk).toBe(true);
                    expect(body.shape.value.checkShape()).toBe(true);
                    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
                    recovered.push(body);
                    expect(() => oldShape.checkShape()).toThrow("different kernel generation");
                }),
            );
        },
    );
    expect(recovered).toHaveLength(2);
    prepared.context.run(() =>
        recovered.forEach((body, index) => {
            expect(
                body.shape.value.findSubShapes(ShapeTypes.edge).map((_, index) => body.edgeIdAt(index)),
            ).toEqual(entries[index].edgeIds);
            expect(body.features).toEqual(entries[index].body.features);
        }),
    );
    expect(globalThis.wasm).toBe(oldModule);
    expect(KernelState.current.status).toBe("crashed");
    entries.forEach(({ doc }, index) => {
        expect(doc.modelManager.rootNode).toBe(roots[index]);
        expect(doc.history.position()).toBe(positions[index]);
    });
    prepared.dispose();
    prepared.dispose();
    expect(globalThis.wasm).toBe(oldModule);
    expect(() => oldShape.checkShape()).toThrow("injected fatal crash");
});

test("a native rebuild failure in the second candidate leaves both open documents intact", async () => {
    const entries = await setup();
    const oldModule = globalThis.wasm;
    const roots = entries.map(({ doc }) => doc.modelManager.rootNode);
    const positions = entries.map(({ doc }) => doc.history.position());
    retireKernelModule(oldModule, "injected fatal crash");
    KernelState.current.markCrashed("injected fatal crash");
    let validated = 0;
    await expect(
        KernelRecoveryCheckpoints.prepare(
            entries.map(({ doc }) => doc),
            () => createWasmRecoveryContext({ wasmBinary }),
            (doc, checkpoint) => {
                return ParametricBodyNode.withSynchronousEvaluation(doc, () =>
                    doc.modelManager.prepareRecoveryNodes(checkpoint.data["models"].nodes, () => {
                        const body = doc.modelManager.findNode(
                            (node) => node instanceof ParametricBodyNode,
                        ) as ParametricBodyNode;
                        if (doc === entries[1].doc) {
                            const fillet = body.features[1];
                            expect(fillet.type).toBe("fillet");
                            if (fillet.type !== "fillet") throw new Error("Expected fillet feature");
                            body.setFeaturesEmitShapeChanged([
                                body.features[0],
                                { id: "fillet", type: "fillet", radius: 10000, edges: fillet.edges },
                            ]);
                            expect(body.featureItems()[1].error).toBeTruthy();
                            throw new Error("Candidate fillet rebuild failed");
                        }
                        expect(body.shape.isOk).toBe(true);
                        expect(body.shape.value.checkShape()).toBe(true);
                        validated++;
                    }),
                );
            },
        ),
    ).rejects.toThrow("Candidate fillet rebuild failed");
    expect(validated).toBe(1);
    expect(globalThis.wasm).toBe(oldModule);
    expect(KernelState.current.status).toBe("crashed");
    entries.forEach(({ doc, body }, index) => {
        expect(doc.modelManager.rootNode).toBe(roots[index]);
        expect(doc.history.position()).toBe(positions[index]);
        expect(body.features[1]).toMatchObject({ type: "fillet", radius: 1 });
    });
});
