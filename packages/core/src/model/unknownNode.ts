// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Id } from "../foundation";
import type { I18nKeys } from "../i18n";
import { InternalClassName, RawSerialized, type Serialized } from "../serialize";
import { FolderNode } from "./folderNode";
import type { INodeWarning } from "./nodeWarning";

/**
 * Placeholder for a stored node whose class this build does not register — typically one a plugin
 * that is not loaded wrote. It keeps the node's serialized JSON and writes it back unchanged on
 * save (only `name` and `visible`, which the tree can edit, follow the placeholder). It is a folder
 * so any children stored under it keep their parent.
 */
export class UnknownNode extends FolderNode implements INodeWarning {
    private readonly rawData: Serialized;

    readonly warningCount = 1;
    readonly warningTooltip: I18nKeys = "node.unknown.warning";

    get className(): string {
        return this.rawData[InternalClassName];
    }

    constructor(document: IDocument, data: Serialized) {
        const { parentId: _parentId, ...rawData } = structuredClone(data);
        super({
            document,
            name: typeof rawData["name"] === "string" ? rawData["name"] : rawData[InternalClassName],
            id: typeof rawData["id"] === "string" ? rawData["id"] : Id.generate(),
        });
        this.rawData = rawData as Serialized;
        if (rawData["visible"] === false) this.setPrivateValue("visible", false);
    }

    get [RawSerialized](): Serialized {
        return { ...structuredClone(this.rawData), id: this.id, name: this.name, visible: this.visible };
    }

    override clone(): this {
        const copy = { ...this[RawSerialized], id: Id.generate(), name: `${this.name}_copy` };
        return new UnknownNode(this.document, copy) as this;
    }
}
