// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    type ConstructionDefinition,
    type ConstructionGeometry,
    ConstructionNode,
    type ConstructionRef,
    captureConstructionRef,
    captureFacePointRef,
    command,
    Dimensions,
    DocumentConstructionResolver,
    evaluateConstruction,
    I18n,
    type I18nKeys,
    type IApplication,
    type ICommand,
    type IDocument,
    type INode,
    MeshDataUtils,
    Plane,
    PointStep,
    SelectNodeStep,
    SelectShapeStep,
    type ShapeType,
    ShapeTypes,
    setActiveConstructionPlane,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import style from "./construction.module.css";

function tr(text: string): string {
    const key = `construction.ui.${text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")}`;
    return I18n.isI18nKey(key) ? I18n.translate(key as I18nKeys) : text;
}

function constructionError(error: unknown): string {
    const detail = String(error);
    const kind = /missing|unavailable|not found|deleted|no longer/i.test(detail)
        ? "missing"
        : /ambiguous|multiple|infinitely many|no unique|branch|parallel or coincident/i.test(detail)
          ? "ambiguous"
          : "invalid";
    return `${I18n.translate(`construction.error.${kind}` as I18nKeys)}: ${detail}`;
}

type SourceType = "plane" | "axis" | "point" | "edge" | "face" | "vertex" | "path" | "center";
type Field = { name: string; label: string; type: SourceType; optional?: boolean };
type NumberField = { name: string; label: string; value: number; optional?: boolean };
type DefinitionKind = ConstructionDefinition["kind"];
type Tool = {
    kind: DefinitionKind;
    sources: Field[];
    numbers?: NumberField[];
    choices?: { name: string; label: string; values: string[] }[];
};

const TOOLS: Record<string, Tool> = {
    offsetPlane: {
        kind: "plane-offset",
        sources: [
            { name: "source", label: "Plane", type: "plane" },
            { name: "toPoint", label: "To Object point", type: "point", optional: true },
        ],
        numbers: [{ name: "distance", label: "Distance (mm)", value: 0 }],
    },
    midplane: {
        kind: "plane-midplane",
        sources: [
            { name: "first", label: "First plane", type: "plane" },
            { name: "second", label: "Second plane", type: "plane" },
        ],
        choices: [{ name: "solution", label: "Bisector", values: ["0", "1"] }],
    },
    planeAtAngle: {
        kind: "plane-angle",
        sources: [
            { name: "axis", label: "Axis", type: "axis" },
            { name: "baseline", label: "Reference plane", type: "plane" },
        ],
        numbers: [
            { name: "angle", label: "Angle (degrees)", value: 0 },
            { name: "offset", label: "Normal offset (mm)", value: 0 },
        ],
    },
    planeThroughTwoEdges: {
        kind: "plane-two-edges",
        sources: [
            { name: "first", label: "First edge", type: "edge" },
            { name: "second", label: "Second edge", type: "edge" },
        ],
        numbers: [{ name: "offset", label: "Normal offset (mm)", value: 0 }],
    },
    planeThroughThreePoints: {
        kind: "plane-three-points",
        sources: [
            { name: "first", label: "First point", type: "point" },
            { name: "second", label: "Second point", type: "point" },
            { name: "third", label: "Third point", type: "point" },
        ],
        numbers: [{ name: "offset", label: "Normal offset (mm)", value: 0 }],
    },
    planeAlongPath: {
        kind: "plane-along-path",
        sources: [
            { name: "path", label: "Path", type: "path" },
            { name: "toPoint", label: "To Object point", type: "point", optional: true },
        ],
        numbers: [
            { name: "value", label: "Position", value: 0 },
            { name: "offset", label: "Normal offset (mm)", value: 0 },
            { name: "branch", label: "Path branch", value: 0, optional: true },
        ],
        choices: [
            { name: "positionKind", label: "Position mode", values: ["distance", "normalized", "to-point"] },
            { name: "reversed", label: "Reverse path", values: ["false", "true"] },
        ],
    },
    tangentPlane: {
        kind: "plane-tangent",
        sources: [
            { name: "face", label: "Surface", type: "face" },
            { name: "contact", label: "Contact point", type: "point" },
        ],
        numbers: [{ name: "offset", label: "Normal offset (mm)", value: 0 }],
    },
    perpendicularPlane: {
        kind: "plane-perpendicular",
        sources: [
            { name: "source", label: "Surface or plane", type: "plane" },
            { name: "contact", label: "Contact point", type: "point" },
            { name: "orientation", label: "Orientation axis", type: "axis" },
        ],
        numbers: [{ name: "distance", label: "Distance (mm)", value: 0 }],
    },
    axisThroughCylinder: {
        kind: "axis-analytic",
        sources: [{ name: "face", label: "Cylinder, cone or torus", type: "face" }],
    },
    axisPerpendicularToFace: {
        kind: "axis-normal",
        sources: [
            { name: "source", label: "Face or plane", type: "plane" },
            { name: "contact", label: "Point on face", type: "point" },
        ],
    },
    axisThroughTwoPlanes: {
        kind: "axis-two-planes",
        sources: [
            { name: "first", label: "First plane", type: "plane" },
            { name: "second", label: "Second plane", type: "plane" },
        ],
    },
    axisThroughTwoPoints: {
        kind: "axis-two-points",
        sources: [
            { name: "first", label: "First point", type: "point" },
            { name: "second", label: "Second point", type: "point" },
        ],
    },
    axisThroughEdge: { kind: "axis-edge", sources: [{ name: "edge", label: "Linear edge", type: "edge" }] },
    pointAtVertex: { kind: "point-vertex", sources: [{ name: "vertex", label: "Vertex", type: "vertex" }] },
    pointThroughTwoEdges: {
        kind: "point-two-edges",
        sources: [
            { name: "first", label: "First edge", type: "edge" },
            { name: "second", label: "Second edge", type: "edge" },
        ],
        numbers: [{ name: "solution", label: "Solution", value: 0 }],
    },
    pointThroughThreePlanes: {
        kind: "point-three-planes",
        sources: [
            { name: "first", label: "First plane", type: "plane" },
            { name: "second", label: "Second plane", type: "plane" },
            { name: "third", label: "Third plane", type: "plane" },
        ],
    },
    pointAtCenter: {
        kind: "point-center",
        sources: [{ name: "source", label: "Circle, sphere or torus", type: "center" }],
    },
    pointAtEdgeAndPlane: {
        kind: "point-edge-plane",
        sources: [
            { name: "edge", label: "Edge", type: "edge" },
            { name: "plane", label: "Plane", type: "plane" },
        ],
    },
    pointAlongPath: {
        kind: "point-along-path",
        sources: [
            { name: "path", label: "Path", type: "path" },
            { name: "toPoint", label: "To Object point", type: "point", optional: true },
        ],
        numbers: [
            { name: "value", label: "Position", value: 0 },
            { name: "branch", label: "Path branch", value: 0, optional: true },
        ],
        choices: [
            { name: "positionKind", label: "Position mode", values: ["distance", "normalized", "to-point"] },
            { name: "reversed", label: "Reverse path", values: ["false", "true"] },
        ],
    },
    ucs: {
        kind: "ucs",
        sources: [
            { name: "origin", label: "Origin point", type: "point" },
            { name: "first", label: "First direction", type: "axis" },
            { name: "second", label: "Second direction", type: "axis" },
        ],
        choices: [
            { name: "firstAxis", label: "First axis", values: ["X", "Y", "Z"] },
            { name: "secondAxis", label: "Second axis", values: ["Y", "Z", "X"] },
            { name: "reverseFirst", label: "Reverse first", values: ["false", "true"] },
            { name: "reverseSecond", label: "Reverse second", values: ["false", "true"] },
        ],
    },
};

function shapeType(type: SourceType): ShapeType {
    switch (type) {
        case "plane":
        case "face":
            return ShapeTypes.face;
        case "point":
        case "vertex":
            return ShapeTypes.vertex;
        case "center":
            return (ShapeTypes.face | ShapeTypes.edge) as ShapeType;
        default:
            return ShapeTypes.edge;
    }
}

function option(text: string, value = text): HTMLOptionElement {
    const el = document.createElement("option");
    el.textContent = text;
    el.value = value;
    return el;
}

/** The same form creates and edits construction definitions. Pick actions never mutate the model. */
class ConstructionSession {
    private readonly values: Record<string, unknown>;
    private readonly root = document.createElement("div");
    private readonly status = document.createElement("div");
    private readonly previewIds: number[] = [];
    private readonly sourceLabels = new Map<string, HTMLElement>();
    private readonly controls: HTMLInputElement[] = [];
    private activeController?: AsyncController;
    private activePick = false;
    private cancelInput?: () => void;
    private finished = false;
    private resolveDone!: (definition: ConstructionDefinition | undefined) => void;
    readonly done = new Promise<ConstructionDefinition | undefined>((resolve) => {
        this.resolveDone = resolve;
    });

    constructor(
        private readonly model: IDocument,
        private readonly tool: Tool,
        private readonly title: string,
        initial?: ConstructionDefinition,
    ) {
        this.values = initial ? { ...initial } : { kind: tool.kind };
        // An along-path "To Object" definition keeps its point inside `position`; the form edits it as
        // the `toPoint` source, so seed that field (a fresh pick still overwrites it).
        const position = this.values["position"] as { kind?: string; point?: unknown } | undefined;
        if (position?.kind === "to-point" && position.point && this.values["toPoint"] === undefined)
            this.values["toPoint"] = position.point;
        for (const field of tool.numbers ?? []) {
            if (this.valueFor(field.name) === undefined && !field.optional)
                this.values[field.name] = field.value;
        }
        for (const field of tool.choices ?? []) {
            if (this.valueFor(field.name) === undefined) {
                this.values[field.name] =
                    field.values[0] === "true" ? true : field.values[0] === "false" ? false : field.values[0];
            }
        }
        this.root.className = `spicy-construction-editor ${style.root}`;
        const header = document.createElement("strong");
        header.textContent = title;
        this.root.append(header);
        this.renderSources();
        this.renderNumbers();
        this.renderChoices();
        this.status.className = style.status;
        this.status.setAttribute("role", "status");
        this.root.append(this.status);
        const actions = document.createElement("div");
        actions.className = style.actions;
        const create = document.createElement("button");
        create.textContent = tr(initial ? "Apply" : "Create");
        create.onclick = () => {
            const definition = this.definition();
            if (definition) this.finish(definition);
        };
        const cancel = document.createElement("button");
        cancel.textContent = tr("Cancel");
        cancel.onclick = () => this.finish();
        actions.append(create, cancel);
        this.root.append(actions);
        (this.model.application.mainWindow ?? document.body).append(this.root);
        this.refreshPreview();
    }

    private renderSources() {
        for (const field of this.tool.sources) {
            const row = document.createElement("div");
            row.className = style.field;
            const label = document.createElement("label");
            label.textContent = tr(field.label);
            const mode = document.createElement("select");
            mode.append(
                option(tr("Pick geometry"), "shape"),
                option(tr("Pick construction object"), "datum"),
            );
            if (field.type === "plane") {
                mode.append(
                    option(tr("Global XY"), "XY"),
                    option(tr("Global YZ"), "YZ"),
                    option(tr("Global ZX"), "ZX"),
                );
            }
            if (field.type === "point")
                mode.append(
                    option(tr("Fixed coordinates"), "fixed-point"),
                    option(tr("Point on face"), "face-point"),
                );
            if (field.type === "point" || field.type === "vertex") {
                mode.append(
                    option(tr("Edge start"), "snap-start"),
                    option(tr("Edge end"), "snap-end"),
                    option(tr("Edge midpoint"), "snap-middle"),
                    option(tr("Circle center"), "snap-center"),
                );
            }
            if (field.type === "axis")
                mode.append(
                    option(tr("UCS X axis"), "X"),
                    option(tr("UCS Y axis"), "Y"),
                    option(tr("UCS Z axis"), "Z"),
                );
            if (field.type === "axis") mode.append(option(tr("Fixed direction"), "fixed-axis"));
            if (field.type === "plane")
                mode.append(
                    option(tr("UCS XY plane"), "UCS-XY"),
                    option(tr("UCS YZ plane"), "UCS-YZ"),
                    option(tr("UCS ZX plane"), "UCS-ZX"),
                );
            const pick = document.createElement("button");
            pick.textContent = tr("Select");
            pick.onclick = () => void this.pick(field, mode.value);
            const chosen = document.createElement("small");
            this.sourceLabels.set(field.name, chosen);
            row.append(label, mode, pick, chosen);
            this.root.append(row);
            this.showSource(field.name);
        }
    }

    private renderNumbers() {
        for (const field of this.tool.numbers ?? []) {
            const row = document.createElement("label");
            row.textContent = tr(field.label);
            row.className = style.field;
            const input = document.createElement("input");
            input.type = "number";
            input.step = "any";
            input.value = String(this.valueFor(field.name) ?? (field.optional ? "" : field.value));
            input.oninput = () => {
                if (input.value === "" && field.optional) {
                    delete this.values[field.name];
                    this.refreshPreview();
                    return;
                }
                const value = Number(input.value);
                if (Number.isFinite(value)) {
                    this.values[field.name] = value;
                    this.refreshPreview();
                }
            };
            input.onkeydown = (event) => event.stopPropagation();
            this.controls.push(input);
            row.append(input);
            this.root.append(row);
        }
    }

    private renderChoices() {
        for (const field of this.tool.choices ?? []) {
            const row = document.createElement("label");
            row.textContent = tr(field.label);
            row.className = style.field;
            const select = document.createElement("select");
            field.values.forEach((value) => select.append(option(tr(value), value)));
            select.value = String(this.valueFor(field.name) ?? field.values[0]);
            select.onchange = () => {
                this.values[field.name] =
                    select.value === "true" ? true : select.value === "false" ? false : select.value;
                this.refreshPreview();
            };
            row.append(select);
            this.root.append(row);
        }
    }

    private valueFor(name: string): unknown {
        if (name === "positionKind") return (this.values["position"] as { kind?: string } | undefined)?.kind;
        if (name === "value") return (this.values["position"] as { value?: number } | undefined)?.value;
        if (name === "reversed" || name === "branch")
            return (this.values["path"] as { reversed?: boolean; branch?: number } | undefined)?.[name];
        return this.values[name];
    }

    private definition(): ConstructionDefinition | undefined {
        const fields = { ...this.values };
        for (const source of this.tool.sources) {
            if (!source.optional && !fields[source.name]) {
                this.status.textContent = `${tr("Select")} ${tr(source.label)}`;
                return undefined;
            }
        }
        if (this.tool.kind === "plane-along-path" || this.tool.kind === "point-along-path") {
            const positionKind = (fields["positionKind"] ??
                (fields["position"] as { kind?: string } | undefined)?.kind ??
                "distance") as string;
            const value = Number(
                fields["value"] ?? (fields["position"] as { value?: number } | undefined)?.value ?? 0,
            );
            if (positionKind === "to-point" && !fields["toPoint"]) {
                this.status.textContent = tr("Select a To Object point.");
                return undefined;
            }
            fields["position"] =
                positionKind === "to-point"
                    ? { kind: "to-point", point: fields["toPoint"] }
                    : { kind: positionKind, value };
            delete fields["positionKind"];
            delete fields["value"];
        }
        if (fields["solution"] !== undefined) fields["solution"] = Number(fields["solution"]);
        if (this.tool.kind === "plane-along-path" || this.tool.kind === "point-along-path") {
            const path = fields["path"] as ConstructionRef;
            if (path.kind === "path") {
                fields["path"] = {
                    ...path,
                    reversed: (fields["reversed"] ?? path.reversed) === true || fields["reversed"] === "true",
                    ...((fields["branch"] ?? path.branch) === undefined
                        ? {}
                        : { branch: Number(fields["branch"] ?? path.branch) }),
                };
            }
        }
        delete fields["reversed"];
        delete fields["branch"];
        if (this.tool.kind !== "plane-offset") delete fields["toPoint"];
        return fields as unknown as ConstructionDefinition;
    }

    private async pick(field: Field, mode: string) {
        if (this.activePick || this.finished) return;
        this.activePick = true;
        let ref: ConstructionRef | undefined;
        try {
            if (mode === "XY" || mode === "YZ" || mode === "ZX") {
                ref = { kind: "origin-plane", plane: mode };
            } else if (mode === "fixed-point" || mode === "fixed-axis") {
                const box = document.createElement("input");
                box.placeholder = mode === "fixed-axis" ? tr("direction x, y, z") : tr("x, y, z (mm)");
                box.onkeydown = (event) => event.stopPropagation();
                this.root.append(box);
                box.focus();
                const entered = await new Promise<string | undefined>((resolve) => {
                    this.cancelInput = () => resolve(undefined);
                    box.onkeydown = (event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") resolve(box.value);
                        if (event.key === "Escape") resolve(undefined);
                    };
                });
                box.remove();
                this.cancelInput = undefined;
                const coords = entered?.split(",").map(Number);
                if (coords?.length === 3 && coords.every(Number.isFinite)) {
                    const vector = new XYZ({ x: coords[0], y: coords[1], z: coords[2] });
                    ref =
                        mode === "fixed-axis"
                            ? {
                                  kind: "fixed",
                                  geometry: { kind: "axis", origin: XYZ.zero, direction: vector },
                              }
                            : { kind: "fixed", geometry: { kind: "point", point: vector } };
                }
            } else {
                const controller = new AsyncController();
                this.activeController = controller;
                try {
                    const datum =
                        mode === "datum" || mode.startsWith("UCS-") || ["X", "Y", "Z"].includes(mode);
                    if (datum) {
                        const picked = await new SelectNodeStep("prompt.select.models", {
                            filter: { allow: (node: INode) => node instanceof ConstructionNode },
                        }).execute(this.model, controller);
                        const node = picked?.nodes?.[0];
                        if (node instanceof ConstructionNode) {
                            ref = { kind: "datum", nodeId: node.id };
                            if (mode.startsWith("UCS-")) ref.member = mode.slice(4) as "XY" | "YZ" | "ZX";
                            else if (["X", "Y", "Z"].includes(mode)) ref.member = mode as "X" | "Y" | "Z";
                        }
                    } else {
                        const requestedType =
                            mode === "face-point" ? "face" : mode.startsWith("snap-") ? "edge" : field.type;
                        const picked = await new SelectShapeStep(
                            shapeType(requestedType),
                            "prompt.select.shape",
                            { multiple: field.type === "path" },
                        ).execute(this.model, controller);
                        const selected = picked?.shapes[0];
                        if (selected) {
                            const captured = captureConstructionRef(
                                this.model,
                                selected.owner.node,
                                selected.shape,
                            );
                            if (!captured.isOk) this.status.textContent = constructionError(captured.error);
                            else ref = captured.value;
                            if (mode.startsWith("snap-") && ref)
                                ref = {
                                    kind: "snap",
                                    source: ref,
                                    snap: mode.slice(5) as "start" | "end" | "middle" | "center",
                                };
                            if (field.type === "path" && ref) {
                                const segments = picked.shapes
                                    .map((item) =>
                                        captureConstructionRef(this.model, item.owner.node, item.shape),
                                    )
                                    .filter((item) => item.isOk)
                                    .map((item) => item.value);
                                ref = { kind: "path", segments };
                            }
                            if (mode === "face-point" && ref) {
                                const pointController = new AsyncController();
                                this.activeController = pointController;
                                const pointPick = await new PointStep("prompt.pickPoint", () => ({
                                    dimension: Dimensions.D1D2D3,
                                })).execute(this.model, pointController);
                                pointController.dispose();
                                this.activeController = controller;
                                if (pointPick?.point) {
                                    const contact = captureFacePointRef(
                                        this.model,
                                        selected.owner.node,
                                        selected.shape as import("@spicy3d/core").IFace,
                                        pointPick.point,
                                    );
                                    if (contact.isOk) ref = contact.value;
                                    else this.status.textContent = constructionError(contact.error);
                                } else ref = undefined;
                            }
                        }
                    }
                } finally {
                    controller.dispose();
                    this.activeController = undefined;
                }
            }
            if (!this.finished && ref) {
                this.values[field.name] = ref;
                this.showSource(field.name);
                this.refreshPreview();
            }
        } finally {
            this.activePick = false;
        }
    }

    private showSource(name: string) {
        const ref = this.values[name] as ConstructionRef | undefined;
        const label = this.sourceLabels.get(name);
        if (!label) return;
        if (!ref) label.textContent = tr("No reference selected");
        else if (ref.kind === "datum")
            label.textContent = `${tr("Construction object")} ${ref.nodeId}${ref.member ? ` / ${ref.member}` : ""}`;
        else if (ref.kind === "origin-plane") label.textContent = `${tr("Global")} ${ref.plane}`;
        else if (ref.kind === "shape") label.textContent = `${ref.shapeType} ${ref.index + 1}`;
        else
            label.textContent =
                ref.kind === "face-point"
                    ? tr("Point on face")
                    : ref.kind === "path"
                      ? `${ref.segments.length} ${tr("path segment(s)")}`
                      : ref.kind === "snap"
                        ? ref.snap
                        : tr("Fixed point");
    }

    private clearPreview() {
        for (const id of this.previewIds) this.model.visual.context.removeMesh(id);
        this.previewIds.length = 0;
        this.model.application.activeView?.update?.();
    }

    private refreshPreview() {
        this.clearPreview();
        const definition = this.definition();
        if (!definition) return;
        const result = evaluateConstruction(definition, new DocumentConstructionResolver(this.model));
        if (!result.isOk) {
            this.status.textContent = constructionError(result.error);
            return;
        }
        this.status.textContent = tr("Preview ready");
        const meshes = previewGeometry(result.value);
        if (meshes.length)
            this.previewIds.push(
                this.model.visual.context.displayMesh(meshes, { onTop: true, lineOpacity: 0.85 }),
            );
        this.model.application.activeView?.update?.();
    }

    private finish(definition?: ConstructionDefinition) {
        if (this.finished) return;
        if (definition) {
            const result = evaluateConstruction(definition, new DocumentConstructionResolver(this.model));
            if (!result.isOk) {
                this.status.textContent = constructionError(result.error);
                return;
            }
        }
        this.finished = true;
        this.activeController?.cancel();
        this.cancelInput?.();
        this.clearPreview();
        this.root.remove();
        this.resolveDone(definition);
    }

    cancel() {
        this.finish();
    }
}

function previewGeometry(geometry: ConstructionGeometry) {
    const color = 0x2dd4bf;
    const size = 25;
    if (geometry.kind === "point") return [MeshDataUtils.createVertexMesh(geometry.point, 8, color)];
    if (geometry.kind === "axis") {
        return [
            MeshDataUtils.createEdgeMesh(
                geometry.origin.sub(geometry.direction.multiply(size)),
                geometry.origin.add(geometry.direction.multiply(size)),
                color,
                "dash",
            ),
        ];
    }
    if (geometry.kind === "plane") {
        const { origin, xvec, yvec } = geometry.plane;
        const x = xvec.multiply(size);
        const y = yvec.multiply(size);
        const corners = [
            origin.sub(x).sub(y),
            origin.add(x).sub(y),
            origin.add(x).add(y),
            origin.sub(x).add(y),
        ];
        return corners.map((point, index) =>
            MeshDataUtils.createEdgeMesh(point, corners[(index + 1) % 4], color, "dash"),
        );
    }
    return [
        MeshDataUtils.createEdgeMesh(
            geometry.origin,
            geometry.origin.add(geometry.x.multiply(size)),
            0xff5555,
            "solid",
        ),
        MeshDataUtils.createEdgeMesh(
            geometry.origin,
            geometry.origin.add(geometry.y.multiply(size)),
            0x55ff55,
            "solid",
        ),
        MeshDataUtils.createEdgeMesh(
            geometry.origin,
            geometry.origin.add(geometry.z.multiply(size)),
            0x5555ff,
            "solid",
        ),
    ];
}

abstract class CreateConstruction extends CancelableCommand {
    protected abstract readonly toolName: keyof typeof TOOLS;
    private session?: ConstructionSession;
    protected override async executeAsync(): Promise<void> {
        const tool = TOOLS[this.toolName];
        this.session = new ConstructionSession(
            this.document,
            tool,
            I18n.translate(`command.construct.${this.toolName}` as I18nKeys),
        );
        const definition = await this.session.done;
        if (!definition) return;
        Transaction.execute(this.document, `create ${this.toolName}`, () => {
            this.document.modelManager.addNode(new ConstructionNode({ document: this.document, definition }));
            this.document.visual.update();
        });
    }
    override async cancel(): Promise<void> {
        this.session?.cancel();
        await super.cancel();
    }
}

@command({ key: "construct.offsetPlane", icon: "icon-setWorkingPlane" })
export class OffsetPlaneCommand extends CreateConstruction {
    protected readonly toolName = "offsetPlane";
}
@command({ key: "construct.midplane", icon: "icon-setWorkingPlane" })
export class MidplaneCommand extends CreateConstruction {
    protected readonly toolName = "midplane";
}
@command({ key: "construct.planeAtAngle", icon: "icon-setWorkingPlane" })
export class PlaneAtAngleCommand extends CreateConstruction {
    protected readonly toolName = "planeAtAngle";
}
@command({ key: "construct.planeThroughTwoEdges", icon: "icon-setWorkingPlane" })
export class PlaneThroughTwoEdgesCommand extends CreateConstruction {
    protected readonly toolName = "planeThroughTwoEdges";
}
@command({ key: "construct.planeThroughThreePoints", icon: "icon-setWorkingPlane" })
export class PlaneThroughThreePointsCommand extends CreateConstruction {
    protected readonly toolName = "planeThroughThreePoints";
}
@command({ key: "construct.planeAlongPath", icon: "icon-setWorkingPlane" })
export class PlaneAlongPathCommand extends CreateConstruction {
    protected readonly toolName = "planeAlongPath";
}
@command({ key: "construct.tangentPlane", icon: "icon-setWorkingPlane" })
export class TangentPlaneCommand extends CreateConstruction {
    protected readonly toolName = "tangentPlane";
}
@command({ key: "construct.perpendicularPlane", icon: "icon-setWorkingPlane" })
export class PerpendicularPlaneCommand extends CreateConstruction {
    protected readonly toolName = "perpendicularPlane";
}
@command({ key: "construct.axisThroughCylinder", icon: "icon-line" })
export class AxisThroughCylinderCommand extends CreateConstruction {
    protected readonly toolName = "axisThroughCylinder";
}
@command({ key: "construct.axisPerpendicularToFace", icon: "icon-line" })
export class AxisPerpendicularToFaceCommand extends CreateConstruction {
    protected readonly toolName = "axisPerpendicularToFace";
}
@command({ key: "construct.axisThroughTwoPlanes", icon: "icon-line" })
export class AxisThroughTwoPlanesCommand extends CreateConstruction {
    protected readonly toolName = "axisThroughTwoPlanes";
}
@command({ key: "construct.axisThroughTwoPoints", icon: "icon-line" })
export class AxisThroughTwoPointsCommand extends CreateConstruction {
    protected readonly toolName = "axisThroughTwoPoints";
}
@command({ key: "construct.axisThroughEdge", icon: "icon-line" })
export class AxisThroughEdgeCommand extends CreateConstruction {
    protected readonly toolName = "axisThroughEdge";
}
@command({ key: "construct.pointAtVertex", icon: "icon-point" })
export class PointAtVertexCommand extends CreateConstruction {
    protected readonly toolName = "pointAtVertex";
}
@command({ key: "construct.pointThroughTwoEdges", icon: "icon-point" })
export class PointThroughTwoEdgesCommand extends CreateConstruction {
    protected readonly toolName = "pointThroughTwoEdges";
}
@command({ key: "construct.pointThroughThreePlanes", icon: "icon-point" })
export class PointThroughThreePlanesCommand extends CreateConstruction {
    protected readonly toolName = "pointThroughThreePlanes";
}
@command({ key: "construct.pointAtCenter", icon: "icon-point" })
export class PointAtCenterCommand extends CreateConstruction {
    protected readonly toolName = "pointAtCenter";
}
@command({ key: "construct.pointAtEdgeAndPlane", icon: "icon-point" })
export class PointAtEdgeAndPlaneCommand extends CreateConstruction {
    protected readonly toolName = "pointAtEdgeAndPlane";
}
@command({ key: "construct.pointAlongPath", icon: "icon-point" })
export class PointAlongPathCommand extends CreateConstruction {
    protected readonly toolName = "pointAlongPath";
}
@command({ key: "construct.ucs", icon: "icon-setWorkingPlane" })
export class UcsCommand extends CreateConstruction {
    protected readonly toolName = "ucs";
}

@command({ key: "construct.edit", icon: "icon-setWorkingPlane" })
export class EditConstructionCommand extends CancelableCommand {
    private session?: ConstructionSession;
    protected override async executeAsync(): Promise<void> {
        const node = this.document.selection
            .getSelectedNodes()
            .find((item) => item instanceof ConstructionNode);
        if (!(node instanceof ConstructionNode)) return;
        const toolName = Object.keys(TOOLS).find((key) => TOOLS[key].kind === node.definition.kind);
        if (!toolName) return;
        this.session = new ConstructionSession(this.document, TOOLS[toolName], node.name, node.definition);
        const definition = await this.session.done;
        if (!definition) return;
        Transaction.execute(this.document, "edit construction", () => {
            node.definition = definition;
            this.document.visual.update();
        });
    }
    override async cancel(): Promise<void> {
        this.session?.cancel();
        await super.cancel();
    }
}

abstract class ActivateConstructionPlane implements ICommand {
    protected abstract readonly member?: "XY" | "YZ" | "ZX";
    async execute(application: IApplication): Promise<void> {
        const view = application.activeView;
        const node = view?.document.selection
            .getSelectedNodes()
            .find((item) => item instanceof ConstructionNode);
        if (!(node instanceof ConstructionNode) || !view) return;
        const result = node.geometry;
        if (!result.isOk) return;
        const geometry = result.value;
        if (geometry.kind === "plane") {
            view.workplane = geometry.plane;
            setActiveConstructionPlane(view, { kind: "datum", nodeId: node.id });
        } else if (geometry.kind === "ucs" && this.member) {
            const { origin, x, y, z } = geometry;
            view.workplane =
                this.member === "XY"
                    ? new Plane({ origin, normal: z, xvec: x })
                    : this.member === "YZ"
                      ? new Plane({ origin, normal: x, xvec: y })
                      : new Plane({ origin, normal: y, xvec: z });
            setActiveConstructionPlane(view, { kind: "datum", nodeId: node.id, member: this.member });
        }
    }
}

@command({ key: "construct.activatePlane", icon: "icon-setWorkingPlane" })
export class ActivateConstructionPlaneCommand extends ActivateConstructionPlane {
    protected readonly member = undefined;
}
@command({ key: "construct.activateXY", icon: "icon-setWorkingPlane" })
export class ActivateConstructionXYCommand extends ActivateConstructionPlane {
    protected readonly member = "XY";
}
@command({ key: "construct.activateYZ", icon: "icon-setWorkingPlane" })
export class ActivateConstructionYZCommand extends ActivateConstructionPlane {
    protected readonly member = "YZ";
}
@command({ key: "construct.activateZX", icon: "icon-setWorkingPlane" })
export class ActivateConstructionZXCommand extends ActivateConstructionPlane {
    protected readonly member = "ZX";
}
