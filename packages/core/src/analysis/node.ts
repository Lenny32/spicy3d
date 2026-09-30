// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Id } from "../foundation";
import { FolderNode, Node } from "../model";
import { serializable } from "../serialize";
import type { AnalysisDefinition, AnalysisSourceRef, AnalysisStatus } from "./types";

/** Icon of each analysis kind: its inspect command's and its result node's. */
export const ANALYSIS_ICONS: Readonly<Record<string, string>> = {
    measure: "icon-measure",
    section: "icon-sectionAnalysis",
    interference: "icon-interference",
    centerOfMass: "icon-centerOfMass",
    curvatureComb: "icon-curvatureComb",
    curvatureMap: "icon-curvatureMap",
    draft: "icon-draftAnalysis",
    environmentMap: "icon-environmentMap",
    isocurves: "icon-isocurves",
    zebra: "icon-zebra",
    accessibility: "icon-accessibility",
    minimumRadius: "icon-minimumRadius",
    designAdvice: "icon-designAdvice",
    fastenerStack: "icon-fastenerStack",
    componentColors: "icon-componentColors",
    meshFaceGroups: "icon-meshFaceGroups",
    similarComponents: "icon-similarComponents",
};

@serializable()
export class AnalysisGroup extends FolderNode {
    override get icon(): string {
        return "icon-analysis";
    }
}

@serializable<AnalysisNode>({
    serialize: (node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        sourcesJson: JSON.stringify(node.sources),
        settingsJson: JSON.stringify(node.settings),
        visible: node.visible,
    }),
})
export class AnalysisNode extends Node {
    readonly kind: string;

    get icon(): string {
        return ANALYSIS_ICONS[this.kind] ?? "icon-analysis";
    }

    get sources(): AnalysisSourceRef[] {
        return this.getPrivateValue("sources", []);
    }
    set sources(value: AnalysisSourceRef[]) {
        this.setProperty("sources", value);
    }

    get settings(): Record<string, unknown> {
        return this.getPrivateValue("settings", {});
    }
    set settings(value: Record<string, unknown>) {
        this.setProperty("settings", value);
    }

    get status(): AnalysisStatus {
        return this.getPrivateValue("status", "idle");
    }
    set status(value: AnalysisStatus) {
        const oldValue = this.status;
        this.setPrivateValue("status", value);
        this.emitPropertyChanged("status", oldValue);
    }

    get error(): string | undefined {
        return this.getPrivateValue("error");
    }
    set error(value: string | undefined) {
        const oldValue = this.error;
        this.setPrivateValue("error", value);
        this.emitPropertyChanged("error", oldValue);
        this.emitPropertyChanged("warningCount", this.warningCount);
    }

    get warningCount(): number {
        return this.error ? 1 : 0;
    }
    get warningTooltip(): string {
        return this.error ?? "";
    }

    constructor(
        options: Partial<AnalysisDefinition> & {
            document: IDocument;
            kind: string;
            name: string;
            sourcesJson?: string;
            settingsJson?: string;
        },
    ) {
        super(options.document, options.name, options.id ?? Id.generate());
        this.kind = options.kind;
        this.setPrivateValue(
            "sources",
            options.sourcesJson ? JSON.parse(options.sourcesJson) : (options.sources ?? []),
        );
        this.setPrivateValue(
            "settings",
            options.settingsJson ? JSON.parse(options.settingsJson) : (options.settings ?? {}),
        );
        if (options.visible !== undefined) this.setPrivateValue("visible", options.visible);
    }

    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}
}
