// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Id, PubSub, Result } from "../foundation";
import type { I18nKeys } from "../i18n";
import { BoundingBox, Matrix4, XYZ } from "../math";
import { GeometryNode, type INode } from "../model";
import { serializable, serialize } from "../serialize";
import { type ICurve, type IFace, type IShapeMeshData, MeshDataUtils } from "../shape";
import { evaluateConstruction } from "./evaluate";
import { DocumentConstructionResolver, validateConstructionDefinition } from "./resolver";
import { isConstructionFeatureActive } from "./timelineContext";
import type {
    ConstructionDefinition,
    ConstructionGeometry,
    ConstructionRef,
    IConstructionResolver,
    ResolvedConstructionSource,
} from "./types";

export interface ConstructionNodeOptions {
    document: IDocument;
    name?: string;
    id?: string;
    definition: ConstructionDefinition;
    definitionJson?: string;
    displaySize?: number;
}

@serializable()
export class ConstructionNode extends GeometryNode {
    private _evaluating = false;
    private _notifying = false;
    private _cached?: Result<ConstructionGeometry>;
    private readonly _watched = new Map<string, INode>();
    private _error?: string;

    constructor(options: ConstructionNodeOptions) {
        super({
            document: options.document,
            name: options.name ?? "Construction",
            id: options.id ?? Id.generate(),
        });
        this.setPrivateValue("definitionJson", options.definitionJson ?? JSON.stringify(options.definition));
        this.setPrivateValue("displaySize", options.displaySize ?? 50);
        options.document.modelManager.addNodeObserver(this.handleTreeChanged);
        this.onPropertyChanged(this.handleOwnTransform);
    }

    @serialize()
    get definitionJson(): string {
        return this.getPrivateValue("definitionJson");
    }
    set definitionJson(value: string) {
        this.setProperty("definitionJson", value, () => {
            this.syncWatches();
            this.notifyGeometryChanged();
        });
    }

    get definition(): ConstructionDefinition {
        return JSON.parse(this.definitionJson) as ConstructionDefinition;
    }
    set definition(value: ConstructionDefinition) {
        const valid = validateConstructionDefinition(this.document, this.id, value);
        if (!valid.isOk) {
            PubSub.default.pub("displayError", valid.error);
            return;
        }
        this.definitionJson = JSON.stringify(value);
    }

    @serialize()
    get displaySize(): number {
        return this.getPrivateValue("displaySize", 50);
    }
    set displaySize(value: number) {
        if (!Number.isFinite(value) || value <= 0) return;
        this.setProperty("displaySize", value, () => {
            this._mesh = undefined;
            this.redrawIfAttached();
        });
    }

    get geometry(): Result<ConstructionGeometry> {
        if (this._evaluating) return Result.err("Cyclic construction reference");
        const inFeature = isConstructionFeatureActive(this.document);
        if (this._cached && !inFeature) return this._cached;
        this.syncWatches();
        this._evaluating = true;
        try {
            const parentInverse = this.parentTransform().invert();
            if (!parentInverse) return Result.err("Construction parent transform is singular");
            const documentResolver = new DocumentConstructionResolver(this.document);
            const localBorrowed: Array<{ dispose(): void }> = [];
            const resolver: IConstructionResolver = {
                resolve: (ref: ConstructionRef) => {
                    const resolved = documentResolver.resolve(ref);
                    if (!resolved.isOk || ref.kind === "fixed" || ref.kind === "origin-plane")
                        return resolved;
                    return Result.ok(transformSource(resolved.value, parentInverse, localBorrowed));
                },
                dispose: () => {
                    for (const value of localBorrowed.reverse()) value.dispose();
                    documentResolver.dispose();
                },
            };
            const local = evaluateConstruction(this.definition, resolver);
            const result = local.isOk
                ? Result.ok(transformGeometry(local.value, this.completeTransform()))
                : local;
            if (!inFeature) this._cached = result;
            const error = result.isOk ? undefined : result.error;
            if (error !== this._error) {
                const oldCount = this.warningCount;
                this._error = error;
                this.emitPropertyChanged("warningCount", oldCount);
            }
            return result;
        } finally {
            this._evaluating = false;
        }
    }

    override display(): I18nKeys {
        return "common.name";
    }

    get icon(): string {
        switch (this.definition.kind) {
            case "ucs":
                return "icon-coordinate";
            default:
                return this.definition.kind.startsWith("plane")
                    ? "icon-plane"
                    : this.definition.kind.startsWith("axis")
                      ? "icon-line"
                      : "icon-point";
        }
    }

    get warningCount(): number {
        return this._error ? 1 : 0;
    }
    get warningTooltip(): I18nKeys {
        return "construction.invalid{0}";
    }
    get errorMessage(): string | undefined {
        return this._error;
    }

    private syncWatches(): void {
        const ids = new Set<string>();
        const visit = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            const object = value as Record<string, unknown>;
            if (
                (object["kind"] === "datum" || object["kind"] === "shape") &&
                typeof object["nodeId"] === "string"
            )
                ids.add(object["nodeId"]);
            for (const nested of Object.values(object)) {
                if (Array.isArray(nested)) nested.forEach(visit);
                else if (typeof nested === "object") visit(nested);
            }
        };
        visit(this.definition);
        let ownParent = this.parent;
        while (ownParent) {
            ids.add(ownParent.id);
            ownParent = ownParent.parent;
        }
        for (const id of [...ids]) {
            let parent = this.document.modelManager.findNode((n) => n.id === id)?.parent;
            while (parent) {
                ids.add(parent.id);
                parent = parent.parent;
            }
        }
        for (const [id, node] of this._watched) {
            const current = this.document.modelManager.findNode((n) => n.id === id);
            if (ids.has(id) && current === node) continue;
            node.removePropertyChanged(this.handleSourceChanged);
            this._watched.delete(id);
        }
        for (const id of ids) {
            if (id === this.id || this._watched.has(id)) continue;
            const node = this.document.modelManager.findNode((n) => n.id === id);
            if (node) {
                node.onPropertyChanged(this.handleSourceChanged);
                this._watched.set(id, node);
            }
        }
    }

    private readonly handleSourceChanged = (property: string) => {
        if (
            property === "shape" ||
            property === "transform" ||
            property === "geometry" ||
            property === "definitionJson"
        )
            this.notifyGeometryChanged();
    };

    private readonly handleTreeChanged = () => {
        this.syncWatches();
        this.notifyGeometryChanged();
    };

    private readonly handleOwnTransform = (property: keyof this) => {
        if (property === "transform") this.notifyGeometryChanged();
    };

    private parentTransform(): Matrix4 {
        const chain: Matrix4[] = [];
        let node: INode | undefined = this.parent;
        while (node) {
            const transform = (node as INode & { transform?: Matrix4 }).transform;
            if (transform instanceof Matrix4) chain.unshift(transform);
            node = node.parent;
        }
        return chain.reduce((result, next) => result.multiply(next), Matrix4.identity());
    }

    private completeTransform(): Matrix4 {
        return this.parentTransform().multiply(this.transform);
    }

    private notifyGeometryChanged(): void {
        if (this._notifying) return;
        this._notifying = true;
        try {
            this._mesh = undefined;
            this._cached = undefined;
            this.emitPropertyChanged("geometry", Result.err("Reevaluating construction object"));
            this.redrawIfAttached();
        } finally {
            this._notifying = false;
        }
    }

    /**
     * Deleted nodes are kept alive (not disposed) for undo, so their listeners keep firing; the
     * viewport removes their visual on delete and re-adds it on undo/redo, so only redraw while the
     * node is still reachable from the document root, otherwise it would resurrect a ghost visual.
     */
    private redrawIfAttached(): void {
        if (this.isAttachedToDocument()) this.document.visual.context.redrawNode([this]);
    }

    private isAttachedToDocument(): boolean {
        const root = this.document.modelManager.rootNode;
        let node: INode | undefined = this.parent;
        while (node) {
            if (node === root) return true;
            node = node.parent;
        }
        return false;
    }

    override disposeInternal(): void {
        this.removePropertyChanged(this.handleOwnTransform);
        this.document.modelManager.removeNodeObserver(this.handleTreeChanged);
        for (const node of this._watched.values()) node.removePropertyChanged(this.handleSourceChanged);
        this._watched.clear();
        super.disposeInternal();
    }

    override boundingBox(): BoundingBox | undefined {
        const geometry = this.geometry;
        if (!geometry.isOk) return undefined;
        const center =
            geometry.value.kind === "point"
                ? geometry.value.point
                : geometry.value.kind === "plane"
                  ? geometry.value.plane.origin
                  : geometry.value.origin;
        const r = this.displaySize / 2;
        return BoundingBox.fromNumbers(
            new Float32Array([
                center.x - r,
                center.y - r,
                center.z - r,
                center.x + r,
                center.y + r,
                center.z + r,
            ]),
        );
    }

    protected override createMesh(): IShapeMeshData {
        const result = this.geometry;
        if (!result.isOk) return { edges: undefined, faces: undefined, vertexs: undefined };
        const g = result.value;
        const size = this.displaySize;
        const lines: XYZ[] = [];
        const push = (a: XYZ, b: XYZ) => lines.push(a, b);
        if (g.kind === "plane") {
            const o = g.plane.origin,
                x = g.plane.xvec.multiply(size / 2),
                y = g.plane.yvec.multiply(size / 2);
            const corners = [o.sub(x).sub(y), o.add(x).sub(y), o.add(x).add(y), o.sub(x).add(y)];
            for (let i = 0; i < 4; i++) push(corners[i], corners[(i + 1) % 4]);
        } else if (g.kind === "axis") {
            push(g.origin.sub(g.direction.multiply(size / 2)), g.origin.add(g.direction.multiply(size / 2)));
        } else if (g.kind === "point") {
            const d = Math.max(1, size / 15);
            push(g.point.sub(XYZ.unitX.multiply(d)), g.point.add(XYZ.unitX.multiply(d)));
            push(g.point.sub(XYZ.unitY.multiply(d)), g.point.add(XYZ.unitY.multiply(d)));
            push(g.point.sub(XYZ.unitZ.multiply(d)), g.point.add(XYZ.unitZ.multiply(d)));
        } else {
            push(g.origin, g.origin.add(g.x.multiply(size)));
            push(g.origin, g.origin.add(g.y.multiply(size)));
            push(g.origin, g.origin.add(g.z.multiply(size)));
        }
        const inverse = this.completeTransform().invert();
        const renderLines = inverse ? lines.map((p) => inverse.ofPoint(p)) : lines;
        const renderPoint = g.kind === "point" ? (inverse ? inverse.ofPoint(g.point) : g.point) : undefined;
        return {
            faces: undefined,
            vertexs: renderPoint ? MeshDataUtils.createVertexMesh(renderPoint, 8, 0x66bbee) : undefined,
            edges: {
                lineType: "solid",
                position: new Float32Array(renderLines.flatMap((p) => p.toArray())),
                range: [],
                color: 0x66bbee,
            },
        };
    }
}

function transformGeometry(geometry: ConstructionGeometry, matrix: Matrix4): ConstructionGeometry {
    if (geometry.kind === "plane") return { kind: "plane", plane: geometry.plane.transformed(matrix) };
    if (geometry.kind === "point") return { kind: "point", point: matrix.ofPoint(geometry.point) };
    if (geometry.kind === "axis")
        return {
            kind: "axis",
            origin: matrix.ofPoint(geometry.origin),
            direction: matrix.ofVector(geometry.direction).normalize() ?? geometry.direction,
        };
    return {
        kind: "ucs",
        origin: matrix.ofPoint(geometry.origin),
        x: matrix.ofVector(geometry.x).normalize() ?? geometry.x,
        y: matrix.ofVector(geometry.y).normalize() ?? geometry.y,
        z: matrix.ofVector(geometry.z).normalize() ?? geometry.z,
    };
}

function transformSource(
    source: ResolvedConstructionSource,
    matrix: Matrix4,
    borrowed: Array<{ dispose(): void }>,
): ResolvedConstructionSource {
    if (source.kind === "face") {
        const face = source.face.transformedMul(matrix) as IFace;
        borrowed.push(face);
        return { kind: "face", face, normalSign: source.normalSign };
    }
    if (source.kind === "curve") {
        const curve = source.curve.transformed(matrix) as ICurve;
        borrowed.push(curve);
        return { kind: "curve", curve, start: source.start, end: source.end };
    }
    if (source.kind === "edge")
        return {
            kind: "edge",
            start: matrix.ofPoint(source.start),
            end: matrix.ofPoint(source.end),
            curve: transformOptionalCurve(source.curve, matrix, borrowed),
            edge: transformOptionalEdge(source.edge, matrix, borrowed),
        };
    if (source.kind === "vertex") return { kind: "vertex", point: matrix.ofPoint(source.point) };
    if (source.kind === "path")
        return {
            kind: "path",
            reversed: source.reversed,
            branch: source.branch,
            segments: source.segments.map((segment) =>
                transformSource({ kind: "curve", ...segment }, matrix, borrowed),
            ) as Extract<ResolvedConstructionSource, { kind: "path" }>["segments"],
        };
    return transformGeometry(source, matrix);
}

function transformOptionalCurve(
    curve: ICurve | undefined,
    matrix: Matrix4,
    borrowed: Array<{ dispose(): void }>,
): ICurve | undefined {
    if (!curve) return undefined;
    const transformed = curve.transformed(matrix) as ICurve;
    borrowed.push(transformed);
    return transformed;
}

function transformOptionalEdge(
    edge: import("../shape").IEdge | undefined,
    matrix: Matrix4,
    borrowed: Array<{ dispose(): void }>,
): import("../shape").IEdge | undefined {
    if (!edge) return undefined;
    const transformed = edge.transformedMul(matrix) as import("../shape").IEdge;
    borrowed.push(transformed);
    return transformed;
}
