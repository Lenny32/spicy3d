// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CancelableCommand, command, PubSub } from "@spicy3d/core";

/**
 * Opens the document's parameter dialog. A variable is a document-level parameter, not
 * a step of any body's feature list, so this picks nothing and appends to nothing — the
 * dialog edits `document.variables` as a whole and one confirm is one undo step.
 */
@command({ key: "feature.variable", icon: "icon-tag" })
export class VariableCommand extends CancelableCommand {
    protected async executeAsync(): Promise<void> {
        const document = this.document;
        PubSub.default.pub("editVariables", document, () => document.visual.update());
    }
}
