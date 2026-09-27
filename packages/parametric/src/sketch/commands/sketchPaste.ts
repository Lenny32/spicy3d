// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, PubSub } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { SketchUtilityCommand, sketchClipboard } from "./sketchUtilityCommand";

@command({ key: "sketch.paste", icon: "icon-copy2" })
export class SketchPasteCommand extends SketchUtilityCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const clipboard = sketchClipboard.value;
        if (!clipboard) {
            PubSub.default.pub("displayError", "Copy sketch entities before pasting");
            return;
        }
        await this.previewTransform(
            editor,
            [],
            (uv) => ({ kind: "move", delta: [uv[0] - clipboard.origin[0], uv[1] - clipboard.origin[1]] }),
            clipboard,
        );
    }
}
