// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    BoundingBox,
    CancelableCommand,
    command,
    DocumentMutations,
    EditSessions,
    GetOrSelectNodeStep,
    I18n,
    type I18nKeys,
    type IDocument,
    type IView,
    Matrix4,
    MeshNode,
    PubSub,
    Result,
    SidePanels,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import style from "./referencePlacement.module.css";

export type ReferencePlacementPreset = "center" | "minimum" | "floor";

/** Offsets are world-axis millimetres; rotations are degrees about the current bounds center. */
export function referencePlacementTransform(
    node: MeshNode,
    offset = XYZ.zero,
    rotation = XYZ.zero,
    preset?: ReferencePlacementPreset,
): Result<Matrix4, I18nKeys> {
    if (![offset.x, offset.y, offset.z, rotation.x, rotation.y, rotation.z].every(Number.isFinite)) {
        return Result.err("placement.invalid");
    }
    const positions = node.mesh.position;
    if (!positions?.length) return Result.err("placement.unavailable");
    const world = node.worldTransform();
    const localInverse = node.transform.invert();
    if (!localInverse) return Result.err("placement.unavailable");
    // Matrix4.multiply applies the left matrix first, then the right matrix.
    const parentInverse = localInverse.multiply(world).invert();
    if (!parentInverse) return Result.err("placement.unavailable");
    const bounds = BoundingBox.fromNumbers(world.ofPoints(positions));
    if (!bounds || ![...Object.values(bounds.min), ...Object.values(bounds.max)].every(Number.isFinite)) {
        return Result.err("placement.unavailable");
    }
    const center = BoundingBox.center(bounds);
    let delta: Matrix4;
    if (preset) {
        const anchor = preset === "minimum" ? bounds.min : center;
        delta = Matrix4.fromTranslation(
            -anchor.x,
            -anchor.y,
            -(preset === "floor" ? bounds.min.z : anchor.z),
        );
    } else {
        const radians = Math.PI / 180;
        delta = Matrix4.fromTranslation(-center.x, -center.y, -center.z)
            .multiply(Matrix4.fromEuler(rotation.x * radians, rotation.y * radians, rotation.z * radians))
            .multiply(Matrix4.fromTranslation(center.x + offset.x, center.y + offset.y, center.z + offset.z));
    }
    const transform = world.multiply(delta).multiply(parentInverse);
    return transform.toArray().every(Number.isFinite)
        ? Result.ok(transform)
        : Result.err("placement.invalid");
}

let closeOpenPanel: (() => void) | undefined;

/** Opens a non-modal panel; only Apply/preset buttons change the document. */
export function showReferencePlacement(node: MeshNode): HTMLElement {
    closeOpenPanel?.();
    const document = node.document;
    const panel = window.document.createElement("section");
    panel.className = style.panel;
    const content = window.document.createElement("div");
    content.className = style.content;
    panel.append(content);
    const tr = (key: I18nKeys) => I18n.translate(key) ?? key;
    const heading = window.document.createElement("h2");
    heading.textContent = tr("command.modify.referencePlacement");
    const name = window.document.createElement("div");
    name.textContent = node.name;
    const note = window.document.createElement("p");
    note.textContent = tr("placement.note");
    const error = window.document.createElement("div");
    error.setAttribute("role", "alert");
    content.append(heading, name, note);

    const fields = (title: I18nKeys, prefix: string): HTMLInputElement[] => {
        const group = window.document.createElement("fieldset");
        const legend = window.document.createElement("legend");
        legend.textContent = tr(title);
        group.append(legend);
        const inputs = ["X", "Y", "Z"].map((axis) => {
            const label = window.document.createElement("label");
            label.textContent = axis;
            const input = window.document.createElement("input");
            input.type = "number";
            input.step = "any";
            input.value = "0";
            input.required = true;
            input.setAttribute("aria-label", `${tr(title)} ${axis}`);
            input.name = `${prefix}${axis}`;
            label.append(input);
            group.append(label);
            return input;
        });
        content.append(group);
        return inputs;
    };
    const offsets = fields("placement.offset", "offset");
    const rotations = fields("placement.rotation", "rotation");
    const allInputs = [...offsets, ...rotations];
    const read = (inputs: HTMLInputElement[]) =>
        new XYZ({ x: inputs[0].valueAsNumber, y: inputs[1].valueAsNumber, z: inputs[2].valueAsNumber });
    let closed = false;
    const apply = (preset?: ReferencePlacementPreset) => {
        if (closed) return;
        if (
            document.repository.isReadOnly?.(document.id) ||
            document.application.activeView?.document !== document ||
            document.application.executingCommand ||
            DocumentMutations.isHeld(document) ||
            Transaction.isActive(document) ||
            !document.modelManager.findNodes().includes(node)
        ) {
            error.textContent = tr("placement.unavailable");
            return;
        }
        if (!preset && allInputs.some((input) => !input.checkValidity())) {
            error.textContent = tr("placement.invalid");
            return;
        }
        const result = referencePlacementTransform(
            node,
            preset ? XYZ.zero : read(offsets),
            preset ? XYZ.zero : read(rotations),
            preset,
        );
        if (!result.isOk) {
            error.textContent = tr(result.error);
            return;
        }
        if (!node.transform.equals(result.value)) {
            Transaction.execute(document, "position reference mesh", () => {
                node.transform = result.value;
            });
            document.visual.update();
        }
        allInputs.forEach((input) => {
            input.value = "0";
        });
        error.textContent = "";
    };
    const button = (key: I18nKeys, action: () => void) => {
        const element = window.document.createElement("button");
        element.type = "button";
        element.textContent = tr(key);
        element.onclick = action;
        content.append(element);
    };
    button("placement.apply", () => apply());
    button("placement.center", () => apply("center"));
    button("placement.minimum", () => apply("minimum"));
    button("placement.floor", () => apply("floor"));
    const close = () => {
        if (closed) return;
        closed = true;
        SidePanels.items.remove(panel);
        releaseSession();
        document.modelManager.removeNodeObserver(onNodesChanged);
        PubSub.default.remove("documentClosed", onDocumentClosed);
        PubSub.default.remove("activeViewChanged", onViewChanged);
        if (closeOpenPanel === close) closeOpenPanel = undefined;
    };
    const onDocumentClosed = (closing: IDocument) => {
        if (closing === document) close();
    };
    const onViewChanged = (view: IView | undefined) => {
        if (view?.document !== document) close();
    };
    const onNodesChanged = () => {
        if (!document.modelManager.findNodes().includes(node)) close();
    };
    const releaseSession = EditSessions.begin(document, close);
    document.modelManager.addNodeObserver(onNodesChanged);
    button("placement.close", close);
    content.append(error);
    PubSub.default.sub("documentClosed", onDocumentClosed);
    PubSub.default.sub("activeViewChanged", onViewChanged);
    closeOpenPanel = close;
    SidePanels.items.push(panel);
    return panel;
}

@command({ key: "modify.referencePlacement", icon: "icon-position" })
export class ReferencePlacementCommand extends CancelableCommand {
    protected override async executeAsync(): Promise<void> {
        this.controller = new AsyncController();
        const selected = await new GetOrSelectNodeStep("prompt.deviation.reference", {
            filter: { allow: (node) => node instanceof MeshNode && node.mesh.meshType === "surface" },
        }).execute(this.document, this.controller);
        if (this.checkCanceled() || !selected?.nodes?.length) return;
        showReferencePlacement(selected.nodes[0] as MeshNode);
    }
}
