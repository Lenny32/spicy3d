// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    Continuities,
    type Continuity,
    command,
    I18n,
    Id,
    type IFace,
    type IShape,
    Matrix4,
    PubSub,
    property,
    SelectShapeStep,
    type ShapeMeshData,
    type ShapeType,
    ShapeTypes,
    Transaction,
    VisualConfig,
} from "@spicy3d/core";
import { evaluateFeature, type LoftFeatureData, type LoftSection } from "../features/feature";
import { resolveProfiles } from "../features/profileBuilder";
import { captureProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { SELECTED_PROFILE_STATE } from "./extrudeDragStep";
import { showPreviewProblem } from "./featureEditPreview";
import { pickGuidedLoftPath } from "./guidedLoftPicking";

/**
 * Creates a parametric body lofted through sketch profiles: the user picks one profile per
 * section, in loft order, and confirms. Every section stays a live reference to its sketch.
 */
@command({ key: "feature.loft", helpText: "tooltip.feature.loft", icon: "icon-loft" })
export class LoftFeatureCommand extends CancelableCommand {
    private readonly sections: { section: LoftSection; sketch: SketchNode; shape: IShape }[] = [];
    private visual: number | undefined;
    private spine: NonNullable<LoftFeatureData["guided"]>["spine"] | undefined;
    private boundary: NonNullable<LoftFeatureData["guided"]>["boundary"] | undefined;
    private pickController: AsyncController | undefined;
    private choosingGuides = false;
    private valid = false;

    @property("option.command.isSolid")
    get solid() {
        return this.getPrivateValue("solid", true);
    }
    set solid(value: boolean) {
        this.setProperty("solid", value, () => this.displayPreview());
    }

    @property("option.command.isRuled")
    get ruled() {
        return this.getPrivateValue("ruled", false);
    }
    set ruled(value: boolean) {
        this.setProperty("ruled", value, () => this.displayPreview());
    }

    @property("option.command.continuity", {
        dependencies: [{ property: "ruled", value: false }],
        combobox: Combobox.from([...Continuities]),
    })
    get continuity(): Continuity {
        return this.getPrivateValue("continuity", "c2");
    }
    set continuity(value: Continuity) {
        this.setProperty("continuity", value, () => this.displayPreview());
    }

    @property("loft.guided")
    get guided() {
        return this.getPrivateValue("guided", false);
    }
    set guided(value: boolean) {
        this.setProperty("guided", value, () => this.displayPreview());
    }

    @property("loft.pickSpine", { dependencies: [{ property: "guided", value: true }] })
    readonly pickSpine = () => this.repick("spine");
    @property("loft.pickBoundary", { dependencies: [{ property: "guided", value: true }] })
    readonly pickBoundary = () => this.repick("boundary");

    private async repick(role: "spine" | "boundary"): Promise<void> {
        if (!this.choosingGuides || this.pickController || this.controller?.result !== undefined) return;
        const controller = new AsyncController();
        this.pickController = controller;
        try {
            const result = await pickGuidedLoftPath(
                this.document,
                controller,
                role === "spine" ? "loft.spine" : "loft.boundary",
            );
            if (result?.isOk) {
                if (role === "spine") this.spine = result.value;
                else this.boundary = result.value;
            } else if (result) showPreviewProblem(result.error);
        } finally {
            this.pickController = undefined;
            if (this.controller?.result === undefined) this.displayPreview();
        }
    }

    @property("common.confirm")
    readonly confirm = () => {
        if (this.pickController) this.pickController.success();
        else if (!this.choosingGuides || !this.guided || this.valid) this.controller?.success();
    };

    protected override async executeAsync(): Promise<void> {
        try {
            while (true) {
                this.controller = new AsyncController();
                const picked = await new SelectShapeStep(
                    (ShapeTypes.face | ShapeTypes.edge) as ShapeType,
                    "prompt.select.loftSection",
                    {
                        nodeFilter: { allow: (node) => node instanceof SketchNode },
                        shapeFilter: {
                            allow: (shape) =>
                                shape.shapeType === ShapeTypes.face
                                    ? (shape as IFace).surface().isPlanar()
                                    : !this.solid && !this.guided,
                        },
                        selectedState: SELECTED_PROFILE_STATE,
                    },
                ).execute(this.document, this.controller);
                if (picked === undefined) {
                    if (this.controller.result?.status !== "success") return;
                    break;
                }
                const sketch = picked.nodes?.[0];
                const shape = picked.shapes[0]?.shape;
                if (!(sketch instanceof SketchNode) || shape === undefined) continue;
                if (shape.shapeType === ShapeTypes.edge) {
                    const profiles = resolveProfiles(sketch);
                    if (profiles.isOk && profiles.value.length > 1) {
                        showPreviewProblem(I18n.translate("parametric.loft.selectProfileFace"));
                        continue;
                    }
                }
                this.sections.push({
                    section: {
                        sketchId: sketch.id,
                        ...(shape.shapeType === ShapeTypes.face
                            ? { profile: captureProfileRef(shape as IFace) }
                            : {}),
                    },
                    sketch,
                    shape,
                });
                this.displayPreview();
            }
            if (this.sections.length < 2) return;
            if (this.guided) {
                this.choosingGuides = true;
                const controller = new AsyncController();
                this.controller = controller;
                controller.onCancelled(() => this.pickController?.cancel());
                const completion = new Promise<boolean>((resolve) => {
                    controller.onCompleted(() => resolve(true));
                    controller.onCancelled(() => resolve(false));
                    controller.onFailed(() => resolve(false));
                });
                await this.repick("spine");
                if (controller.result === undefined) await this.repick("boundary");
                this.displayPreview();
                if (!(await completion)) return;
            }
            this.commit();
        } finally {
            showPreviewProblem(undefined);
            this.removePreview();
            this.document.selection.clearSelection();
            this.document.visual.update();
        }
    }

    private feature(): LoftFeatureData {
        return {
            id: Id.generate(),
            type: "loft",
            sections: this.sections.map(({ section }) => section),
            ...(this.solid ? {} : { solid: false }),
            ...(this.ruled ? { ruled: true } : {}),
            ...(this.ruled || this.continuity === "c2" ? {} : { continuity: this.continuity }),
            ...(this.guided && this.spine && this.boundary
                ? { guided: { spine: this.spine, boundary: this.boundary } }
                : {}),
        };
    }

    /** Adds the body and hides the section sketches it consumes, as one undo step. */
    private commit(): void {
        if (this.guided && (!this.spine || !this.boundary || !this.valid)) return;
        const node = new ParametricBodyNode({ document: this.document, features: [this.feature()] });
        const shape = node.shape;
        if (!shape.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", shape.error);
            node.dispose();
            return;
        }
        Transaction.execute(this.document, "excute feature.loft", () => {
            this.document.modelManager.addNode(node);
            for (const { sketch } of this.sections) sketch.visible = false;
        });
    }

    /** The picked sections outlined, and the loft through them once there are two. */
    private displayPreview(): void {
        this.removePreview();
        this.valid = false;
        // Nothing picked yet (an option set before the first pick): nothing to show.
        if (this.sections.length === 0) return;
        const meshes: ShapeMeshData[] = [];
        for (const { shape } of this.sections) {
            const edges = shape.mesh.edges;
            if (edges === undefined) continue;
            const highlighted: typeof edges = {
                ...edges,
                color: VisualConfig.selectedEdgeColor,
                lineWidth: 3,
            };
            meshes.push(highlighted);
        }
        let problem: string | undefined;
        if (this.guided && (!this.spine || !this.boundary)) {
            problem = "Select a main spine and boundary guide for the guided loft";
        } else if (this.sections.length >= 2) {
            const shape = evaluateFeature(this.feature(), {
                document: this.document,
                host: { id: "", worldTransform: () => Matrix4.identity() },
                scope: this.document.variables.evaluate().scope,
            });
            if (shape.isOk) {
                this.valid = true;
                const faces = shape.value.mesh.faces;
                if (faces !== undefined) meshes.push(faces);
                shape.value.dispose();
            } else {
                problem = shape.error;
            }
        }
        showPreviewProblem(problem);
        this.visual = this.document.visual.context.displayMesh(meshes, { meshOpacity: 0.5 });
        this.document.visual.update();
    }

    private removePreview(): void {
        if (this.visual === undefined) return;
        this.document.visual.context.removeMesh(this.visual);
        this.visual = undefined;
    }
}
