// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    command,
    type IStep,
    Precision,
    PubSub,
    type ShapeMeshData,
    type XYZ,
} from "@spicy3d/core";
import { toUV, toWorld } from "../sketchModel";
import { sampleSpline, splineParams } from "../splineGeometry";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/** Enter finishes the open curve; cancellation discards all tentative points. */
@command({ key: "sketch.spline", icon: "icon-bezier" })
export class SketchSplineCommand extends SketchMultistepCommand {
    private finishRequested = false;

    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickSplinePoint", () => ({
                refPoint: this.stepDatas.length === 0 ? undefined : () => this.stepDatas.at(-1)!.point!,
                preview: this.previewSpline,
                validator: (point) => {
                    const last = this.stepDatas.at(-1)?.point;
                    const first = this.stepDatas[0]?.point;
                    return (
                        (last === undefined || point.distanceTo(last) >= Precision.Distance) &&
                        (first === undefined || point.distanceTo(first) >= Precision.Distance)
                    );
                },
                onKeyDown: (event) => {
                    this.finishRequested = event.key === "Enter" || event.key === " ";
                },
            })),
        ];
    }

    protected override async executeSteps(): Promise<boolean> {
        this.finishRequested = false;
        const step = this.getSteps()[0];
        try {
            while (true) {
                this.controller = new AsyncController();
                const data = await step.execute(this.document, this.controller);
                if (data === undefined || this.controller.result?.status !== "success") {
                    return this.finishRequested && !this.isCanceled && this.stepDatas.length >= 2;
                }
                this.stepDatas.push(data);
            }
        } finally {
            this.document.selection.clearSelection();
        }
    }

    protected executeMainTask(): void {
        const result = this.editor.solver.addSpline(this.stepDatas.map((_, i) => this.uvOf(i)));
        if (!result.isOk) {
            PubSub.default.pub("displayError", result.error);
            return;
        }
        this.commitNewEntity(result.value);
    }

    private readonly previewSpline = (point: XYZ | undefined) => {
        const plane = this.editor.node.plane;
        const picked = this.stepDatas.map((data) => data.point!);
        const meshes: ShapeMeshData[] = picked.map((p) => this.meshPoint(p));
        const points = point === undefined ? picked : [...picked, point];
        const params = splineParams(points.map((p) => toUV(plane, p)));
        if (!params.isOk) return meshes;
        const world = sampleSpline(params.value).map((p) => toWorld(plane, ...p));
        for (let i = 1; i < world.length; i++) meshes.push(this.meshLine(world[i - 1], world[i]));
        return meshes;
    };
}
