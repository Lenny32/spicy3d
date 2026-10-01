// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, command, PubSub } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { promptSketchText } from "../editor/textPrompt";
import { addTextGeometry } from "../textGeometry";
import { SketchConstraintCommand } from "./sketchConstraints";

@command({ key: "sketch.editText", icon: "icon-text" })
export class SketchEditTextCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const id =
            editor.selectedEntityIds.length === 1
                ? editor.selectedEntityIds[0]
                : await editor.pickEntity(
                      "prompt.pickSketchEntity",
                      undefined,
                      { includeText: true },
                      this.controller,
                  );
        const text = id === undefined ? undefined : editor.solver.text(id);
        if (!text) return;
        promptSketchText(editor, text, text.id);
    }
}

@command({ key: "sketch.explodeText", icon: "icon-text" })
export class SketchExplodeTextCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const ids = editor.selectedEntityIds.length
            ? editor.selectedEntityIds
            : [
                  await editor.pickEntity(
                      "prompt.pickSketchEntity",
                      undefined,
                      { includeText: true },
                      this.controller,
                  ),
              ];
        const trial = editor.solver.fork();
        try {
            let changed = false;
            for (const id of ids) {
                const text = id === undefined ? undefined : trial.text(id);
                if (!text) continue;
                const result = addTextGeometry(trial, text);
                if (!result.isOk) {
                    PubSub.default.pub("displayError", result.error);
                    return;
                }
                trial.removeText(text.id);
                changed = true;
            }
            if (!changed) return;
            editor.solver.reset(trial.toData());
            editor.solve(true);
            editor.commit();
        } finally {
            trial.dispose();
        }
    }
}
