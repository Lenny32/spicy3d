// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AnalysisNode,
    EditableShapeNode,
    I18n,
    type I18nKeys,
    Id,
    Mesh,
    MeshNode,
    ShapeNode,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import { showFloatPanel } from "../floatPanel";
import style from "./analysisPanel.module.css";

const fields: Record<
    string,
    Array<{
        key: string;
        label: string;
        type: "number" | "checkbox" | "select" | "vector";
        options?: string[];
    }>
> = {
    measure: [
        { key: "precision", label: "Decimal places", type: "number" },
        { key: "unit", label: "Units", type: "select", options: ["mm", "cm", "m", "in"] },
    ],
    section: [
        { key: "plane", label: "Plane", type: "select", options: ["xy", "yz", "zx", "face"] },
        { key: "offset", label: "Offset (mm)", type: "number" },
        { key: "rotation", label: "Rotation (degrees)", type: "number" },
        { key: "flip", label: "Flip retained side", type: "checkbox" },
    ],
    interference: [{ key: "tolerance", label: "Volume tolerance (mm³)", type: "number" }],
    centerOfMass: [{ key: "density", label: "Uniform density (g/mm³)", type: "number" }],
    curvatureComb: [
        { key: "sampleCount", label: "Samples per edge", type: "number" },
        { key: "scale", label: "Comb scale", type: "number" },
    ],
    curvatureMap: [
        { key: "mode", label: "Curvature mode", type: "select", options: ["gaussian", "minimum", "maximum"] },
        { key: "minimum", label: "Color range minimum", type: "number" },
        { key: "maximum", label: "Color range maximum", type: "number" },
    ],
    draft: [
        { key: "pullDirection", label: "Pull direction (x,y,z)", type: "vector" },
        { key: "threshold", label: "Draft threshold (°)", type: "number" },
    ],
    environmentMap: [
        { key: "environment", label: "Environment", type: "select", options: ["studio", "softbox"] },
        { key: "rotation", label: "Rotation (°)", type: "number" },
        { key: "mirrorFinish", label: "Mirror finish", type: "number" },
    ],
    isocurves: [
        { key: "count", label: "Curve count", type: "number" },
        { key: "steps", label: "Samples per curve", type: "number" },
        { key: "direction", label: "Direction", type: "select", options: ["u", "v", "both"] },
        { key: "combScale", label: "Comb scale", type: "number" },
    ],
    zebra: [
        { key: "direction", label: "Band direction (°)", type: "number" },
        { key: "density", label: "Band density", type: "number" },
        { key: "contrast", label: "Contrast", type: "number" },
    ],
    accessibility: [
        { key: "approachDirection", label: "Approach direction (x,y,z)", type: "vector" },
        { key: "resolution", label: "Samples per triangle edge", type: "number" },
    ],
    minimumRadius: [{ key: "radius", label: "Minimum concave radius (mm)", type: "number" }],
    designAdvice: [
        { key: "minimumDraft", label: "Minimum draft (°)", type: "number" },
        { key: "minimumRadius", label: "Minimum radius (mm)", type: "number" },
        { key: "minimumWall", label: "Minimum wall thickness (mm)", type: "number" },
        { key: "nominalWall", label: "Nominal wall thickness (mm)", type: "number" },
        { key: "wallVariation", label: "Permitted wall variation (fraction)", type: "number" },
        { key: "pullDirection", label: "Pull direction (x,y,z)", type: "vector" },
    ],
    fastenerStack: [
        { key: "nominalLength", label: "Nominal length (mm)", type: "number" },
        { key: "threadLength", label: "Threaded length (mm)", type: "number" },
        { key: "minEngagement", label: "Minimum engagement (mm)", type: "number" },
        { key: "maxEngagement", label: "Maximum engagement (mm)", type: "number" },
        { key: "clearanceMin", label: "Minimum clearance (mm)", type: "number" },
        { key: "clearanceMax", label: "Maximum clearance (mm)", type: "number" },
        { key: "alignmentTolerance", label: "Radial alignment tolerance (mm)", type: "number" },
        { key: "angleTolerance", label: "Angular alignment tolerance (°)", type: "number" },
        { key: "tappedDepth", label: "Tapped hole depth (mm)", type: "number" },
    ],
    similarComponents: [{ key: "scaleInvariant", label: "Ignore uniform scale", type: "checkbox" }],
};

export class AnalysisPanel extends HTMLElement {
    private readonly results = document.createElement("section");
    private selectionFeedback?: HTMLElement;
    constructor(readonly node: AnalysisNode) {
        super();
        this.className = style.panel;
        this.results.className = style.results;
    }

    connectedCallback(): void {
        this.node.onPropertyChanged(this.onNodeChanged);
        if (this.node.kind === "measure")
            this.node.document.selection.onShapeChanged.sub(this.onSelectionChanged);
        this.addEventListener("focusout", this.onFocusOut);
        this.render();
    }

    disconnectedCallback(): void {
        this.node.removePropertyChanged(this.onNodeChanged);
        if (this.node.kind === "measure")
            this.node.document.selection.onShapeChanged.remove(this.onSelectionChanged);
        this.removeEventListener("focusout", this.onFocusOut);
    }

    private readonly onNodeChanged = (property: string) => {
        if (property === "status" || property === "error") this.refreshResults();
        if (
            ["name", "visible", "settings", "sources"].includes(property) &&
            !this.contains(document.activeElement)
        )
            this.render();
    };

    private readonly onFocusOut = () => {
        setTimeout(() => {
            if (this.isConnected && !this.contains(document.activeElement)) this.render();
        }, 0);
    };

    private readonly onSelectionChanged = () => {
        const error = this.updateMeasureSelection();
        if (this.selectionFeedback) this.selectionFeedback.textContent = error ?? "";
    };

    private updateMeasureSelection(): string | undefined {
        const picked = this.node.document.selection.getSelectedShapes();
        if (!picked.length) return "Select geometry in the viewport first";
        const references = picked.map((item) =>
            item.owner.node instanceof ShapeNode
                ? this.node.document.analyses.captureSource(item.owner.node, item.shape)
                : undefined,
        );
        if (references.some((item) => item === undefined))
            return "Only inspectable shape geometry can be measured";
        const failed = references.find((item) => !item?.isOk);
        if (failed && !failed.isOk) return failed.error;
        const sources = references.flatMap((item) => (item?.isOk ? [item.value] : []));
        if (JSON.stringify(sources) !== JSON.stringify(this.node.sources)) {
            this.node.document.analyses.update(this.node, { sources });
        }
        return undefined;
    }

    private render(): void {
        this.replaceChildren();
        const manager = this.node.document.analyses;
        const name = document.createElement("input");
        name.ariaLabel = I18n.translate("analysis.panel.name");
        name.value = this.node.name;
        name.onchange = () => manager.update(this.node, { name: name.value.trim() || this.node.name });
        this.append(this.row(I18n.translate("analysis.panel.name"), name));

        const visible = document.createElement("input");
        visible.type = "checkbox";
        visible.checked = this.node.visible;
        visible.onchange = () => manager.update(this.node, { visible: visible.checked });
        this.append(this.row(I18n.translate("analysis.panel.visible"), visible));

        for (const field of fields[this.node.kind] ?? []) {
            const fieldLabel = I18n.translate(`analysis.field.${field.key}` as I18nKeys);
            const input = document.createElement(field.type === "select" ? "select" : "input") as
                | HTMLInputElement
                | HTMLSelectElement;
            if (input instanceof HTMLInputElement) input.type = field.type === "vector" ? "text" : field.type;
            if (field.options && input instanceof HTMLSelectElement) {
                for (const value of field.options) {
                    const option = document.createElement("option");
                    option.value = value;
                    option.textContent = value;
                    input.append(option);
                }
            }
            const current = this.node.settings[field.key];
            if (
                (field.key === "pullDirection" || field.key === "approachDirection") &&
                Number.isInteger(this.node.settings["directionSourceIndex"])
            )
                input.disabled = true;
            if (input instanceof HTMLInputElement && field.type === "checkbox")
                input.checked = current === true;
            else if (
                field.type === "vector" &&
                current &&
                typeof current === "object" &&
                "x" in current &&
                "y" in current &&
                "z" in current
            ) {
                input.value = `${current.x}, ${current.y}, ${current.z}`;
            } else input.value = String(current ?? "");
            input.ariaLabel = fieldLabel;
            input.onchange = () => {
                if (
                    field.type === "number" &&
                    input.value.trim() === "" &&
                    [
                        "threadLength",
                        "minEngagement",
                        "maxEngagement",
                        "clearanceMin",
                        "clearanceMax",
                        "tappedDepth",
                    ].includes(field.key)
                ) {
                    const settings = { ...this.node.settings };
                    delete settings[field.key];
                    manager.update(this.node, { settings });
                    return;
                }
                const value =
                    field.type === "checkbox"
                        ? (input as HTMLInputElement).checked
                        : field.type === "number"
                          ? Number(input.value)
                          : field.type === "vector"
                            ? this.parseVector(input.value)
                            : input.value;
                if (value === undefined) {
                    input.setCustomValidity(I18n.translate("analysis.panel.invalidVector"));
                    input.reportValidity();
                    return;
                }
                input.setCustomValidity("");
                manager.update(this.node, { settings: { ...this.node.settings, [field.key]: value } });
            };
            this.append(this.row(fieldLabel, input));
        }

        if (this.node.kind === "measure") {
            const useSelection = document.createElement("button");
            useSelection.textContent = I18n.translate("analysis.panel.measureSelection");
            useSelection.onclick = () => {
                const error = this.updateMeasureSelection();
                if (error) {
                    useSelection.setCustomValidity(error);
                    useSelection.reportValidity();
                } else useSelection.setCustomValidity("");
            };
            this.append(useSelection);
            this.selectionFeedback = document.createElement("span");
            this.selectionFeedback.setAttribute("role", "status");
            this.append(this.selectionFeedback);
        }

        if (this.node.kind === "centerOfMass") {
            for (const source of this.node.sources) {
                const sourceNode = this.node.document.modelManager.findNode(
                    (candidate) => candidate.id === source.nodeId,
                );
                const input = document.createElement("input");
                input.type = "number";
                input.min = "0";
                input.step = "any";
                input.value = String(
                    (this.node.settings["densities"] as Record<string, number> | undefined)?.[
                        source.nodeId
                    ] ??
                        this.node.settings["density"] ??
                        1,
                );
                input.ariaLabel = `${sourceNode?.name ?? source.nodeId} density`;
                input.onchange = () => {
                    const value = Number(input.value);
                    if (!Number.isFinite(value) || value <= 0) {
                        input.setCustomValidity(I18n.translate("analysis.panel.invalidDensity"));
                        input.reportValidity();
                        return;
                    }
                    input.setCustomValidity("");
                    const densities = {
                        ...(this.node.settings["densities"] as Record<string, number> | undefined),
                        [source.nodeId]: value,
                    };
                    manager.update(this.node, { settings: { ...this.node.settings, densities } });
                };
                this.append(
                    this.row(
                        I18n.translate("analysis.panel.densityBody", sourceNode?.name ?? source.nodeId),
                        input,
                    ),
                );
            }
        }
        if (["draft", "accessibility"].includes(this.node.kind)) this.renderDirectionSource();
        if (this.node.kind === "accessibility") this.renderObstructionSources();
        if (this.node.kind === "fastenerStack") this.renderFastenerMembers();
        if (this.node.kind === "meshFaceGroups") this.renderMeshGroupEditor();

        this.append(this.results);
        this.refreshResults();

        const remove = document.createElement("button");
        remove.textContent = I18n.translate("analysis.panel.delete");
        remove.onclick = () => manager.remove(this.node);
        this.append(remove);
    }

    private refreshResults(): void {
        this.results.replaceChildren();
        const manager = this.node.document.analyses;

        const state = document.createElement("div");
        state.textContent = this.node.error ?? this.node.status;
        state.setAttribute("role", this.node.error ? "alert" : "status");
        this.results.append(state);

        for (const entry of manager.result(this.node)?.legend ?? []) {
            const legend = document.createElement("div");
            legend.textContent = `${entry.label}${entry.value === undefined ? "" : `: ${entry.value}`}`;
            if (entry.color !== undefined) {
                const swatch = document.createElement("span");
                swatch.className = style.swatch;
                swatch.style.backgroundColor = `#${entry.color.toString(16).padStart(6, "0")}`;
                legend.prepend(swatch);
            }
            this.results.append(legend);
        }

        for (const [index, row] of (manager.result(this.node)?.rows ?? []).entries()) {
            const item = document.createElement("div");
            item.className = style.resultRow;
            const select = document.createElement("button");
            select.textContent = `${row.label}: ${row.value ?? ""}`;
            select.ariaLabel = `Select ${row.label}`;
            item.append(select);
            if (row.sourceIds?.length) {
                select.onclick = () => {
                    manager.selectResultRow(this.node, index);
                    const sources = row
                        .sourceIds!.map((id) =>
                            this.node.document.modelManager.findNode((node) => node.id === id),
                        )
                        .filter((node) => node !== undefined);
                    this.node.document.selection.setSelectedNodes(sources, false);
                };
            } else {
                select.onclick = () => manager.selectResultRow(this.node, index);
            }
            const copy = document.createElement("button");
            copy.textContent = I18n.translate("analysis.panel.copy");
            copy.ariaLabel = `Copy ${row.label}`;
            copy.onclick = () =>
                void navigator.clipboard.writeText(row.value ?? "").catch((error) => {
                    state.textContent = `Copy failed: ${String(error)}`;
                    state.setAttribute("role", "alert");
                });
            item.append(copy);
            if (row.documentId && row.nodeId) {
                const open = document.createElement("button");
                open.textContent = I18n.translate("analysis.panel.open");
                open.ariaLabel = `Open ${row.label}`;
                open.onclick = () =>
                    void this.openLibraryResult(row.documentId!).catch((error) => {
                        state.textContent = String(error);
                        state.setAttribute("role", "alert");
                    });
                const insert = document.createElement("button");
                insert.textContent = I18n.translate("analysis.panel.insert");
                insert.ariaLabel = `Insert ${row.label}`;
                insert.onclick = () => {
                    try {
                        this.insertLibraryResult(row.documentId!, row.nodeId!);
                    } catch (error) {
                        state.textContent = String(error);
                        state.setAttribute("role", "alert");
                    }
                };
                item.append(open, insert);
            }
            if (this.node.kind === "interference" && row.sourceIds?.length === 2 && row.overlays?.length) {
                const extract = document.createElement("button");
                extract.textContent = I18n.translate("analysis.panel.extract");
                extract.onclick = () => {
                    try {
                        this.extractInterference(row.sourceIds![0], row.sourceIds![1]);
                    } catch (error) {
                        state.textContent = String(error);
                        state.setAttribute("role", "alert");
                    }
                };
                item.append(extract);
            }
            this.results.append(item);
        }
    }

    private row(label: string, input: HTMLElement): HTMLElement {
        const row = document.createElement("label");
        row.textContent = label;
        row.className = style.row;
        row.append(input);
        return row;
    }

    private parseVector(value: string): { x: number; y: number; z: number } | undefined {
        const components = value.split(",").map((part) => Number(part.trim()));
        return components.length === 3 && components.every(Number.isFinite)
            ? { x: components[0], y: components[1], z: components[2] }
            : undefined;
    }

    private renderDirectionSource(): void {
        const selected = Number(this.node.settings["directionSourceIndex"]);
        const source = Number.isInteger(selected) ? this.node.sources[selected] : undefined;
        const label = document.createElement("span");
        label.textContent = I18n.translate(
            "analysis.panel.directionReference",
            source
                ? (this.node.document.modelManager.findNode((item) => item.id === source.nodeId)?.name ??
                      source.nodeId)
                : I18n.translate("analysis.panel.enteredVector"),
        );
        this.append(label);
        const use = document.createElement("button");
        use.textContent = I18n.translate("analysis.panel.useDirection");
        use.onclick = () => {
            const selectedShape = this.node.document.selection.getSelectedShapes()[0];
            if (
                !selectedShape ||
                !(selectedShape.owner.node instanceof ShapeNode) ||
                (selectedShape.shape.shapeType !== ShapeTypes.edge &&
                    selectedShape.shape.shapeType !== ShapeTypes.face)
            ) {
                label.textContent = "Select one edge or planar face in the viewport first";
                return;
            }
            const captured = this.node.document.analyses.captureSource(
                selectedShape.owner.node,
                selectedShape.shape,
            );
            if (!captured.isOk) {
                label.textContent = captured.error;
                return;
            }
            const hadPrevious =
                Number.isInteger(selected) && selected >= 0 && selected < this.node.sources.length;
            const previous = this.node.sources.filter((_, index) => !hadPrevious || index !== selected);
            const index = previous.length;
            const remap = (value: unknown) =>
                Array.isArray(value)
                    ? value.flatMap((entry) => {
                          if (!Number.isInteger(entry) || entry === selected) return [];
                          return [hadPrevious && entry > selected ? entry - 1 : entry];
                      })
                    : value;
            this.node.document.analyses.update(this.node, {
                sources: [...previous, captured.value],
                settings: {
                    ...this.node.settings,
                    directionSourceIndex: index,
                    directionSourceId: captured.value.nodeId,
                    directionSourceKind: selectedShape.shape.shapeType === ShapeTypes.edge ? "edge" : "face",
                    obstructionSourceIndexes: remap(this.node.settings["obstructionSourceIndexes"]),
                    targetSourceIndexes: remap(this.node.settings["targetSourceIndexes"]),
                },
            });
            this.render();
        };
        const reverse = document.createElement("input");
        reverse.type = "checkbox";
        reverse.checked = this.node.settings["directionReverse"] === true;
        reverse.disabled = !source;
        reverse.onchange = () =>
            this.node.document.analyses.update(this.node, {
                settings: { ...this.node.settings, directionReverse: reverse.checked },
            });
        this.append(use, this.row(I18n.translate("analysis.panel.reverseDirection"), reverse));
        if (source) {
            const clear = document.createElement("button");
            clear.textContent = I18n.translate("analysis.panel.clearDirection");
            clear.onclick = () => {
                const sources = this.node.sources.filter((_, index) => index !== selected);
                const remap = (value: unknown) =>
                    Array.isArray(value)
                        ? value.flatMap((entry) => {
                              if (!Number.isInteger(entry) || entry === selected) return [];
                              return [entry > selected ? entry - 1 : entry];
                          })
                        : value;
                const settings: Record<string, unknown> = {
                    ...this.node.settings,
                    obstructionSourceIndexes: remap(this.node.settings["obstructionSourceIndexes"]),
                    targetSourceIndexes: remap(this.node.settings["targetSourceIndexes"]),
                };
                delete settings["directionSourceIndex"];
                delete settings["directionSourceId"];
                delete settings["directionSourceKind"];
                delete settings["directionReverse"];
                this.node.document.analyses.update(this.node, { sources, settings });
                this.render();
            };
            this.append(clear);
        }
    }

    private renderObstructionSources(): void {
        const indexes = this.node.settings["obstructionSourceIndexes"] as number[] | undefined;
        this.node.sources.forEach((source, index) => {
            if (index === this.node.settings["directionSourceIndex"]) return;
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = indexes?.includes(index) ?? false;
            input.onchange = () => {
                const current = this.node.settings["obstructionSourceIndexes"] as number[] | undefined;
                const next = this.node.sources
                    .map((_, sourceIndex) => sourceIndex)
                    .filter(
                        (sourceIndex) =>
                            sourceIndex !== this.node.settings["directionSourceIndex"] &&
                            (sourceIndex === index ? input.checked : current?.includes(sourceIndex)),
                    );
                this.node.document.analyses.update(this.node, {
                    settings: { ...this.node.settings, obstructionSourceIndexes: next },
                });
            };
            const name =
                this.node.document.modelManager.findNode((node) => node.id === source.nodeId)?.name ??
                source.nodeId;
            this.append(this.row(I18n.translate("analysis.panel.obstruction", name), input));
        });
    }

    private async openLibraryResult(documentId: string): Promise<void> {
        const application = this.node.document.application;
        const view = application.views.find((candidate) => candidate.document.id === documentId);
        if (view) application.activeView = view;
        else await application.openDocument(documentId);
    }

    private insertLibraryResult(documentId: string, nodeId: string): void {
        const document = this.node.document;
        const sourceDocument = [...document.application.documents].find(
            (candidate) => candidate.id === documentId,
        );
        const source = sourceDocument?.analyses.resolveSource({ nodeId });
        if (!source?.isOk || !source.value.shape)
            throw new Error("Library source is unavailable; open its document first");
        try {
            const shape = source.value.shape.transformedMul(source.value.worldTransform);
            const copy = new EditableShapeNode({ document, name: `${source.value.node.name}_copy`, shape });
            Transaction.execute(document, "insert similar component", () =>
                document.modelManager.rootNode.add(copy),
            );
        } finally {
            source.value.dispose();
        }
    }

    private extractInterference(firstId: string, secondId: string): void {
        const document = this.node.document;
        const first = document.analyses.resolveSource({ nodeId: firstId });
        if (!first.isOk || !first.value.shape) throw new Error("First overlap body is unavailable");
        const second = document.analyses.resolveSource({ nodeId: secondId });
        if (!second.isOk || !second.value.shape) {
            first.value.dispose();
            throw new Error("Second overlap body is unavailable");
        }
        try {
            const a = first.value.shape.transformedMul(first.value.worldTransform);
            try {
                const b = second.value.shape.transformedMul(second.value.worldTransform);
                try {
                    const common = shapeFactory.booleanCommon([a], [b]);
                    if (!common.isOk) throw new Error(common.error);
                    const mass = common.value.inspectionMass?.();
                    if (!mass?.isOk || mass.value.volume <= Number(this.node.settings["tolerance"] ?? 0)) {
                        common.value.dispose();
                        throw new Error("This pair has no extractable volumetric overlap");
                    }
                    try {
                        const copy = new EditableShapeNode({
                            document,
                            name: "Overlap",
                            shape: common.value,
                        });
                        Transaction.execute(document, "extract interference", () =>
                            document.modelManager.rootNode.add(copy),
                        );
                    } catch (error) {
                        common.value.dispose();
                        throw error;
                    }
                } finally {
                    b.dispose();
                }
            } finally {
                a.dispose();
            }
        } finally {
            first.value.dispose();
            second.value.dispose();
        }
    }

    private renderFastenerMembers(): void {
        for (const source of this.node.sources) {
            const name =
                this.node.document.modelManager.findNode((candidate) => candidate.id === source.nodeId)
                    ?.name ?? source.nodeId;
            const member = (
                (this.node.settings["members"] as Array<Record<string, unknown>> | undefined) ?? []
            ).find((item) => item["nodeId"] === source.nodeId) ?? {
                nodeId: source.nodeId,
            };
            const title = document.createElement("strong");
            title.textContent = name;
            this.append(title);
            const change = (key: string, value: unknown) => {
                const existing =
                    (this.node.settings["members"] as Array<Record<string, unknown>> | undefined) ?? [];
                const current = existing.find((item) => item["nodeId"] === source.nodeId) ?? {
                    nodeId: source.nodeId,
                };
                const members = existing.filter((item) => item["nodeId"] !== source.nodeId);
                members.push({ ...current, [key]: value });
                this.node.document.analyses.update(this.node, {
                    settings: { ...this.node.settings, members },
                });
            };
            const role = document.createElement("select");
            for (const value of ["unassigned", "bolt", "washer", "nut", "part"]) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = I18n.translate(`analysis.panel.role.${value}` as I18nKeys);
                role.append(option);
            }
            role.value = String(member["role"] ?? "unassigned");
            role.ariaLabel = `${name} role`;
            role.onchange = () => change("role", role.value);
            this.append(this.row(I18n.translate("analysis.panel.memberRole", name), role));
            for (const [key, translation] of [
                ["diameter", "analysis.panel.boltDiameter"],
                ["holeDiameter", "analysis.panel.holeDiameter"],
                ["thickness", "analysis.panel.axialThickness"],
            ] as const) {
                const label = I18n.translate(translation);
                const input = document.createElement("input");
                input.type = "number";
                input.step = "any";
                input.value = member[key] === undefined ? "" : String(member[key]);
                input.ariaLabel = `${name} ${label}`;
                input.onchange = () => change(key, input.value === "" ? undefined : Number(input.value));
                this.append(this.row(label, input));
            }
            for (const [key, translation] of [
                ["point", "analysis.panel.axisPoint"],
                ["direction", "analysis.panel.axisDirection"],
            ] as const) {
                const label = I18n.translate(translation);
                const input = document.createElement("input");
                const axis = member["axis"] as
                    | Record<string, { x: number; y: number; z: number }>
                    | undefined;
                const value = axis?.[key];
                input.value = value ? `${value.x}, ${value.y}, ${value.z}` : "";
                input.ariaLabel = `${name} ${label}`;
                input.onchange = () => {
                    const parsed = this.parseVector(input.value);
                    if (!parsed) {
                        input.setCustomValidity("Enter three finite numbers");
                        input.reportValidity();
                        return;
                    }
                    input.setCustomValidity("");
                    const current = (
                        (this.node.settings["members"] as Array<Record<string, unknown>> | undefined) ?? []
                    ).find((item) => item["nodeId"] === source.nodeId);
                    change("axis", {
                        ...(current?.["axis"] as Record<string, unknown> | undefined),
                        [key]: parsed,
                    });
                };
                this.append(this.row(label, input));
            }
        }
    }

    private renderMeshGroupEditor(): void {
        const source = this.node.sources[0];
        const meshNode =
            source && this.node.document.modelManager.findNode((candidate) => candidate.id === source.nodeId);
        if (!(meshNode instanceof MeshNode)) return;
        const name = document.createElement("input");
        name.placeholder = "Group name";
        name.ariaLabel = "Mesh face group name";
        const start = document.createElement("input");
        start.type = "number";
        start.min = "0";
        start.value = "0";
        start.ariaLabel = "First triangle";
        const count = document.createElement("input");
        count.type = "number";
        count.min = "1";
        count.value = "1";
        count.ariaLabel = "Triangle count";
        const add = document.createElement("button");
        add.textContent = I18n.translate("analysis.panel.assignGroup");
        add.onclick = () => {
            try {
                const original = meshNode.mesh;
                const next = new Mesh({
                    meshType: original.meshType,
                    position: original.position,
                    normal: original.normal,
                    index: original.index,
                    uv: original.uv,
                    color: original.color,
                    groups: original.groups,
                    semanticFaceGroups: [
                        ...(original.semanticGroupsAreCurrent() ? original.semanticFaceGroups : []),
                        {
                            id: Id.generate(),
                            name: name.value.trim() || "Group",
                            startTriangle: Number(start.value),
                            triangleCount: Number(count.value),
                        },
                    ],
                });
                Transaction.execute(this.node.document, "assign mesh face group", () => {
                    meshNode.mesh = next;
                });
                this.refreshResults();
            } catch (error) {
                name.setCustomValidity(String(error));
                name.reportValidity();
            }
        };
        this.append(
            this.row(I18n.translate("analysis.panel.group"), name),
            this.row(I18n.translate("analysis.panel.firstTriangle"), start),
            this.row(I18n.translate("analysis.panel.triangleCount"), count),
            add,
        );
    }
}

customElements.define("analysis-panel", AnalysisPanel);

export function showAnalysisPanel(node: AnalysisNode): void {
    showFloatPanel({
        title: "ribbon.group.inspect",
        content: new AnalysisPanel(node),
        document: node.document,
        width: 350,
        height: 500,
    });
}
