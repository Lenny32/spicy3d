// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type AnalysisResult, I18n, Result } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { AnalysisPanel } from "../src/project/analysisPanel";

test("running shows progress and Cancel; cancellation restores Run and can retry", async () => {
    const doc = new TestDocument();
    let finish!: (result: Result<AnalysisResult>) => void;
    const evaluate = rs.fn(
        () =>
            new Promise<Result<AnalysisResult>>((resolve) => {
                finish = resolve;
            }),
    );
    doc.analyses.registerEvaluator("fixture", evaluate);
    const node = doc.analyses.add({
        kind: "fixture",
        name: "Fixture",
        sources: [],
        settings: {},
        visible: true,
    });
    const panel = new AnalysisPanel(node);
    const cancelAnalysis = rs.spyOn(doc.analyses, "cancelAnalysis");
    document.body.append(panel);
    const button = (key: "common.cancel" | "analysis.panel.run") =>
        [...panel.querySelectorAll("button")].find((item) => item.textContent === I18n.translate(key));
    try {
        expect(node.status).toBe("running");
        expect(panel.querySelector("progress")).not.toBeNull();
        const cancel = button("common.cancel");
        expect(cancel).not.toBeUndefined();
        expect(button("analysis.panel.run")).toBeUndefined();
        cancel!.click();
        expect(cancelAnalysis).toHaveBeenCalledExactlyOnceWith(node);
        expect(node.status).toBe("idle");
        expect(panel.querySelector("progress")).toBeNull();
        expect(button("common.cancel")).toBeUndefined();
        finish(Result.err("stale"));
        await Promise.resolve();
        await Promise.resolve();
        const retry = button("analysis.panel.run");
        expect(retry).not.toBeUndefined();
        retry!.click();
        expect(evaluate).toHaveBeenCalledTimes(2);
        expect(node.status).toBe("running");
        expect(panel.querySelector("progress")).not.toBeNull();
        expect(button("common.cancel")).not.toBeUndefined();
        finish(Result.ok({}));
        await Promise.resolve();
        await Promise.resolve();
        expect(node.status).toBe("ready");
        expect(panel.querySelector("progress")).toBeNull();
        expect(button("common.cancel")).toBeUndefined();
    } finally {
        panel.remove();
        rs.restoreAllMocks();
        doc.dispose();
    }
});
