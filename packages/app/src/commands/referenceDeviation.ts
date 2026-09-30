// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    documentLengthUnit,
    formatMeasure,
    GetOrSelectNodeStep,
    I18n,
    type IDocument,
    MeshDataUtils,
    type MeshDeviationResult,
    MeshNode,
    measureNodeDeviation,
    PubSub,
    property,
    ShapeNode,
} from "@spicy3d/core";
import { div } from "@spicy3d/element";
import style from "./referenceDeviation.module.css";

@command({ key: "measure.referenceDeviation", icon: "icon-measureSelect" })
export class ReferenceDeviationCommand extends CancelableCommand {
    private abort?: AbortController;

    @property("analysis.deviation.samples")
    get sampleCount(): number {
        return this.getPrivateValue("sampleCount", 4096);
    }
    set sampleCount(value: number) {
        this.setPrivateValue("sampleCount", value);
    }

    override async cancel(): Promise<void> {
        this.abort?.abort();
        await super.cancel();
    }

    protected override async executeAsync(): Promise<void> {
        this.abort = new AbortController();
        const document = this.document;
        this.controller = new AsyncController();
        const model = await new GetOrSelectNodeStep("prompt.deviation.model", {
            filter: { allow: (node) => node instanceof ShapeNode },
        }).execute(document, this.controller);
        if (!model?.nodes?.length || this.checkCanceled()) return;
        this.controller = new AsyncController();
        const reference = await new GetOrSelectNodeStep("prompt.deviation.reference", {
            filter: { allow: (node) => node instanceof MeshNode && node.mesh.meshType === "surface" },
        }).execute(document, this.controller);
        if (!reference?.nodes?.length || this.checkCanceled()) return;
        const result = await measureNodeDeviation(
            model.nodes[0] as ShapeNode,
            reference.nodes[0] as MeshNode,
            {
                sampleCount: this.sampleCount,
                signal: this.abort.signal,
            },
        );
        if (this.checkCanceled()) return;
        if (!result.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", result.error);
            return;
        }
        if (document === this.document) showDeviationResult(document, result.value);
    }
}

/** Transient measurements and the worst sampled gap; no AnalysisNode is saved. */
export function showDeviationResult(document: IDocument, result: MeshDeviationResult): void {
    const unit = documentLengthUnit(document);
    const length = (value: number) => formatMeasure(value, 1, unit, { suffix: true, decimals: 6 });
    const content = div(
        { className: style.results },
        div(
            { className: style.row },
            `${I18n.translate("analysis.deviation.mean")}: ${length(result.meanDeviation)}`,
        ),
        div(
            { className: style.row },
            `${I18n.translate("analysis.deviation.rms")}: ${length(result.rmsDeviation)}`,
        ),
        div(
            { className: style.row },
            `${I18n.translate("analysis.deviation.maximum")}: ${length(result.maxSampledDeviation)}`,
        ),
        div(
            { className: style.row },
            `${I18n.translate("analysis.deviation.samples")}: ${result.sampleCount}`,
        ),
        div({ className: style.note }, I18n.translate("analysis.deviation.accuracy")),
    );
    const { point, closestPoint } = result.worstSample;
    const gap = MeshDataUtils.createEdgeMesh(point, closestPoint, 0xff4422, "solid");
    gap.lineWidth = 3;
    const overlay = document.visual.context.displayMesh(
        [
            gap,
            MeshDataUtils.createVertexMesh(point, 7, 0xff4422),
            MeshDataUtils.createVertexMesh(closestPoint, 7, 0x22bb77),
        ],
        { onTop: true },
    );
    document.visual.update();
    let closed = false;
    const cleanup = () => {
        if (closed) return;
        closed = true;
        document.visual.context.removeMesh(overlay);
        document.visual.update();
        PubSub.default.remove("documentClosed", onDocumentClosed);
    };
    const onDocumentClosed = (closing: IDocument) => {
        if (closing === document) cleanup();
    };
    PubSub.default.sub("documentClosed", onDocumentClosed);
    PubSub.default.pub("showDialog", "command.measure.referenceDeviation", content, [
        { content: "common.confirm", onclick: cleanup },
        { content: "common.cancel", onclick: cleanup },
    ]);
}
