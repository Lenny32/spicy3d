// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IStep, property, type XYZ } from "@spicy3d/core";
import { promptSketchText } from "../editor/textPrompt";
import { toUV } from "../sketchModel";
import type { SketchTextSettings } from "../sketchText";
import { textFrameMesh, textOutlineMesh } from "../textVisual";

export { textOutlineMesh } from "../textVisual";

import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/** Places an editable text frame; outlines participate in normal sketch profiles. */
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
        return [
            new SketchPointStep("prompt.pickTextPosition"),
            new SketchPointStep("prompt.pickTextFrame", () => ({ preview: this.previewText })),
        ];
    }

    protected executeMainTask(): void {
        const [x, y] = this.uvOf(1);
        promptSketchText(this.editor, this.optionsAt(x, y));
    }

    private optionsAt(x: number, y: number): SketchTextSettings {
        const [ax, ay] = this.uvOf(0);
        return {
            value: this.text,
            x: Math.min(ax, x),
            y: Math.min(ay, y),
            height: this.height,
            angle: this.angle,
            frame: { width: Math.max(Math.abs(x - ax), 0.1), height: Math.max(Math.abs(y - ay), 0.1) },
            alignment: "left",
            verticalAlignment: "top",
            spacing: 0,
            font: "sans",
        };
    }

    private readonly previewText = (point: XYZ | undefined) => {
        if (point === undefined) return [];
        const plane = this.editor.node.plane;
        const [x, y] = toUV(plane, point);
        const settings = this.optionsAt(x, y);
        return [textOutlineMesh(plane, settings), textFrameMesh(plane, settings)];
    };
}
