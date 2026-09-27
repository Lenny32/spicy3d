// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CommandStore,
    command,
    documentLengthUnit,
    GetOrSelectNodeStep,
    GetOrSelectShapeStep,
    type IDocument,
    type IStep,
    MeshNode,
    MultistepCommand,
    PubSub,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";

@command({ key: "inspect.measure", icon: "icon-measureSelect" })
export class InspectMeasureCommand extends MultistepCommand {
    protected override getSteps(): IStep[] {
        return [
            new GetOrSelectShapeStep(
                (ShapeTypes.vertex | ShapeTypes.edge | ShapeTypes.face | ShapeTypes.solid) as ShapeType,
                "prompt.select.shape",
                {
                    multiple: true,
                    nodeFilter: { allow: (node) => node instanceof ShapeNode },
                },
            ),
        ];
    }

    protected override executeMainTask(): void {
        const selected = this.stepDatas[0].shapes;
        if (!selected.length) {
            PubSub.default.pub("showToast", "error.default:{0}", "Select shapes to measure");
            return;
        }
        const sources = selected.map((item) =>
            this.document.analyses.captureSource(item.owner.node as ShapeNode, item.shape),
        );
        const failed = sources.find((source) => !source.isOk);
        if (failed && !failed.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", failed.error);
            return;
        }
        const node = this.document.analyses.add({
            name: "Measure",
            kind: "measure",
            sources: sources.map((source) => source.value),
            settings: { unit: documentLengthUnit(this.document), precision: 3 },
            visible: true,
        });
        PubSub.default.pub("showAnalysisPanel", node);
    }
}

abstract class InspectNodeCommand extends MultistepCommand {
    protected abstract readonly kind: string;
    protected abstract readonly label: string;
    protected abstract readonly defaultSettings: Record<string, unknown>;
    protected readonly minimumSources: number = 1;

    protected override getSteps(): IStep[] {
        return [
            new GetOrSelectNodeStep("prompt.select.shape", {
                multiple: true,
                filter: {
                    allow: (node) =>
                        (node instanceof ShapeNode && node.shape.isOk) ||
                        (this.kind === "meshFaceGroups" && node instanceof MeshNode),
                },
            }),
        ];
    }

    protected override executeMainTask(): void {
        const nodes =
            this.stepDatas[0].nodes?.filter(
                (node) =>
                    node instanceof ShapeNode || (this.kind === "meshFaceGroups" && node instanceof MeshNode),
            ) ?? [];
        if (nodes.length < this.minimumSources) {
            PubSub.default.pub(
                "showToast",
                "error.default:{0}",
                `Select at least ${this.minimumSources} solid bodies`,
            );
            return;
        }
        const node = this.document.analyses.add({
            name: this.label,
            kind: this.kind,
            sources: nodes.map((source) => ({ nodeId: source.id })),
            settings: { ...this.defaultSettings },
            visible: true,
        });
        PubSub.default.pub("showAnalysisPanel", node);
    }
}

@command({ key: "inspect.section", icon: "icon-section" })
export class InspectSectionCommand extends InspectNodeCommand {
    protected readonly kind = "section";
    protected readonly label = "Section Analysis";
    protected readonly defaultSettings = { plane: "xy", offset: 0, rotation: 0, flip: false };

    protected override getSteps(): IStep[] {
        const selectedFace = this.document.selection
            .getSelectedShapes()
            .some((item) => item.shape.shapeType === ShapeTypes.face);
        return selectedFace
            ? [
                  new GetOrSelectShapeStep(ShapeTypes.face, "prompt.select.faces", {
                      nodeFilter: { allow: (node) => node instanceof ShapeNode },
                  }),
              ]
            : super.getSteps();
    }

    protected override executeMainTask(): void {
        const picked = this.stepDatas[0].shapes[0];
        if (!picked) {
            super.executeMainTask();
            return;
        }
        const source = this.document.analyses.captureSource(picked.owner.node as ShapeNode, picked.shape);
        if (!source.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", source.error);
            return;
        }
        const node = this.document.analyses.add({
            name: this.label,
            kind: this.kind,
            sources: [source.value],
            settings: { ...this.defaultSettings, plane: "face" },
            visible: true,
        });
        PubSub.default.pub("showAnalysisPanel", node);
    }
}

@command({ key: "inspect.interference", icon: "icon-checkShape" })
export class InspectInterferenceCommand extends InspectNodeCommand {
    protected readonly kind = "interference";
    protected readonly label = "Interference";
    protected readonly defaultSettings = { tolerance: 1e-6 };
    protected override readonly minimumSources = 2;
}

@command({ key: "inspect.centerOfMass", icon: "icon-measureSelect" })
export class InspectCenterOfMassCommand extends InspectNodeCommand {
    protected readonly kind = "centerOfMass";
    protected readonly label = "Center of Mass";
    protected readonly defaultSettings = { density: 1 };
}

const advancedInspectCommands = [
    { kind: "curvatureComb", label: "Curvature Comb", settings: { sampleCount: 24, scale: 10 } },
    {
        kind: "curvatureMap",
        label: "Curvature Map",
        settings: { mode: "gaussian", minimum: -0.2, maximum: 0.2 },
    },
    {
        kind: "draft",
        label: "Draft Analysis",
        settings: { pullDirection: { x: 0, y: 0, z: 1 }, threshold: 2 },
    },
    {
        kind: "environmentMap",
        label: "Environment Map",
        settings: { environment: "studio", rotation: 0, mirrorFinish: 0.8 },
    },
    { kind: "isocurves", label: "Isocurve Analysis", settings: { count: 10, steps: 96, direction: "both" } },
    { kind: "zebra", label: "Zebra Analysis", settings: { direction: 0, density: 12, contrast: 0.8 } },
    { kind: "accessibility", label: "Accessibility", settings: { approachDirection: { x: 0, y: 0, z: 1 } } },
    { kind: "minimumRadius", label: "Minimum Radius", settings: { radius: 1 } },
    {
        kind: "designAdvice",
        label: "Design Advice",
        settings: {
            minimumDraft: 2,
            minimumRadius: 1,
            minimumWall: 1,
            nominalWall: 2,
            wallVariation: 0.25,
            pullDirection: { x: 0, y: 0, z: 1 },
        },
    },
    {
        kind: "fastenerStack",
        label: "Fastener Stack",
        settings: { axis: { x: 0, y: 0, z: 1 }, nominalLength: 10 },
    },
    { kind: "componentColors", label: "Component Colors", settings: {} },
    { kind: "meshFaceGroups", label: "Mesh Face Groups", settings: {} },
    { kind: "similarComponents", label: "Similar Components", settings: { tolerance: 0.1 } },
] as const;

for (const descriptor of advancedInspectCommands) {
    class AdvancedInspectCommand extends InspectNodeCommand {
        protected readonly kind: string = descriptor.kind;
        protected readonly label: string = descriptor.label;
        protected readonly defaultSettings: Record<string, unknown> = { ...descriptor.settings };

        protected override async executeAsync(): Promise<void> {
            if (descriptor.kind === "componentColors") {
                const existing = this.document.analyses.items.find((item) => item.kind === "componentColors");
                if (existing) {
                    this.document.analyses.update(existing, { visible: !existing.visible });
                    PubSub.default.pub("showAnalysisPanel", existing);
                } else {
                    const node = this.document.analyses.add({
                        name: descriptor.label,
                        kind: descriptor.kind,
                        sources: [],
                        settings: {},
                        visible: true,
                    });
                    PubSub.default.pub("showAnalysisPanel", node);
                }
                return;
            }
            await super.executeAsync();
        }
    }
    CommandStore.registerCommand(AdvancedInspectCommand, {
        key: `inspect.${descriptor.kind}`,
        icon: "icon-checkShape",
    });
}

abstract class InspectLibraryMembershipCommand extends MultistepCommand {
    protected abstract readonly addMembership: boolean;

    protected override getSteps(): IStep[] {
        return [
            new GetOrSelectNodeStep("prompt.select.shape", {
                multiple: true,
                filter: { allow: (node) => node instanceof ShapeNode && node.shape.isOk },
            }),
        ];
    }

    protected override executeMainTask(): void {
        const ids =
            this.stepDatas[0].nodes?.filter((node) => node instanceof ShapeNode).map((node) => node.id) ?? [];
        if (!ids.length) return;
        const doc: IDocument = this.document;
        const prior = Array.isArray(doc.userData?.["inspectLibrary"])
            ? (doc.userData!["inspectLibrary"] as string[])
            : [];
        const next = this.addMembership
            ? [...new Set([...prior, ...ids])]
            : prior.filter((id) => !ids.includes(id));
        Transaction.execute(
            doc,
            this.addMembership ? "add to component library" : "remove from component library",
            () => {
                const set = (value: string[]) => {
                    doc.userData = { ...doc.userData, inspectLibrary: value };
                    for (const opened of this.application.documents) {
                        for (const analysis of opened.analyses.items.filter(
                            (item) => item.kind === "similarComponents",
                        )) {
                            void opened.analyses.evaluate(analysis);
                        }
                    }
                };
                set(next);
                Transaction.add(doc, {
                    name: "component library membership",
                    dispose() {},
                    undo: () => set(prior),
                    redo: () => set(next),
                });
            },
        );
    }
}

@command({ key: "inspect.addToLibrary", icon: "icon-plus" })
export class InspectAddToLibraryCommand extends InspectLibraryMembershipCommand {
    protected readonly addMembership = true;
}

@command({ key: "inspect.removeFromLibrary", icon: "icon-minus" })
export class InspectRemoveFromLibraryCommand extends InspectLibraryMembershipCommand {
    protected readonly addMembership = false;
}
