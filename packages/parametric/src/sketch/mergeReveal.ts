// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, IMergePathRevealer, INode } from "@spicy3d/core";
import { SketchEditor } from "./editor/sketchEditor";
import { SketchNode } from "./sketchNode";

/**
 * The sketch entities a merge path inside a sketch names (docs/merge.md, "Paths"):
 * `entity/<id>` and `external/<id>` that entity, `constraint/<id>` the entities it constrains.
 */
export function sketchEntitiesOfPath(node: SketchNode, segments: readonly string[]): number[] {
    const [kind, raw] = segments;
    const id = Number(raw);
    if (raw === undefined || !Number.isFinite(id)) return [];
    if (kind === "text") return [id];
    if (kind === "entity" || kind === "external") {
        return [node.data.texts?.find((text) => text.profileIds.includes(id))?.id ?? id];
    }
    if (kind === "constraint") {
        const constraint = node.data.constraints.find((c) => c.id === id);
        return [...new Set(constraint?.refs.map((r) => r.entityId) ?? [])];
    }
    return [];
}

/**
 * Selecting a conflict about a sketch entity (CLOUD-13) opens the sketch — when its document is
 * the one shown — and selects the entities concerned.
 */
export const sketchMergeRevealer: IMergePathRevealer = {
    reveal(document: IDocument, node: INode, segments: readonly string[]): boolean {
        if (!(node instanceof SketchNode)) return false;
        const ids = sketchEntitiesOfPath(node, segments);
        if (ids.length === 0) return false;
        if (document.application.activeView?.document !== document) return false;
        const editor =
            SketchEditor.getActive()?.node === node ? SketchEditor.getActive()! : SketchEditor.enter(node);
        editor.selectEntities(ids);
        return true;
    },
};
