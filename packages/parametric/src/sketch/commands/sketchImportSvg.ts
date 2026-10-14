// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type Property,
    PubSub,
    parseSvg,
    property,
    readFilesAsync,
    type SvgDrawing,
    SvgImportRoute,
} from "@spicy3d/core";
import { SketchEditor } from "../editor/sketchEditor";
import type { SketchClipboard } from "../sketchModel";
import { svgSketchClipboard } from "../svgGeometry";
import { SketchUtilityCommand } from "./sketchUtilityCommand";

/**
 * Imports an SVG drawing into the open sketch as ordinary lines and B-splines, on the sketch's
 * own plane (a face included): the drawing follows the cursor by its bounding-box centre — at
 * the sketch origin until the cursor moves — and a click, or Apply, drops it as one undo step.
 * Scale, size and angle can be typed before or while placing; the preview follows at once.
 */
@command({ key: "sketch.importSvg", icon: "icon-import" })
export class SketchImportSvgCommand extends SketchUtilityCommand {
    /** The drawing's own size in millimetres, from its units; 0 until a file is read. */
    private naturalSize = { width: 0, height: 0 };
    private drawing?: SvgDrawing;
    private built?: { scale: number; angle: number; clipboard?: SketchClipboard };

    protected override get numericInput(): boolean {
        return true;
    }

    @property("file.svg.scale")
    public get scale(): number {
        return this.getPrivateValue("scale", 1);
    }
    public set scale(value: number) {
        if (!Number.isFinite(value) || value <= 0) return;
        this.setProperty("scale", value, () => this.emitSizeChanged());
    }

    @property("file.svg.width", { quantity: "length" })
    public get width(): number {
        return this.naturalSize.width * this.scale;
    }
    public set width(value: number) {
        if (this.naturalSize.width > 0) this.scale = value / this.naturalSize.width;
    }

    @property("file.svg.height", { quantity: "length" })
    public get height(): number {
        return this.naturalSize.height * this.scale;
    }
    public set height(value: number) {
        if (this.naturalSize.height > 0) this.scale = value / this.naturalSize.height;
    }

    /** Degrees, counter-clockwise; not `angle`, whose remembered value other commands share. */
    @property("file.svg.angle")
    public get rotation(): number {
        return this.getPrivateValue("rotation", 0);
    }
    public set rotation(value: number) {
        if (Number.isFinite(value)) this.setProperty("rotation", value);
    }

    /**
     * Width and height follow the file and the scale; only scale (shared with `file.importSvg`)
     * and rotation are carried over.
     */
    protected override isPropertyCached(property: Property): boolean {
        return property.name === "scale" || property.name === "rotation";
    }

    private emitSizeChanged() {
        this.emitPropertyChanged("width", this.width);
        this.emitPropertyChanged("height", this.height);
    }

    /** The drawing at the current scale and angle, rebuilt only when one of them changed. */
    private clipboard(): SketchClipboard | undefined {
        if (!this.drawing) return undefined;
        const { scale, rotation: angle } = this;
        if (this.built?.scale !== scale || this.built.angle !== angle) {
            const result = svgSketchClipboard(this.drawing, { scale, angle });
            if (!result.isOk) PubSub.default.pub("displayError", result.error);
            this.built = { scale, angle, clipboard: result.isOk ? result.value : undefined };
        }
        return this.built.clipboard;
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const files = await readFilesAsync(".svg", false);
        if (this.checkCanceled() || !files.isOk || files.value.length === 0) return;
        const drawing = parseSvg(await files.value[0].text());
        const bounds = drawing.isOk ? drawing.value.bounds : undefined;
        if (!drawing.isOk || !bounds) {
            const error = drawing.isOk ? "The SVG file has no outlines to import" : drawing.error;
            PubSub.default.pub("showToast", "error.import.svg:{0}", error);
            return;
        }
        if (this.checkCanceled() || !editor.isActive) return;
        this.drawing = drawing.value;
        this.naturalSize = { width: bounds.max.x - bounds.min.x, height: bounds.max.y - bounds.min.y };
        this.emitSizeChanged();
        if (!this.clipboard()) return;
        if (drawing.value.skipped.length > 0)
            PubSub.default.pub("showToast", "toast.import.svgSkipped{0}", drawing.value.skipped.length);
        await this.previewTransform(
            editor,
            [],
            (uv) => ({ kind: "move", delta: [uv[0], uv[1]] }),
            () => this.clipboard(),
        );
    }
}

/** File > Import SVG during a sketch session lands in that sketch, on its plane. */
SvgImportRoute.redirect = () => (SketchEditor.getActive() ? "sketch.importSvg" : undefined);
