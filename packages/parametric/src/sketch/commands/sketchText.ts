// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type EdgeMeshData,
    type IStep,
    type Plane,
    PubSub,
    property,
    VisualConfig,
    type XYZ,
} from "@spicy3d/core";
import { toUV, toWorld } from "../sketchModel";
import { type SketchTextData, textBounds, textContours } from "../sketchText";
import type { SketchSolver } from "../solver";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/** Samples per quadratic glyph segment in the preview polyline. */
const PREVIEW_SAMPLES = 6;

/**
 * Places a text in the active sketch (`sketchText.ts`): its glyph outlines become profiles, so the
 * text can be extruded, cut or embossed. Clicking inside an existing text applies the current
 * settings to it instead; an empty text deletes the clicked one.
 */
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
        const solver = this.editor.solver;
        const hit = textAt(solver, x, y, this.editor.screenTolerance());
        const settings = { value: this.text, height: this.height, angle: this.angle };
        if (hit !== undefined) {
            if (settings.value.trim() === "") solver.removeText(hit.id);
            else solver.updateText(hit.id, settings);
        } else if (settings.value.trim() === "") {
            PubSub.default.pub("showToast", "error.sketch.emptyText");
            return;
        } else {
            solver.addText({ ...settings, x, y });
        }
        this.editor.commit();
    }

    private readonly previewText = (point: XYZ | undefined) => {
        if (point === undefined) return [];
        const plane = this.editor.node.plane;
        const [x, y] = toUV(plane, point);
        const hit = textAt(this.editor.solver, x, y, this.editor.screenTolerance());
        // Over an existing text, preview it with the new settings where it stands.
        const text: SketchTextData =
            hit === undefined
                ? { id: 0, value: this.text, x, y, height: this.height, angle: this.angle }
                : { ...hit, value: this.text, height: this.height, angle: this.angle };
        return [this.meshPoint(point), textOutlineMesh(plane, text)];
    };
}

/** The text whose outline bounds contain (x, y), within `tolerance`; the last placed wins. */
export function textAt(solver: SketchSolver, x: number, y: number, tolerance: number) {
    return solver
        .textsData()
        .reverse()
        .find((text) => {
            const bounds = textBounds(text);
            return (
                bounds !== undefined &&
                x >= bounds.minX - tolerance &&
                x <= bounds.maxX + tolerance &&
                y >= bounds.minY - tolerance &&
                y <= bounds.maxY + tolerance
            );
        });
}

/** The text's glyph outlines as one line-segment mesh (quadratic segments sampled). */
export function textOutlineMesh(plane: Plane, text: SketchTextData): EdgeMeshData {
    const position: number[] = [];
    const push = (from: readonly [number, number], to: readonly [number, number]) => {
        const a = toWorld(plane, ...from);
        const b = toWorld(plane, ...to);
        position.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    for (const contour of textContours(text)) {
        for (const segment of contour) {
            if (segment.length === 2) {
                push(segment[0], segment[1]);
                continue;
            }
            const [p0, p1, p2] = segment;
            let previous = p0;
            for (let i = 1; i <= PREVIEW_SAMPLES; i++) {
                const t = i / PREVIEW_SAMPLES;
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
    return {
        position: new Float32Array(position),
        color: VisualConfig.defaultEdgeColor,
        lineType: "solid",
        range: [],
    };
}
