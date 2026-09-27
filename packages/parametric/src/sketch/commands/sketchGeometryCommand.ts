// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, MeshDataUtils, PubSub, Result, VisualConfig } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { entityDistance, sketchEntityMesh } from "../editor/sketchEventHandler";
import {
    editableCurve,
    extendCurve,
    type GeometryEdit,
    offsetCurve,
    splitCurve,
    trimCurve,
} from "../geometryEditing";
import { entityRadius, type SketchEntityData, toWorld } from "../sketchModel";
import { constraintTargetEntities } from "../solverEntities";
import { SketchConstraintCommand } from "./sketchConstraints";

export abstract class SketchGeometryCommand extends SketchConstraintCommand {
    protected abstract readonly operation: "trim" | "extend" | "split" | "offset";
    protected get offsetDistance(): number {
        return 1;
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        let targetId: number | undefined;
        let sourceId: number | undefined;
        if (this.operation === "extend" || this.operation === "offset") {
            this.controller = new AsyncController();
            const id = await editor.pickEntity(
                this.operation === "extend" ? "prompt.sketchExtendTarget" : "prompt.pickSketchEntity",
                ["line", "arc", "circle"],
                undefined,
                this.controller,
            );
            if (id === undefined) return;
            if (this.operation === "extend") targetId = id;
            else sourceId = id;
        }
        const proposal = (uv: [number, number]): Result<GeometryEdit> => {
            const curves = constraintTargetEntities(editor.solver).filter(editableCurve);
            const source =
                sourceId === undefined
                    ? curves
                          .filter((e) => !editor.solver.isFixed(e.id) && e.id !== targetId)
                          .map((e) => ({ e, distance: entityDistance(uv, e) }))
                          .filter((hit) => hit.distance <= editor.screenTolerance())
                          .sort((a, b) => a.distance - b.distance)[0]?.e
                    : editor.solver.entity(sourceId);
            if (!source || editor.solver.isFixed(source.id))
                return Result.err("Select editable sketch geometry");
            if (this.operation === "trim") return trimCurve(source, curves, uv);
            if (this.operation === "split") return splitCurve(source, uv, curves, editor.screenTolerance());
            if (this.operation === "extend") {
                const target = targetId === undefined ? undefined : editor.solver.entity(targetId);
                return target
                    ? extendCurve(source, target, uv)
                    : Result.err("The extension target no longer exists");
            }
            return offsetCurve(source, this.offsetDistance * offsetSide(source, uv));
        };
        try {
            while (!this.isCanceled) {
                this.controller = new AsyncController();
                const uv = await editor.pickPosition(
                    this.operation === "offset" ? "prompt.sketchOffsetSide" : "prompt.sketchEditCurve",
                    (at) => {
                        const edit = at === undefined ? undefined : proposal(at);
                        const meshes = edit?.isOk
                            ? edit.value.preview.map((e, i) =>
                                  sketchEntityMesh(
                                      editor,
                                      e,
                                      this.operation === "trim" ? 0xff5555 : i % 2 ? 0x55ddaa : 0xffaa33,
                                  ),
                              )
                            : [];
                        if (edit?.isOk && this.operation === "split") {
                            const p = edit.value.pieces[0].params;
                            meshes.push(
                                MeshDataUtils.createVertexMesh(
                                    toWorld(editor.node.plane, p[p.length - 2], p[p.length - 1]),
                                    VisualConfig.editVertexSize,
                                    0xffaa33,
                                ),
                            );
                        }
                        editor.annotations.setGeometryPreview(meshes);
                    },
                    this.controller,
                );
                editor.annotations.setGeometryPreview([]);
                if (uv === undefined) break;
                const edit = proposal(uv);
                if (!edit.isOk) {
                    PubSub.default.pub("displayError", edit.error);
                    continue;
                }
                const applied = editor.applyGeometryEdit(edit.value);
                if (applied && this.operation === "offset") break;
            }
        } finally {
            editor.annotations.setGeometryPreview([]);
        }
    }
}

function offsetSide(e: SketchEntityData, uv: [number, number]): number {
    const [x, y, x2, y2] = e.params;
    const signed =
        e.type === "line"
            ? (x2 - x) * (uv[1] - y) - (y2 - y) * (uv[0] - x)
            : Math.hypot(uv[0] - x, uv[1] - y) - entityRadius(e);
    return signed < 0 ? -1 : 1;
}
