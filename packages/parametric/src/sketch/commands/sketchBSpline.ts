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
import { bsplinePolyline } from "../bsplineGeometry";
import { defineControlBSpline } from "../controlBSplineGeometry";
import { toUV, toWorld } from "../sketchModel";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/**
 * Draws one interpolating B-spline through the picked fit points (chord-length parametrization,
 * `bsplineGeometry.ts`). Enter / Space or a second click on the last point finishes an open
 * curve; a click back on the first point (from three points on) closes it into a periodic curve;
 * Esc discards the tentative points.
 */
@command({ key: "sketch.bspline", icon: "icon-bspline" })
export class SketchBSplineCommand extends SketchMultistepCommand {
    protected get controlMode(): boolean {
        return false;
    }
    private finishRequested = false;
    private periodic = false;

    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickBSplinePoint", () => ({
                refPoint: this.stepDatas.length === 0 ? undefined : () => this.stepDatas.at(-1)!.point!,
                preview: this.previewBSpline,
                onKeyDown: (event) => {
                    this.finishRequested = event.key === "Enter" || event.key === " ";
                },
            })),
        ];
    }

    protected override async executeSteps(): Promise<boolean> {
        this.finishRequested = false;
        this.periodic = false;
        const step = this.getSteps()[0];
        try {
            while (true) {
                this.controller = new AsyncController();
                const data = await step.execute(this.document, this.controller);
                if (data === undefined || this.controller.result?.status !== "success") {
                    return this.finishRequested && !this.isCanceled && this.stepDatas.length >= 2;
                }
                const pick = this.classify(data.point!);
                if (pick === "close") {
                    this.periodic = true;
                    return true;
                }
                if (pick === "finish") {
                    if (this.stepDatas.length >= 2) return true;
                    continue;
                }
                this.stepDatas.push(data);
            }
        } finally {
            this.document.selection.clearSelection();
        }
    }

    /** A pick on the first point closes the curve (three points on), one on the last point finishes it. */
    private classify(point: XYZ): "close" | "finish" | "add" {
        const tolerance = Math.max(this.editor.screenTolerance(), Precision.Distance);
        const first = this.stepDatas[0]?.point;
        const last = this.stepDatas.at(-1)?.point;
        if (this.stepDatas.length >= 3 && first !== undefined && point.distanceTo(first) <= tolerance) {
            return "close";
        }
        if (last !== undefined && point.distanceTo(last) <= tolerance) return "finish";
        return "add";
    }

    protected executeMainTask(): void {
        const points = this.stepDatas.map((_, i) => this.uvOf(i));
        const definition = this.controlMode
            ? defineControlBSpline(points, { periodic: this.periodic })
            : undefined;
        if (definition && !definition.isOk) {
            PubSub.default.pub("displayError", definition.error);
            return;
        }
        const result = this.editor.solver.addBSpline(points, {
            periodic: this.periodic,
            ...(definition?.isOk ? { control: definition.value } : {}),
        });
        if (!result.isOk) {
            PubSub.default.pub("displayError", result.error);
            return;
        }
        this.commitNewEntity(result.value);
    }

    private readonly previewBSpline = (point: XYZ | undefined) => {
        const plane = this.editor.node.plane;
        const picked = this.stepDatas.map((data) => data.point!);
        const meshes: ShapeMeshData[] = picked.map((p) => this.meshPoint(p));
        const pick = point === undefined ? "finish" : this.classify(point);
        const points = pick === "add" && point !== undefined ? [...picked, point] : picked;
        if (points.length < 2) return meshes;
        const params = points.flatMap((p) => toUV(plane, p));
        const definition = this.controlMode
            ? defineControlBSpline(
                  points.map((p) => toUV(plane, p)),
                  { periodic: pick === "close" },
              )
            : undefined;
        const world = bsplinePolyline(params, {
            periodic: pick === "close",
            ...(definition?.isOk ? { control: definition.value } : {}),
        }).map((p) => toWorld(plane, ...p));
        for (let i = 1; i < world.length; i++) meshes.push(this.meshLine(world[i - 1], world[i]));
        return meshes;
    };
}

@command({ key: "sketch.controlBSpline", icon: "icon-bspline" })
export class SketchControlBSplineCommand extends SketchBSplineCommand {
    protected override get controlMode(): boolean {
        return true;
    }
}
