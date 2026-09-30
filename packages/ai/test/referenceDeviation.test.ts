// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Mesh, MeshNode } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildReferenceDeviationTool } from "../src/tools/referenceDeviation";

describe("measure_reference_deviation", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    function setup() {
        const document = createMockDocument();
        const positions = (z: number) => new Float32Array([0, 0, z, 10, 0, z, 0, 10, z]);
        const model = new MeshNode({
            document,
            id: "model",
            name: "model",
            mesh: new Mesh({ meshType: "surface", position: positions(2) }),
        });
        const reference = new MeshNode({
            document,
            id: "reference",
            name: "scan",
            mesh: new Mesh({ meshType: "surface", position: positions(0) }),
        });
        document.modelManager.findNode = (predicate) => [model, reference].find(predicate);
        const application = createMockApplication();
        Object.defineProperty(application, "activeView", { value: { document } });
        rs.stubGlobal("app", application);
        return { document, tool: buildReferenceDeviationTool() };
    }

    test("returns compact millimetre metrics, actual sample count and explicit accuracy", async () => {
        const { document, tool } = setup();
        document.repository.isReadOnly = () => true;
        const result = JSON.parse(
            (await tool.handler({ modelId: "model", referenceId: "reference", sampleCount: 32 })) as string,
        );
        expect(result.error).toBeUndefined();
        expect(result.unit).toBe("mm");
        expect(result.sampleCount).toBe(32);
        expect(result.rmsDeviation).toBeCloseTo(2, 10);
        expect(result.maxSampledDeviation).toBeCloseTo(2, 10);
        expect(result.worstSample.point.z).toBeCloseTo(2, 10);
        expect(result.worstSample.closestPoint.z).toBeCloseTo(0, 10);
        expect(result.accuracy).toContain("not a continuous maximum or Hausdorff distance");
        expect(result.modelId).toBe("model");
        expect(result.referenceId).toBe("reference");
    });

    test.each([
        ["missing model", { modelId: "missing" }],
        ["non-id", { referenceId: 9 }],
        ["not a reference mesh", { referenceId: "missing" }],
        ["same node", { referenceId: "model" }],
        ["string samples", { sampleCount: "100" }],
        ["fraction samples", { sampleCount: 1.5 }],
        ["zero samples", { sampleCount: 0 }],
        ["excess samples", { sampleCount: 65537 }],
        ["infinite budget", { timeBudgetMs: Number.POSITIVE_INFINITY }],
    ])("returns an error for %s", async (_label, invalid) => {
        const { tool } = setup();
        const result = JSON.parse(
            (await tool.handler({
                modelId: "model",
                referenceId: "reference",
                ...(invalid as Record<string, unknown>),
            })) as string,
        );
        expect(typeof result.error).toBe("string");
        expect(result.rmsDeviation).toBeUndefined();
    });

    test("honors the MCP call cancellation signal", async () => {
        const { tool } = setup();
        const controller = new AbortController();
        controller.abort();
        const result = JSON.parse(
            (await tool.handler({ modelId: "model", referenceId: "reference" }, controller.signal)) as string,
        );
        expect(result.error).toContain("cancelled");
    });
});
