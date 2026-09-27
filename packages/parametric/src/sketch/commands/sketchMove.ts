// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, property } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { selectionCenter } from "../utilityOperations";
import { SketchUtilityCommand } from "./sketchUtilityCommand";

@command({ key: "sketch.move", icon: "icon-move" })
export class SketchMoveCommand extends SketchUtilityCommand {
    private requestAnchor?: () => void;
    protected override get numericInput(): boolean {
        return this.numeric;
    }
    @property("sketch.numericTransform")
    get numeric(): boolean {
        return this.getPrivateValue("numeric", false);
    }
    set numeric(value: boolean) {
        this.setProperty("numeric", value);
    }
    @property("sketch.moveX", { quantity: "length" })
    get dx(): number {
        return this.getPrivateValue("dx", 0);
    }
    set dx(value: number) {
        if (Number.isFinite(value)) this.setProperty("dx", value);
    }
    @property("sketch.moveY", { quantity: "length" })
    get dy(): number {
        return this.getPrivateValue("dy", 0);
    }
    set dy(value: number) {
        if (Number.isFinite(value)) this.setProperty("dy", value);
    }
    @property("sketch.pickAnchor")
    pickAnchor(): void {
        this.requestAnchor?.();
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const ids = await this.selection(editor);
        if (!ids) return;
        let anchor = selectionCenter(editor.solver.entities().filter((e) => ids.includes(e.id)));
        let chooseAnchor = false;
        try {
            do {
                if (chooseAnchor) {
                    chooseAnchor = false;
                    const picked = await this.pick(editor, "prompt.sketchTransformAnchor");
                    if (!picked) return;
                    anchor = picked;
                }
                this.requestAnchor = () => {
                    chooseAnchor = true;
                    editor.cancelPick();
                };
                await this.previewTransform(editor, ids, (uv) => ({
                    kind: "move",
                    delta: this.numeric ? [this.dx, this.dy] : [uv[0] - anchor[0], uv[1] - anchor[1]],
                }));
                this.requestAnchor = undefined;
            } while (chooseAnchor);
        } finally {
            this.requestAnchor = undefined;
        }
    }
}
