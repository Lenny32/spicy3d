// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, type I18nKeys, PubSub, property } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { sketchEntityMesh } from "../editor/sketchEventHandler";
import type { SketchClipboard } from "../sketchModel";
import { type SketchTransform, transformSketchSelection } from "../utilityOperations";
import { SketchConstraintCommand } from "./sketchConstraints";

/** In-memory clipboard shared by sketch sessions and documents. Never retains a solver. */
export const sketchClipboard: { value?: SketchClipboard } = {};

export abstract class SketchUtilityCommand extends SketchConstraintCommand {
    private confirm?: () => void;

    protected get numericInput(): boolean {
        return false;
    }

    @property("sketch.applyTransform")
    apply(): void {
        this.confirm?.();
    }

    protected async selection(editor: SketchEditor): Promise<number[] | undefined> {
        if (editor.selectedEntityIds.length) return editor.selectedEntityIds;
        this.controller = new AsyncController();
        const id = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (id === undefined) return undefined;
        if (id < 1) {
            PubSub.default.pub("displayError", "Select editable sketch entities");
            return undefined;
        }
        return [id];
    }

    protected pick(editor: SketchEditor, prompt: I18nKeys): Promise<[number, number] | undefined> {
        this.controller = new AsyncController();
        return editor.pickPosition(prompt, undefined, this.controller);
    }

    protected async previewTransform(
        editor: SketchEditor,
        ids: number[],
        proposal: (uv: [number, number]) => SketchTransform,
        clipboard?: SketchClipboard,
        copy = false,
    ): Promise<void> {
        let last: [number, number] | undefined;
        const apply = (uv: [number, number]) => editor.applyTransform(ids, proposal(uv), clipboard, copy);
        this.confirm = () => {
            const point = this.numericInput ? (last ?? ([0, 0] as [number, number])) : last;
            if (point && apply(point)) editor.cancelPick();
        };
        const render = (at: [number, number] | undefined) => {
            const result =
                at && transformSketchSelection(editor.solver.toData(), ids, proposal(at), clipboard, copy);
            editor.annotations.setGeometryPreview(
                result?.isOk
                    ? result.value.data.entities
                          .filter((e) => result.value.ids.includes(e.id))
                          .map((e) => sketchEntityMesh(editor, e, 0xffaa33))
                    : [],
            );
        };
        const refresh = () => render(this.numericInput ? (last ?? [0, 0]) : last);
        this.onPropertyChanged(refresh);
        try {
            this.controller = new AsyncController();
            refresh();
            const uv = await editor.pickPosition(
                "prompt.sketchTransformTarget",
                (at) => {
                    if (at) last = at;
                    render(at);
                },
                this.controller,
            );
            if (uv !== undefined) apply(uv);
        } finally {
            this.removePropertyChanged(refresh);
            this.confirm = undefined;
            editor.annotations.setGeometryPreview([]);
        }
    }
}
