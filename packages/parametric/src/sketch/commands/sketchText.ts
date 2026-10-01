// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type EdgeMeshData,
    I18n,
    type IStep,
    type Plane,
    PubSub,
    property,
    VisualConfig,
    type XYZ,
} from "@spicy3d/core";
import { toUV, toWorld } from "../sketchModel";
import { addTextGeometry, type TextOutlineOptions, textContours } from "../textGeometry";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/** Places text as normal sketch outlines. Content/settings are editable only before placement. */
@command({ key: "sketch.text", icon: "icon-text" })
export class SketchTextCommand extends SketchMultistepCommand {
    @property("sketch.text.value")
    get text(): string {
        return this.getPrivateValue("text", "Text");
    }
    set text(value: string) {
        this.setProperty("text", value);
    }

    @property("sketch.text.height")
    get height(): number {
        return this.getPrivateValue("height", 5);
    }
    set height(value: number) {
        if (Number.isFinite(value) && value > 0) this.setProperty("height", value);
    }

    @property("common.angle")
    get angle(): number {
        return this.getPrivateValue("angle", 0);
    }
    set angle(value: number) {
        if (Number.isFinite(value)) this.setProperty("angle", value);
    }

    getSteps(): IStep[] {
        return [new SketchPointStep("prompt.pickTextPosition", () => ({ preview: this.previewText }))];
    }

    protected executeMainTask(): void {
        const [x, y] = this.uvOf(0);
        const result = addTextGeometry(this.editor.solver, this.optionsAt(x, y));
        if (!result.isOk) {
            PubSub.default.pub("displayError", I18n.translate(result.error));
            return;
        }
        this.editor.solve(true);
        this.editor.commit();
    }

    private optionsAt(x: number, y: number): TextOutlineOptions {
        return { value: this.text, x, y, height: this.height, angle: this.angle };
    }

    private readonly previewText = (point: XYZ | undefined) => {
        if (point === undefined) return [];
        const plane = this.editor.node.plane;
        const [x, y] = toUV(plane, point);
        return [this.meshPoint(point), textOutlineMesh(plane, this.optionsAt(x, y))];
    };
}

/** Quadratics are sampled only for the temporary preview; saved curves remain exact. */
export function textOutlineMesh(plane: Plane, options: TextOutlineOptions): EdgeMeshData {
    const position: number[] = [];
    const contours = textContours(options);
    const push = (from: readonly [number, number], to: readonly [number, number]) => {
        const a = toWorld(plane, ...from);
        const b = toWorld(plane, ...to);
        position.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    if (contours.isOk) {
        for (const contour of contours.value) {
            for (const segment of contour) {
                if (segment.length === 2) {
                    push(segment[0], segment[1]);
                    continue;
                }
                const [p0, p1, p2] = segment;
                let previous = p0;
                for (let i = 1; i <= 6; i++) {
                    const t = i / 6;
                    const s = 1 - t;
                    const next: [number, number] = [
                        s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0],
                        s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1],
                    ];
                    push(previous, next);
                    previous = next;
                }
            }
        }
    }
    return {
        position: new Float32Array(position),
        color: VisualConfig.defaultEdgeColor,
        lineType: "solid",
        range: [],
    };
}
