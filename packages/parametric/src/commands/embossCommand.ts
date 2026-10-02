// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    Id,
    type IFace,
    type INode,
    type IShape,
    LENGTH_UNITS,
    type ParameterValue,
    pickedTopologyIndex,
    property,
    SelectShapeStep,
    ShapeTypes,
    Transaction,
    type VisualShapeData,
} from "@spicy3d/core";
import { captureEmbossFaceRef } from "../features/emboss";
import { type EmbossFeatureData, evaluateFeature } from "../features/feature";
import { captureProfileRef, type ProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { SELECTED_PROFILE_STATE } from "./extrudeDragStep";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";

/** Capture against the currently displayed input state; mesh indexes are never persisted. */
export function captureEmbossFaces(body: ParametricBodyNode, picked: VisualShapeData[]): ProfileRef[] {
    if (!body.shape.isOk) throw new Error("Emboss requires a valid body");
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    try {
        const indexes = [
            ...new Set(
                picked.map((pick) => {
                    if (pick.owner.node !== body)
                        throw new Error("Emboss target faces must belong to one body");
                    const index = pickedTopologyIndex(pick);
                    if (index === undefined || faces[index] === undefined)
                        throw new Error("Emboss pick has no face topology index");
                    return index;
                }),
            ),
        ];
        return indexes.map((index) => {
            const id = body.faceIdAt(index);
            return captureEmbossFaceRef(faces[index], id, body.faceIdIsShared(id));
        });
    } finally {
        faces.forEach((face) => {
            face.dispose();
        });
    }
}

@command({ key: "feature.emboss", helpText: "tooltip.feature.emboss", icon: "icon-emboss" })
export class EmbossCommand extends CancelableCommand {
    private feature?: EmbossFeatureData;
    private preview?: FeatureChainPreview;
    private previewIds: number[] = [];
    private sourceVisibility = new Set<INode>();
    private pickController?: AsyncController;
    private picking?: Promise<void>;
    private previewValid = false;

    constructor(
        private body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }
    protected override isPropertyCached(): boolean {
        return false;
    }

    @property("option.command.depth", { unit: LENGTH_UNITS })
    get depth(): ParameterValue {
        return this.getPrivateValue("depth", 1);
    }
    set depth(value: ParameterValue) {
        this.setProperty("depth", value, () => this.refreshPreview());
    }
    @property("option.command.deboss")
    get deboss(): boolean {
        return this.getPrivateValue("deboss", false);
    }
    set deboss(value: boolean) {
        this.setProperty("deboss", value, () => this.refreshPreview());
    }
    @property("option.command.embossProfiles")
    readonly pickProfiles = (): Promise<void> =>
        this.pick(async () => {
            const source = await this.selectProfiles();
            if (source && this.feature && !this.isCanceled) {
                this.feature = { ...this.feature, ...source };
                this.showSource(source.sketchId);
            }
        });
    @property("option.command.embossFaces")
    readonly pickFaces = (): Promise<void> =>
        this.pick(async () => {
            const body = this.body;
            if (!body) return;
            const rollback = body.rollbackIndex;
            this.clearPreview();
            try {
                if (this.featureId !== undefined) {
                    const index = body.features.findIndex((feature) => feature.id === this.featureId);
                    if (index < 0 || !body.setRollbackIndex(index))
                        throw new Error("Emboss input could not be rebuilt");
                }
                const target = await this.selectFaces(body);
                if (target && this.feature && !this.isCanceled)
                    this.feature = { ...this.feature, faces: target.faces };
            } finally {
                body.setRollbackIndex(rollback);
                // Rollback may replace cached shapes: rebuild the preview's entering state after restoration.
                if (this.featureId !== undefined)
                    this.preview = new FeatureChainPreview(
                        body,
                        body.features.findIndex((feature) => feature.id === this.featureId),
                    );
            }
        });
    @property("common.confirm")
    readonly confirm = () => {
        if (this.pickController) this.pickController.success();
        else if (this.previewValid) this.controller?.success();
    };
    override async cancel(): Promise<void> {
        this.pickController?.cancel();
        await super.cancel();
    }
    private cancelPick(): void {
        this.pickController?.cancel();
    }
    private newPickController(): AsyncController {
        this.pickController?.dispose();
        this.pickController = new AsyncController();
        return this.pickController;
    }
    private pick(action: () => Promise<void>): Promise<void> {
        if (this.picking || !this.feature) return this.picking ?? Promise.resolve();
        this.picking = action()
            .catch((error) => showPreviewProblem(String(error)))
            .finally(() => {
                this.pickController?.dispose();
                this.pickController = undefined;
                this.picking = undefined;
                if (!this.isCanceled) this.refreshPreview();
            });
        return this.picking;
    }
    private async selectProfiles(): Promise<Pick<EmbossFeatureData, "sketchId" | "profiles"> | undefined> {
        const picked = await new SelectShapeStep(ShapeTypes.face, "prompt.select.embossProfiles", {
            multiple: true,
            nodeFilter: { allow: (node) => node instanceof SketchNode },
            selectedState: SELECTED_PROFILE_STATE,
        }).execute(this.document, this.newPickController());
        if (!picked || this.isCanceled) return undefined;
        const sketch = picked.nodes?.[0];
        if (!(sketch instanceof SketchNode) || picked.shapes.some((shape) => shape.owner.node !== sketch))
            throw new Error("Emboss profiles must belong to one sketch");
        return {
            sketchId: sketch.id,
            profiles: picked.shapes.map((shape) => captureProfileRef(shape.shape as IFace)),
        };
    }
    private async selectFaces(
        host?: ParametricBodyNode,
    ): Promise<{ body: ParametricBodyNode; faces: ProfileRef[] } | undefined> {
        const picked = await new SelectShapeStep(ShapeTypes.face, "prompt.select.embossFaces", {
            multiple: true,
            nodeFilter: { allow: (node) => node instanceof ParametricBodyNode && (!host || host === node) },
        }).execute(this.document, this.newPickController());
        if (!picked || this.isCanceled) return undefined;
        const body = picked.nodes?.[0];
        if (!(body instanceof ParametricBodyNode)) return undefined;
        return { body, faces: captureEmbossFaces(body, picked.shapes) };
    }
    private showSource(id: string): void {
        const source = this.document.modelManager.findNode((node) => node.id === id);
        if (source && source !== this.body) {
            this.sourceVisibility.add(source);
            this.document.visual.context.setVisible(source, true);
        }
    }
    protected override async executeAsync(): Promise<void> {
        try {
            await this.executeSession();
        } finally {
            this.pickController?.cancel();
            this.pickController?.dispose();
            this.pickController = undefined;
            this.clearPreview();
            showPreviewProblem(undefined);
            this.document.selection.clearSelection();
            this.document.visual.update();
        }
    }
    private async executeSession(): Promise<void> {
        if (!this.body) {
            const target = await this.selectFaces();
            if (!target || this.isCanceled) return;
            this.body = target.body;
            const source = await this.selectProfiles();
            if (!source || this.isCanceled) return;
            this.feature = {
                id: Id.generate(),
                type: "emboss",
                ...source,
                faces: target.faces,
                depth: this.depth,
                deboss: this.deboss,
            };
        }
        this.pickController?.dispose();
        this.pickController = undefined;
        const body = this.body;
        const creating = this.featureId === undefined;
        const index = creating
            ? body.features.length
            : body.features.findIndex((feature) => feature.id === this.featureId);
        const feature = creating ? this.feature : body.features[index];
        if (feature?.type !== "emboss") return;
        this.feature = feature;
        this.setProperty("depth", feature.depth);
        this.setProperty("deboss", feature.deboss);
        this.preview = creating ? undefined : new FeatureChainPreview(body, index);
        const controller = new AsyncController();
        this.controller = controller;
        const closeSession = openFeatureEditSession(body);
        this.showSource(feature.sketchId);
        let confirmed = false;
        try {
            this.refreshPreview();
            confirmed = await new Promise<boolean>((resolve) => {
                controller.onCompleted(() => resolve(true));
                controller.onCancelled(() => resolve(false));
                controller.onFailed(() => resolve(false));
            });
        } finally {
            this.cancelPick();
            await this.picking;
            this.clearPreview();
            showPreviewProblem(undefined);
            for (const source of this.sourceVisibility)
                this.document.visual.context.setVisible(source, source.visible && source.parentVisible);
            this.sourceVisibility.clear();
            closeSession();
            this.document.visual.update();
        }
        if (confirmed && this.previewValid && this.feature) {
            // Re-evaluate after asynchronous picks before mutating the document.
            this.refreshPreview();
            if (!this.previewValid) return;
            this.clearPreview();
            if (creating)
                Transaction.execute(this.document, "create emboss", () => {
                    body.setFeaturesEmitShapeChanged([...body.features, this.edited()]);
                    const source = this.document.modelManager.findNode(
                        (node) => node.id === this.feature?.sketchId,
                    );
                    if (source) source.visible = false;
                });
            else commitFeatureEdit(body, this.edited());
        }
    }
    private edited(): EmbossFeatureData {
        return { ...(this.feature as EmbossFeatureData), depth: this.depth, deboss: this.deboss };
    }
    private refreshPreview(): void {
        if (!this.body || !this.feature || this.pickController) return;
        this.clearPreview();
        try {
            const result = this.preview
                ? this.preview.evaluate(this.edited(), false)
                : this.creationPreview();
            this.previewValid = result.error === undefined && result.shape !== undefined;
            showPreviewProblem(result.error, "note" in result ? result.note : undefined);
            const meshes = result.shape && previewMeshes(this.body, result.shape);
            if (meshes) {
                for (const mesh of meshes)
                    this.previewIds.push(
                        this.document.visual.context.displayMesh([mesh], { meshOpacity: 1 }),
                    );
                this.document.visual.context.setVisible(this.body, false);
            }
        } catch (error) {
            this.previewValid = false;
            showPreviewProblem(String(error));
        }
        this.document.visual.update();
    }
    private creationPreview(): { shape?: IShape; error?: string } {
        const body = this.body;
        if (!body?.shape.isOk) return { error: "Emboss requires a valid existing body" };
        const faces = body.shape.value.findSubShapes(ShapeTypes.face),
            edges = body.shape.value.findSubShapes(ShapeTypes.edge);
        try {
            const result = evaluateFeature(this.edited(), {
                document: this.document,
                host: body,
                input: body.shape.value,
                scope: this.document.variables.evaluate().scope,
                tracking: {
                    inputFaceIds: faces.map((_, i) => body.faceIdAt(i) ?? ""),
                    inputEdgeIds: edges.map((_, i) => body.edgeIdAt(i) ?? ""),
                    outputFaceIds: [],
                    outputEdgeIds: [],
                },
            });
            return result.isOk ? { shape: result.value } : { error: result.error };
        } finally {
            for (const shape of [...faces, ...edges]) shape.dispose();
        }
    }
    private clearPreview(): void {
        for (const id of this.previewIds) this.document.visual.context.removeMesh(id);
        this.previewIds = [];
        if (this.body)
            this.document.visual.context.setVisible(this.body, this.body.visible && this.body.parentVisible);
        this.document.visual.update();
    }
}

@command({ key: "feature.editEmboss", icon: "icon-emboss" })
export class EmbossEditCommand extends EmbossCommand {}
registerFeatureEditor("emboss", (body, featureId) => new EmbossEditCommand(body, featureId));
