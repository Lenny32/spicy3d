// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    Dimensions,
    type IStep,
    Precision,
    PubSub,
    property,
    Result,
    type XYZ,
} from "@spicy3d/core";
import { applyPointAutoConstraints } from "../autoConstraints";
import { ellipsePoint, toUV, toWorld } from "../sketchModel";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/** Center/axis/rim, or focus/focus/rim, converted to two perpendicular axis endpoints. */
export function ellipseParams(
    first: [number, number],
    second: [number, number],
    rim: [number, number],
    foci = false,
): Result<[number, number, number, number, number, number]> {
    const center: [number, number] = foci ? [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2] : first;
    const dx = second[0] - center[0];
    const dy = second[1] - center[1];
    const distance = Math.hypot(dx, dy);
    if (distance < Precision.Distance) return Result.err("Pick distinct center/axis points or foci");
    const ux = dx / distance;
    const uy = dy / distance;
    const x = (rim[0] - center[0]) * ux + (rim[1] - center[1]) * uy;
    const y = -(rim[0] - center[0]) * uy + (rim[1] - center[1]) * ux;
    const a = foci
        ? (Math.hypot(rim[0] - first[0], rim[1] - first[1]) +
              Math.hypot(rim[0] - second[0], rim[1] - second[1])) /
          2
        : distance;
    const b = foci
        ? Math.sqrt((a - distance) * (a + distance))
        : Math.abs(y) / Math.sqrt(1 - (x * x) / (a * a));
    if (!Number.isFinite(a + b) || Math.min(a, b) < Precision.Distance || (!foci && b > a)) {
        return Result.err("Pick a point on a non-degenerate ellipse inside the major-axis extent");
    }
    return Result.ok([
        center[0],
        center[1],
        center[0] + ux * a,
        center[1] + uy * a,
        center[0] - uy * b,
        center[1] + ux * b,
    ]);
}

@command({ key: "sketch.ellipse", icon: "icon-ellipse" })
export class SketchEllipseCommand extends SketchMultistepCommand {
    @property("sketch.ellipse.foci")
    get foci(): boolean {
        return this.getPrivateValue("foci", false);
    }
    set foci(value: boolean) {
        this.setProperty("foci", value);
    }

    getSteps(): IStep[] {
        return [
            new SketchPointStep(this.foci ? "prompt.pickFirstFocus" : "prompt.pickCircleCenter"),
            new SketchPointStep(this.foci ? "prompt.pickSecondFocus" : "prompt.pickMajorAxis", () => ({
                refPoint: () => this.stepDatas[0].point!,
                dimension: Dimensions.D1,
            })),
            new SketchPointStep("prompt.pickEllipsePoint", () => ({
                refPoint: () =>
                    this.foci
                        ? toWorld(
                              this.editor.node.plane,
                              (this.uvOf(0)[0] + this.uvOf(1)[0]) / 2,
                              (this.uvOf(0)[1] + this.uvOf(1)[1]) / 2,
                          )
                        : this.stepDatas[0].point!,
                dimension: Dimensions.D1D2D3,
                preview: this.previewEllipse,
            })),
        ];
    }

    protected executeMainTask(): void {
        const params = ellipseParams(this.uvOf(0), this.uvOf(1), this.uvOf(2), this.foci);
        if (!params.isOk) {
            PubSub.default.pub("displayError", params.error);
            return;
        }
        const id = this.editor.solver.addEllipse(...params.value);
        applyPointAutoConstraints(this.editor.solver, [{ entityId: id, pointIndex: 0 }], [id], {
            pointTolerance: this.editor.screenTolerance(),
        });
        this.editor.solve(true);
        this.editor.commit();
    }

    private readonly previewEllipse = (point: XYZ | undefined) => {
        if (point === undefined) return [this.meshPoint(this.stepDatas[0].point!)];
        const plane = this.editor.node.plane;
        const params = ellipseParams(this.uvOf(0), this.uvOf(1), toUV(plane, point), this.foci);
        if (!params.isOk) return [this.meshPoint(this.stepDatas[0].point!)];
        const points = Array.from({ length: 64 }, (_, i) =>
            toWorld(plane, ...ellipsePoint(params.value, (i * Math.PI) / 32)),
        );
        return points.map((p, i) => this.meshLine(p, points[(i + 1) % points.length]));
    };
}
