// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type DialogButton, type MeshDeviationResult, PubSub, type ShapeMeshData, XYZ } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { showDeviationResult } from "../../src/commands/referenceDeviation";

const result: MeshDeviationResult = {
    unit: "mm",
    direction: "model-to-reference",
    sampling: "deterministic-area-weighted",
    sampleCount: 128,
    modelTriangleCount: 2,
    referenceTriangleCount: 2,
    meanDeviation: 1,
    rmsDeviation: 1.25,
    maxSampledDeviation: 2,
    worstSample: { point: new XYZ(3, 4, 2), closestPoint: new XYZ(3, 4, 0) },
    accuracy: "Sampled tessellation distances",
};

describe("deviation results", () => {
    test.each([
        "common.confirm",
        "common.cancel",
    ])("shows project units and releases overlay on %s", async (button) => {
        const document = createMockDocument();
        document.settings.lengthUnit = "cm";
        const displayMesh = rs.fn((_data: ShapeMeshData[]) => 17);
        const removeMesh = rs.fn((_id: number) => {});
        document.visual.context.displayMesh = displayMesh;
        document.visual.context.removeMesh = removeMesh;
        let content: HTMLElement | undefined;
        let buttons: DialogButton[] = [];
        const onDialog: Parameters<typeof PubSub.default.sub<"showDialog">>[1] = (
            _title,
            element,
            options,
        ) => {
            content = element;
            buttons = Array.isArray(options) ? options : [];
        };
        PubSub.default.sub("showDialog", onDialog);
        try {
            showDeviationResult(document, result);
            expect(content).not.toBeUndefined();
            expect(content?.textContent).toContain("0.125000 cm");
            expect(content?.textContent).toContain("128");
            expect(displayMesh).toHaveBeenCalledTimes(1);
            expect(Array.from(displayMesh.mock.calls[0][0][0].position)).toEqual([3, 4, 2, 3, 4, 0]);
            const close = buttons.find((option) => option.content === button);
            expect(close).not.toBeUndefined();
            await close?.onclick?.();
            expect(removeMesh).toHaveBeenCalledWith(17);
            PubSub.default.pub("documentClosed", document);
            expect(removeMesh).toHaveBeenCalledTimes(1);
        } finally {
            PubSub.default.remove("showDialog", onDialog);
            PubSub.default.pub("documentClosed", document);
        }
    });

    test("releases the transient overlay when its document closes", () => {
        const document = createMockDocument();
        const removeMesh = rs.fn((_id: number) => {});
        document.visual.context.removeMesh = removeMesh;
        showDeviationResult(document, result);
        PubSub.default.pub("documentClosed", document);
        expect(removeMesh).toHaveBeenCalledTimes(1);
    });
});
