// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, PubSub } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { copySketchSelection } from "../utilityOperations";
import { SketchUtilityCommand, sketchClipboard } from "./sketchUtilityCommand";

@command({ key: "sketch.copy", icon: "icon-copy2" })
export class SketchCopyCommand extends SketchUtilityCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const ids = await this.selection(editor);
        if (!ids) return;
        const result = copySketchSelection(editor.solver.toData(), ids);
        if (result.isOk) sketchClipboard.value = result.value;
        else PubSub.default.pub("displayError", result.error);
    }
}
