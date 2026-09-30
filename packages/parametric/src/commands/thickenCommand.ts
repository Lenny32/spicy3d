// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    command,
    GetOrSelectNodeStep,
    I18n,
    type I18nKeys,
    Id,
    type IFace,
    type INode,
    type INodeVisual,
    LENGTH_UNITS,
    type ParameterValue,
    PubSub,
    property,
    SelectShapeStep,
    ShapeTypes,
    type SnapResult,
    Transaction,
    VisualStates,
} from "@spicy3d/core";
import { captureExtentFaceRef } from "../features/extrudeExtent";
import { evaluateFeature, type ThickenFeatureData } from "../features/feature";
import type { ProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { previewMeshes, showPreviewProblem } from "./featureEditPreview";

export const THICKEN_JOIN_TYPES: readonly I18nKeys[] = [
    "option.command.joinType.arc",
    "option.command.joinType.intersection",
];
export const THICKEN_MODES: readonly I18nKeys[] = [
    "option.command.offsetMode.skin",
    "option.command.offsetMode.pipe",
];

/** The panel's join type / mode as the feature stores them: absent for the defaults. */
export function thickenOptions(
    joinType: I18nKeys,
    mode: I18nKeys,
): Pick<ThickenFeatureData, "joinType" | "mode"> {
    return {
        ...(joinType === "option.command.joinType.intersection" ? { joinType: "intersection" } : {}),
        ...(mode === "option.command.offsetMode.pipe" ? { mode: "pipe" } : {}),
    };
}

/** The stored join type / mode as the panel's combobox keys. */
export function thickenOptionKeys(feature: ThickenFeatureData): { joinType: I18nKeys; mode: I18nKeys } {
    return {
        joinType:
            feature.joinType === "intersection"
                ? "option.command.joinType.intersection"
                : "option.command.joinType.arc",
        mode: feature.mode === "pipe" ? "option.command.offsetMode.pipe" : "option.command.offsetMode.skin",
    };
}

/**
 * Appends a thicken to a parametric body: the user picks the body (or has it selected), then the
 * faces to open — none for a closed hollow, and none for an open shell, which is thickened whole —
 * and confirms. The thickness takes an expression, like an extrude depth; the result is previewed
 * on the body's current shape. One undo step.
 */
@command({ key: "feature.thicken", helpText: "tooltip.feature.thicken", icon: "icon-shell" })
export class ThickenFeatureCommand extends CancelableCommand {
    private body: ParametricBodyNode | undefined;
    private readonly openFaces: { index: number; ref: ProfileRef }[] = [];
    private previewId: number | undefined;
    private ghosted: INodeVisual | undefined;

    @property("option.command.thickness", { unit: LENGTH_UNITS })
    get thickness(): ParameterValue {
        return this.getPrivateValue("thickness", -1);
    }
    set thickness(value: ParameterValue) {
        this.setProperty("thickness", value, () => this.displayPreview());
    }

    @property("option.command.joinType", { combobox: Combobox.from([...THICKEN_JOIN_TYPES]) })
    get joinType(): I18nKeys {
        return this.getPrivateValue("joinType", "option.command.joinType.arc");
    }
    set joinType(value: I18nKeys) {
        this.setProperty("joinType", value, () => this.displayPreview());
    }

    @property("option.command.offsetMode", { combobox: Combobox.from([...THICKEN_MODES]) })
    get mode(): I18nKeys {
        return this.getPrivateValue("mode", "option.command.offsetMode.skin");
    }
    set mode(value: I18nKeys) {
        this.setProperty("mode", value, () => this.displayPreview());
    }

    @property("common.confirm")
    readonly confirm = () => {
        this.controller?.success();
    };

    protected override async executeAsync(): Promise<void> {
        try {
            this.controller = new AsyncController();
            const picked = await new GetOrSelectNodeStep("prompt.select.models", {
                filter: { allow: (node) => node instanceof ParametricBodyNode && node.shape.isOk },
            }).execute(this.document, this.controller);
            const body = picked?.nodes?.[0];
            if (!(body instanceof ParametricBodyNode) || !body.shape.isOk) return;
            this.body = body;
            // Open faces only exist on a solid; an open shell is thickened whole.
            const solid = body.shape.value.findSubShapes(ShapeTypes.solid).length > 0;
            this.displayPreview();
            while (true) {
                this.controller = new AsyncController();
                const pick: SnapResult | undefined = await new SelectShapeStep(
                    ShapeTypes.face,
                    "prompt.select.thickenOpenFaces",
                    {
                        nodeFilter: { allow: (node: INode): boolean => node === body },
                    },
                ).execute(this.document, this.controller);
                if (pick === undefined) {
                    if (this.controller.result?.status !== "success") return;
                    break;
                }
                const data = pick.shapes[0];
                if (data === undefined || data.owner.node !== body) continue;
                if (!solid) {
                    showPreviewProblem(I18n.translate("prompt.thicken.openFacesSolidOnly"));
                    continue;
                }
                this.toggleFace(body, data.indexes[0], data.shape as IFace);
                this.displayPreview();
            }
            this.commit(body);
        } finally {
            showPreviewProblem(undefined);
            this.removePreview();
            this.document.selection.clearSelection();
            this.document.visual.update();
        }
    }

    /** Picking an open face again closes it. */
    private toggleFace(body: ParametricBodyNode, index: number, face: IFace): void {
        const existing = this.openFaces.findIndex((x) => x.index === index);
        if (existing >= 0) {
            this.openFaces.splice(existing, 1);
            return;
        }
        // Body-local, with the face's tracked id — what the feature re-matches on its input.
        const faceId = body.faceIdAt(index);
        this.openFaces.push({ index, ref: captureExtentFaceRef(face, faceId, body.faceIdIsShared(faceId)) });
    }

    private feature(): ThickenFeatureData {
        return {
            id: Id.generate(),
            type: "thicken",
            thickness: this.thickness,
            ...thickenOptions(this.joinType, this.mode),
            ...(this.openFaces.length > 0 ? { openFaces: this.openFaces.map((x) => x.ref) } : {}),
        };
    }

    private commit(body: ParametricBodyNode): void {
        // As the fillet commit: a thickness that no longer resolves would fail the rebuild.
        const resolved = this.resolveParameter(this.thickness, LENGTH_UNITS);
        if (!resolved.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
            return;
        }
        Transaction.execute(this.document, "excute feature.thicken", () => {
            body.setFeaturesEmitShapeChanged([...body.features, this.feature()]);
            this.document.visual.update();
        });
    }

    /** The thickened body over the ghosted original; a failure says why instead. */
    private displayPreview(): void {
        this.removePreview();
        const body = this.body;
        if (body === undefined || !body.shape.isOk) return;
        const shape = evaluateFeature(this.feature(), {
            document: this.document,
            host: body,
            input: body.shape.value,
            scope: this.document.variables.evaluate().scope,
        });
        showPreviewProblem(shape.isOk ? undefined : shape.error);
        if (!shape.isOk) return;
        const meshes = previewMeshes(body, shape.value);
        if (meshes === undefined) return;
        const context = this.document.visual.context;
        const owner = context.getVisual(body) as INodeVisual | undefined;
        if (owner !== undefined) {
            this.document.visual.highlighter.addState(owner, VisualStates.faceTransparent, ShapeTypes.shape);
            this.ghosted = owner;
        }
        this.previewId = context.displayMesh(meshes, { meshOpacity: 1 });
        this.document.visual.update();
    }

    private removePreview(): void {
        if (this.ghosted !== undefined) {
            this.document.visual.highlighter.removeState(
                this.ghosted,
                VisualStates.faceTransparent,
                ShapeTypes.shape,
            );
            this.ghosted = undefined;
        }
        if (this.previewId !== undefined) {
            this.document.visual.context.removeMesh(this.previewId);
            this.previewId = undefined;
        }
    }
}
