// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type CadExportOptions,
    DocumentRebuilds,
    type IShape,
    Matrix4,
    PubSub,
    Result,
    type StlExportOptions,
} from "@spicy3d/core";
import { MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { registerFeature } from "../../parametric/src/features/feature";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { DefaultDataExchange } from "../src/defaultDataExchange";

function output(id: string) {
    const shape = new MockShape({ id });
    const placed = new MockShape({ id: `${id}-placed` });
    const transform = rs.spyOn(shape, "transformedMul").mockReturnValue(placed);
    return { shape, placed, transform };
}

function features(revision = 0, fail = false) {
    return Array.from({ length: 12 }, (_, index) => ({
        id: `f${index}`,
        type: "test-export-scheduled-step",
        revision,
        fail,
    }));
}

describe("DefaultDataExchange scheduled kernel export", () => {
    let document: TestDocument;
    let outputs: ReturnType<typeof output>[];

    const converter = {
        convertToSTEP: rs.fn((_shapes: IShape[], _options?: CadExportOptions) => Result.ok("step-data")),
        convertToSTL: rs.fn((_shapes: IShape[], _options?: StlExportOptions) =>
            Result.ok(new Uint8Array([1, 2, 3])),
        ),
    };

    beforeEach(() => {
        document = new TestDocument();
        outputs = [];
        converter.convertToSTEP.mockClear();
        converter.convertToSTL.mockClear();
        rs.stubGlobal("shapeConverter", converter);
        registerFeature("test-export-scheduled-step", {
            display: "body.parametricBody",
            nodeIds: () => [],
            parameters: () => [],
            setParameter: (feature) => feature,
            evaluate: (feature: ReturnType<typeof features>[number], context) => {
                if (feature.fail) return Result.err("synthetic export rebuild failure");
                const generated = output(`${feature.id}@${feature.revision}`);
                outputs.push(generated);
                if (context.tracking) {
                    context.tracking.outputFaceIds = [`${feature.id}:face`];
                    context.tracking.outputEdgeIds = [`${feature.id}:edge`];
                }
                return Result.ok(generated.shape);
            },
        });
    });

    afterEach(async () => {
        document.dispose();
        await DocumentRebuilds.settled(document);
        rs.unstubAllGlobals();
        rs.restoreAllMocks();
    });

    test.each([
        { format: ".step", method: "convertToSTEP", pendingEdit: false },
        { format: ".stl", method: "convertToSTL", pendingEdit: false },
        { format: ".step", method: "convertToSTEP", pendingEdit: true },
        { format: ".stl", method: "convertToSTL", pendingEdit: true },
    ] as const)("$format awaits the selected body (pending edit: $pendingEdit)", async ({
        format,
        method,
        pendingEdit,
    }) => {
        const node = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features()) });
        node.visible = false;
        node.transform = Matrix4.fromTranslation(10, 20, 30);
        document.modelManager.addNode(node);
        if (pendingEdit) {
            void node.shape;
            await node.whenRebuilt();
            node.featuresJson = JSON.stringify(features(1));
        }
        expect(node.isRebuilding).toBe(pendingEdit);
        expect(outputs).toHaveLength(pendingEdit ? 12 : 0);
        const before = outputs.length;

        const exported = new DefaultDataExchange().export(format, [node]);
        // Exercise the real asynchronous boundary, not a pre-flushed test fixture.
        expect(node.isRebuilding).toBe(true);
        expect(outputs).toHaveLength(before);
        expect(converter[method]).not.toHaveBeenCalled();
        const result = await exported;

        expect(result).toEqual(format === ".step" ? ["step-data"] : [new Uint8Array([1, 2, 3])]);
        expect(outputs).toHaveLength(before + 12);
        expect(node.isRebuilding).toBe(false);
        const final = outputs[outputs.length - 1];
        expect(final.shape.id).toBe(`f11@${pendingEdit ? 1 : 0}`);
        expect(converter[method]).toHaveBeenCalledTimes(1);
        expect(converter[method].mock.calls[0][0]).toEqual([final.placed]);
        expect(final.transform).toHaveBeenCalledTimes(1);
        expect(final.transform.mock.calls[0][0].equals(node.worldTransform())).toBe(true);
        expect(outputs.slice(0, -1).every((entry) => entry.transform.mock.calls.length === 0)).toBe(true);
        expect(node.visible).toBe(false);
        expect(DocumentRebuilds.pending(document)).toBe(false);
    });

    test.each([
        { format: ".step", method: "convertToSTEP" },
        { format: ".stl", method: "convertToSTL" },
    ] as const)("$format never hands an initial failed result to the converter", async ({
        format,
        method,
    }) => {
        const toast = rs.spyOn(PubSub.default, "pub");
        const node = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features(0, true)) });
        node.visible = false;
        document.modelManager.addNode(node);

        const result = await new DefaultDataExchange().export(format, [node]);

        expect(result).toBeUndefined();
        expect(converter[method]).not.toHaveBeenCalled();
        expect(node.isRebuilding).toBe(false);
        expect(node.resolvedShape).toBeUndefined();
        expect(toast).toHaveBeenCalledWith("showToast", "error.export.noNodeCanBeExported");
    });

    test("an aborted wait reports the pending rebuild instead of stale or missing geometry", async () => {
        const node = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features()) });
        document.modelManager.addNode(node);
        void node.shape;
        await node.whenRebuilt();
        node.featuresJson = JSON.stringify(features(1));
        expect(node.isRebuilding).toBe(true);
        const controller = new AbortController();
        const exchange = new DefaultDataExchange();

        const exported = exchange.exportResult(".stl binary", [node], { signal: controller.signal });
        controller.abort();
        const result = await exported;

        expect(result.isOk).toBe(false);
        expect(result.error.kind).toBe("rebuild-pending");
        expect(result.error.message).toMatch(/^the model is still rebuilding \(at feature \d+\)$/);
        expect(converter.convertToSTL).not.toHaveBeenCalled();
        expect(node.isRebuilding).toBe(true);

        // The rebuild was left running: a later export gets the edited geometry.
        await DocumentRebuilds.settled(document);
        const retried = await exchange.exportResult(".stl binary", [node], {
            signal: new AbortController().signal,
        });
        expect(retried.isOk).toBe(true);
        expect(converter.convertToSTL.mock.calls[0][0]).toEqual([outputs[outputs.length - 1].placed]);
        expect(outputs[outputs.length - 1].shape.id).toBe("f11@1");
    });

    test("a body without geometry after its rebuild is named in the failure", async () => {
        const node = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features(0, true)) });
        document.modelManager.addNode(node);

        const result = await new DefaultDataExchange().exportResult(".step", [node]);

        expect(result.isOk).toBe(false);
        expect(result.error).toEqual({
            kind: "no-geometry",
            message: "No selected node has geometry after its rebuild",
            nodes: [node.id],
        });
        expect(converter.convertToSTEP).not.toHaveBeenCalled();
    });

    test("a merged export lists the bodies it left out for lack of geometry", async () => {
        const good = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features()) });
        const failed = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features(0, true)) });
        document.modelManager.addNode(good);
        document.modelManager.addNode(failed);

        const result = await new DefaultDataExchange().exportResult(".step", [good, failed]);

        expect(result.isOk).toBe(true);
        expect(result.value).toEqual({ data: ["step-data"], skipped: [failed.id] });
        expect(converter.convertToSTEP.mock.calls[0][0]).toEqual([outputs[outputs.length - 1].placed]);
    });
});
