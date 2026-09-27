// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { PubSub } from "@spicy3d/core";
import { CheckShapeCommand } from "../../src/commands/checkShape";

describe("CheckShapeCommand", () => {
    test("should have command metadata", () => {
        const data = (CheckShapeCommand as any).prototype.data;
        expect(data.key).toBe("modify.checkShape");
        expect(data.icon).toBe("icon-checkShape");
    });

    test("getSteps should return one step filtering ShapeNode", () => {
        const cmd = new CheckShapeCommand();
        const steps = (cmd as any).getSteps();
        expect(steps.length).toBe(1);
    });

    test("executeMainTask should show toast when no nodes selected", () => {
        let toastMessage = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, message: string) => {
            if (channel === "showToast") {
                toastMessage = message;
            }
        }) as any;

        try {
            const cmd = new CheckShapeCommand();
            (cmd as any).stepDatas = [{ nodes: undefined }];
            (cmd as any).executeMainTask();
            expect(toastMessage).toBe("toast.select.noSelected");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("executeMainTask should show toast when nodes array is empty", () => {
        let toastMessage = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, message: string) => {
            if (channel === "showToast") {
                toastMessage = message;
            }
        }) as any;

        try {
            const cmd = new CheckShapeCommand();
            (cmd as any).stepDatas = [{ nodes: [] }];
            (cmd as any).executeMainTask();
            expect(toastMessage).toBe("toast.select.noSelected");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("buildContent should render overallValid for all valid faces", () => {
        const cmd = new CheckShapeCommand();
        const faceResults = [
            { index: 0, isValid: true, status: ["ok"] },
            { index: 1, isValid: true, status: ["ok"] },
        ];
        const content = (cmd as any).buildContent(faceResults);
        expect(content instanceof HTMLElement).toBe(true);
        // Should contain valid class container
        expect(content.querySelector('[class*="overallValid"]')).not.toBeNull();
    });

    test("buildContent should render overallInvalid when some face is invalid", () => {
        const cmd = new CheckShapeCommand();
        const faceResults = [
            { index: 0, isValid: true, status: ["ok"] },
            { index: 1, isValid: false, status: ["error"] },
        ];
        const content = (cmd as any).buildContent(faceResults);
        expect(content.querySelector('[class*="overallInvalid"]')).not.toBeNull();
    });

    test("buildContent should show noFaces message when face array is empty", () => {
        const cmd = new CheckShapeCommand();
        const content = (cmd as any).buildContent([]);
        expect(content.querySelector('[class*="noFaces"]')).not.toBeNull();
    });

    test("renderFaceRow should render valid face row", () => {
        const cmd = new CheckShapeCommand();
        const row = (cmd as any).renderFaceRow({ index: 0, isValid: true, status: ["ok"] });
        expect(row instanceof HTMLElement).toBe(true);
        expect(row.querySelector('[class*="colStatusValid"]')).not.toBeNull();
    });

    test("renderFaceRow should render invalid face row", () => {
        const cmd = new CheckShapeCommand();
        const row = (cmd as any).renderFaceRow({ index: 1, isValid: false, status: ["error1", "error2"] });
        expect(row instanceof HTMLElement).toBe(true);
        expect(row.querySelector('[class*="colStatusInvalid"]')).not.toBeNull();
        expect(row.querySelector('[class*="colDetailError"]')?.textContent).toBe("error1, error2");
    });

    test("renderOverall should render valid state", () => {
        const cmd = new CheckShapeCommand();
        const el = (cmd as any).renderOverall(true);
        expect((el as HTMLElement).className.includes("overallValid")).toBe(true);
    });

    test("renderOverall should render invalid state", () => {
        const cmd = new CheckShapeCommand();
        const el = (cmd as any).renderOverall(false);
        expect((el as HTMLElement).className.includes("overallInvalid")).toBe(true);
    });

    test("renderTableHeader should render three column headers", () => {
        const cmd = new CheckShapeCommand();
        const header = (cmd as any).renderTableHeader();
        expect(header.querySelectorAll("span").length).toBe(3);
    });
});
