// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { SketchConstraintCommand } from "./sketchConstraints";

@command({ key: "sketch.autoConstrain", icon: "icon-cEqual" })
export class SketchAutoConstrainCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        editor.showDimensionReview();
    }
}
