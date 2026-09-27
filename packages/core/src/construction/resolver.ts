// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation";
import { Matrix4, Plane, XYZ } from "../math";
import { GeometryNode, type INode, ShapeNode } from "../model";
import { CurveUtils, type IEdge, type IFace, type IShape, type IVertex, ShapeTypes } from "../shape";
import type { ConstructionNode } from "./node";
import { activeConstructionFeature } from "./timelineContext";
import type {
    ConstructionGeometry,
    ConstructionRef,
    IConstructionResolver,
    ResolvedConstructionSource,
} from "./types";

function worldTransform(node: INode): Matrix4 {
    const chain: Matrix4[] = [];
    let current: INode | undefined = node;
    while (current) {
        const transform = (current as INode & { transform?: Matrix4 }).transform;
        if (transform instanceof Matrix4) chain.unshift(transform);
        current = current.parent;
    }
    return chain.reduce((result, transform) => result.multiply(transform), Matrix4.identity());
}

function reviveGeometry(value: ConstructionGeometry): ConstructionGeometry {
    const point = (p: XYZ) => new XYZ(p);
    if (value.kind === "plane") {
        const p = value.plane;
        return {
            kind: "plane",
            plane: new Plane({ origin: point(p.origin), normal: point(p.normal), xvec: point(p.xvec) }),
        };
    }
    if (value.kind === "point") return { kind: "point", point: point(value.point) };
    if (value.kind === "axis")
        return { kind: "axis", origin: point(value.origin), direction: point(value.direction) };
    return {
        kind: "ucs",
        origin: point(value.origin),
        x: point(value.x),
        y: point(value.y),
        z: point(value.z),
    };
}

function memberOf(
    geometry: ConstructionGeometry,
    member: Extract<ConstructionRef, { kind: "datum" }>["member"],
): ResolvedConstructionSource {
    if (!member) return geometry;
    if (geometry.kind !== "ucs") throw new Error("Only a UCS has named axes and planes");
    const { origin, x, y, z } = geometry;
    if (member === "X") return { kind: "axis", origin, direction: x };
    if (member === "Y") return { kind: "axis", origin, direction: y };
    if (member === "Z") return { kind: "axis", origin, direction: z };
    if (member === "XY") return { kind: "plane", plane: new Plane({ origin, normal: z, xvec: x }) };
    if (member === "YZ") return { kind: "plane", plane: new Plane({ origin, normal: x, xvec: y }) };
    return { kind: "plane", plane: new Plane({ origin, normal: y, xvec: z }) };
}

function shapeKind(shape: IShape): "face" | "edge" | "vertex" | undefined {
    if (shape.shapeType === ShapeTypes.face) return "face";
    if (shape.shapeType === ShapeTypes.edge) return "edge";
    if (shape.shapeType === ShapeTypes.vertex) return "vertex";
    return undefined;
}

function isConstructionNode(node: INode | undefined): node is ConstructionNode {
    return node instanceof GeometryNode && "definitionJson" in node && "geometry" in node;
}

function fingerprint(shape: IShape): string {
    if (shape.shapeType === ShapeTypes.vertex) {
        return (shape as IVertex)
            .point()
            .toArray()
            .map((v) => v.toPrecision(8))
            .join(",");
    }
    if (shape.shapeType === ShapeTypes.edge) {
        const edge = shape as IEdge;
        const curve = edge.curve;
        try {
            return [curve.curveType, ...edge.startPoint().toArray(), ...edge.endPoint().toArray()]
                .map((v) => (typeof v === "number" ? v.toPrecision(8) : v))
                .join(",");
        } finally {
            curve.dispose();
        }
    }
    const face = shape as IFace;
    const s = face.surface();
    try {
        const bounds = s.bounds();
        const u = Number.isFinite(bounds.u1) && Number.isFinite(bounds.u2) ? (bounds.u1 + bounds.u2) / 2 : 0;
        const v = Number.isFinite(bounds.v1) && Number.isFinite(bounds.v2) ? (bounds.v1 + bounds.v2) / 2 : 0;
        const [p, n] = face.normal(u, v);
        return [...p.toArray(), ...n.toArray(), face.area()].map((x) => x.toPrecision(8)).join(",");
    } finally {
        s.dispose();
    }
}

type ShapeRef = Extract<ConstructionRef, { kind: "shape" }>;
function semanticOf(shape: IShape, parent: IShape): ShapeRef["semantic"] {
    if (shape.shapeType === ShapeTypes.face) {
        const surface = (shape as IFace).surface();
        try {
            const type =
                "majorRadius" in surface
                    ? "torus"
                    : "semiAngle" in surface
                      ? "cone"
                      : "radius" in surface && "area" in surface
                        ? "sphere"
                        : "radius" in surface
                          ? "cylinder"
                          : undefined;
            return type ? { kind: "analytic-face", surface: type } : undefined;
        } finally {
            surface.dispose();
        }
    }
    if (shape.shapeType === ShapeTypes.edge) {
        const curve = (shape as IEdge).curve;
        try {
            if (CurveUtils.isCircle(curve)) return { kind: "circle-edge" };
            if (CurveUtils.isTrimmed(curve)) {
                const basis = curve.basisCurve;
                try {
                    return CurveUtils.isCircle(basis) ? { kind: "circle-edge" } : undefined;
                } finally {
                    basis.dispose();
                }
            }
            return undefined;
        } finally {
            curve.dispose();
        }
    }
    if (shape.shapeType === ShapeTypes.vertex) {
        const p = (shape as IVertex).point(),
            box = parent.boundingBox();
        const coordinates = [p.x, p.y, p.z],
            mins = [box.min.x, box.min.y, box.min.z];
        const maxs = [box.max.x, box.max.y, box.max.z];
        const signs = coordinates.map((value, i) =>
            Math.abs(value - mins[i]) < 1e-6 ? -1 : Math.abs(value - maxs[i]) < 1e-6 ? 1 : 0,
        );
        return signs.every((sign) => sign !== 0)
            ? { kind: "extreme-vertex", signs: signs as [-1 | 1, -1 | 1, -1 | 1] }
            : undefined;
    }
    return undefined;
}

function circleCenter(curve: import("../shape").ICurve): XYZ | undefined {
    if (CurveUtils.isCircle(curve)) return curve.center;
    return CurveUtils.isTrimmed(curve) ? circleCenter(curve.basisCurve) : undefined;
}

function shapeResult(
    document: IDocument,
    ref: Extract<ConstructionRef, { kind: "shape" }>,
): Result<ResolvedConstructionSource> {
    const node = document.modelManager.findNode((n) => n.id === ref.nodeId);
    if (!(node instanceof ShapeNode)) return Result.err(`Source node ${ref.nodeId} is missing or invalid`);
    const timeline = node as ShapeNode & {
        featureCount?: number;
        timelineStateAt?: (
            index: number,
        ) => { shape?: IShape; faceIds?: string[]; edgeIds?: string[] } | undefined;
    };
    let sourceShape: IShape;
    let faceIds: string[] | undefined;
    let edgeIds: string[] | undefined;
    if (ref.featureIndex !== undefined) {
        if (!Number.isInteger(ref.featureIndex) || ref.featureIndex < 0)
            return Result.err("Feature position is invalid");
        const active = activeConstructionFeature(document, node.id);
        if (active && ref.featureIndex > active.index)
            return Result.err("Construction reference points to a later body feature");
        if ("rollbackIndex" in timeline && timeline.rollbackIndex !== undefined)
            return Result.err("Construction source is temporarily rolled back");
        if (timeline.featureCount === undefined || !timeline.timelineStateAt)
            return Result.err("Source has no feature timeline");
        if (ref.featureIndex > timeline.featureCount)
            return Result.err("Construction source refers to a future feature");
        if (ref.featureIndex < timeline.featureCount) {
            const state = timeline.timelineStateAt(ref.featureIndex);
            if (!state?.shape)
                return Result.err("Construction source is unavailable at its feature position");
            sourceShape = state.shape;
            faceIds = state.faceIds;
            edgeIds = state.edgeIds;
            if (ref.trackedId && !(ref.shapeType === "face" ? faceIds : edgeIds))
                return Result.err("Tracked topology is unavailable at the feature position");
            if (ref.incidentEdgeIds?.length && !edgeIds)
                return Result.err("Tracked vertex edges are unavailable at the feature position");
        } else {
            if (!node.shape.isOk) return Result.err("Source shape is invalid");
            sourceShape = node.shape.value;
        }
    } else {
        if (!node.shape.isOk) return Result.err("Source shape is invalid");
        sourceShape = node.shape.value;
    }
    const type =
        ref.shapeType === "face"
            ? ShapeTypes.face
            : ref.shapeType === "edge"
              ? ShapeTypes.edge
              : ShapeTypes.vertex;
    const shapes = sourceShape.findSubShapes(type);
    let index = ref.index;
    if (ref.semantic) {
        const signature = JSON.stringify(ref.semantic);
        const matches = shapes.flatMap((shape, i) =>
            JSON.stringify(semanticOf(shape, sourceShape)) === signature ? [i] : [],
        );
        if (matches.length !== 1)
            return Result.err(matches.length ? "Semantic source is ambiguous" : "Semantic source is missing");
        index = matches[0];
    }
    if (ref.trackedId) {
        const ids = ref.shapeType === "face" ? faceIds : edgeIds;
        const lookup =
            ref.shapeType === "face"
                ? "faceIndexesOfId"
                : ref.shapeType === "edge"
                  ? "edgeIndexesOfId"
                  : undefined;
        const tracker = node as unknown as Record<string, (id: string) => number[]>;
        const matches = ids
            ? ids.flatMap((id, index) => (id === ref.trackedId ? [index] : []))
            : lookup && typeof tracker[lookup] === "function"
              ? tracker[lookup](ref.trackedId)
              : undefined;
        if (!matches) return Result.err("Source has no tracked topology IDs");
        if (matches.length !== 1)
            return Result.err(matches.length ? "Source topology is ambiguous" : "Source topology is missing");
        index = matches[0];
    }
    if (ref.shapeType === "vertex" && ref.incidentEdgeIds?.length) {
        const edges = sourceShape.findSubShapes(ShapeTypes.edge) as IEdge[];
        const matches = ref.incidentEdgeIds.map((id) => {
            const indexes = edgeIds
                ? edgeIds.flatMap((value, i) => (value === id ? [i] : []))
                : ((node as unknown as { edgeIndexesOfId?: (id: string) => number[] }).edgeIndexesOfId?.(
                      id,
                  ) ?? []);
            return indexes.length === 1 ? edges[indexes[0]] : undefined;
        });
        if (matches.some((edge) => !edge)) return Result.err("Vertex source edges are missing or ambiguous");
        const candidates = shapes.filter((vertex) =>
            matches.every((edge) => {
                const p = (vertex as IVertex).point();
                return edge!.startPoint().distanceTo(p) < 1e-6 || edge!.endPoint().distanceTo(p) < 1e-6;
            }),
        );
        if (candidates.length !== 1)
            return Result.err(candidates.length ? "Vertex source is ambiguous" : "Vertex source is missing");
        index = shapes.indexOf(candidates[0]);
    }
    const selected = shapes[index];
    if (!selected) return Result.err("Source sub-shape is missing");
    if (
        !ref.trackedId &&
        !ref.incidentEdgeIds?.length &&
        !ref.semantic &&
        (!ref.fingerprint || fingerprint(selected) !== ref.fingerprint)
    )
        return Result.err("Untracked source changed; select its geometry again");
    let normalSign: 1 | -1 = 1;
    let reverseEdge = false;
    if (ref.orientation && ref.shapeType === "face") {
        const surface = (selected as IFace).surface();
        try {
            const bounds = surface.bounds();
            const u =
                Number.isFinite(bounds.u1) && Number.isFinite(bounds.u2) ? (bounds.u1 + bounds.u2) / 2 : 0;
            const v =
                Number.isFinite(bounds.v1) && Number.isFinite(bounds.v2) ? (bounds.v1 + bounds.v2) / 2 : 0;
            const current = (selected as IFace).normal(u, v)[1];
            normalSign = current.dot(ref.orientation) < 0 ? -1 : 1;
        } finally {
            surface.dispose();
        }
    }
    if (ref.orientation && ref.shapeType === "edge") {
        const edge = selected as IEdge;
        reverseEdge = edge.endPoint().sub(edge.startPoint()).dot(ref.orientation) < 0;
    }
    const transformed = selected.transformedMul(worldTransform(node));
    if (ref.shapeType === "vertex") {
        const point = (transformed as IVertex).point();
        transformed.dispose();
        return Result.ok({ kind: "vertex", point });
    }
    if (ref.shapeType === "edge") {
        const edge = transformed as IEdge;
        const curve = edge.curve;
        const orientedCurve = reverseEdge ? curve.reversed() : curve;
        if (reverseEdge) curve.dispose();
        return Result.ok({
            kind: "edge",
            start: reverseEdge ? edge.endPoint() : edge.startPoint(),
            end: reverseEdge ? edge.startPoint() : edge.endPoint(),
            curve: orientedCurve,
            edge,
        });
    }
    return Result.ok({ kind: "face", face: transformed as IFace, normalSign });
}

export class DocumentConstructionResolver implements IConstructionResolver {
    private readonly borrowed: Array<{ dispose(): void }> = [];
    constructor(readonly document: IDocument) {}

    dispose(): void {
        for (const value of this.borrowed.splice(0).reverse()) value.dispose();
    }

    resolve(ref: ConstructionRef): Result<ResolvedConstructionSource> {
        try {
            if (ref.kind === "fixed") return Result.ok(reviveGeometry(ref.geometry));
            if (ref.kind === "origin-plane") {
                const plane = ref.plane === "XY" ? Plane.XY : ref.plane === "YZ" ? Plane.YZ : Plane.ZX;
                return Result.ok({ kind: "plane", plane });
            }
            if (ref.kind === "shape") {
                const result = shapeResult(this.document, ref);
                if (result.isOk) {
                    if (result.value.kind === "face") this.borrowed.push(result.value.face);
                    if (result.value.kind === "edge") {
                        if (result.value.curve) this.borrowed.push(result.value.curve);
                        if (result.value.edge) this.borrowed.push(result.value.edge);
                    }
                }
                return result;
            }
            if (ref.kind === "datum") {
                const node = this.document.modelManager.findNode((n) => n.id === ref.nodeId);
                if (!isConstructionNode(node))
                    return Result.err(`Construction object ${ref.nodeId} is missing`);
                const value = node.geometry;
                return value.isOk ? Result.ok(memberOf(value.value, ref.member)) : Result.err(value.error);
            }
            if (ref.kind === "face-point") {
                const face = this.resolve(ref.face);
                if (!face.isOk || face.value.kind !== "face")
                    return Result.err(face.isOk ? "Source is not a face" : face.error);
                const surface = face.value.face.surface();
                let point: XYZ;
                try {
                    point = surface.value(ref.u, ref.v);
                } finally {
                    surface.dispose();
                }
                if (!face.value.face.containsPoint(point, true, 1e-6))
                    return Result.err("Contact point is outside the face");
                return Result.ok({ kind: "point", point });
            }
            if (ref.kind === "snap") {
                const resolved = this.resolve(ref.source);
                if (!resolved.isOk) return resolved;
                const value = resolved.value;
                if (value.kind !== "edge" || !value.curve) return Result.err("Snap source is not an edge");
                if (ref.snap === "start") return Result.ok({ kind: "point", point: value.start });
                if (ref.snap === "end") return Result.ok({ kind: "point", point: value.end });
                if (ref.snap === "middle")
                    return Result.ok({
                        kind: "point",
                        point: value.curve.value(
                            (value.curve.firstParameter() + value.curve.lastParameter()) / 2,
                        ),
                    });
                const center = circleCenter(value.curve);
                return center
                    ? Result.ok({ kind: "point", point: center })
                    : Result.err("Edge has no analytic center");
            }
            const segments: Extract<ResolvedConstructionSource, { kind: "curve" }>[] = [];
            for (const source of ref.segments) {
                const resolved = this.resolve(source);
                if (!resolved.isOk) return resolved;
                if (resolved.value.kind === "curve") segments.push(resolved.value);
                else if (resolved.value.kind === "edge" && resolved.value.curve)
                    segments.push({ kind: "curve", curve: resolved.value.curve });
                else return Result.err("Path segment is not a curve");
            }
            return Result.ok({ kind: "path", segments, reversed: ref.reversed, branch: ref.branch });
        } catch (error) {
            return Result.err(error instanceof Error ? error.message : String(error));
        }
    }
}

export function resolveConstructionRef(
    document: IDocument,
    ref: ConstructionRef,
): Result<ResolvedConstructionSource> {
    return new DocumentConstructionResolver(document).resolve(ref);
}

/** Reject datum cycles before an edited definition enters undo history. */
export function validateConstructionDefinition(
    document: IDocument,
    nodeId: string,
    definition: unknown,
): Result<void> {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const datumIds = (value: unknown): string[] => {
        const ids: string[] = [];
        const visit = (entry: unknown): void => {
            if (!entry || typeof entry !== "object") return;
            const object = entry as Record<string, unknown>;
            if (object["kind"] === "datum" && typeof object["nodeId"] === "string")
                ids.push(object["nodeId"]);
            for (const nested of Object.values(object)) {
                if (Array.isArray(nested)) nested.forEach(visit);
                else if (typeof nested === "object") visit(nested);
            }
        };
        visit(value);
        return ids;
    };
    const walk = (id: string): string | undefined => {
        if (visiting.has(id)) return `Cyclic construction reference involving ${id}`;
        if (visited.has(id)) return undefined;
        visiting.add(id);
        const current =
            id === nodeId
                ? definition
                : (document.modelManager.findNode((node) => node.id === id) as ConstructionNode | undefined)
                      ?.definition;
        for (const sourceId of datumIds(current)) {
            const error = walk(sourceId);
            if (error) return error;
        }
        visiting.delete(id);
        visited.add(id);
        return undefined;
    };
    const error = walk(nodeId);
    if (error) return Result.err(error);

    const shapeRefs: Array<Extract<ConstructionRef, { kind: "shape" }>> = [];
    const collectShapes = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const object = value as Record<string, unknown>;
        if (object["kind"] === "shape") shapeRefs.push(object as Extract<ConstructionRef, { kind: "shape" }>);
        for (const nested of Object.values(object)) {
            if (Array.isArray(nested)) nested.forEach(collectShapes);
            else if (typeof nested === "object") collectShapes(nested);
        }
    };
    collectShapes(definition);
    const reachesEditedDatum = (id: string, seen = new Set<string>()): boolean => {
        if (id === nodeId) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        const source = document.modelManager.findNode((node) => node.id === id) as
            | ConstructionNode
            | undefined;
        return (
            source !== undefined &&
            "definitionJson" in source &&
            datumIds(source.definition).some((next) => reachesEditedDatum(next, seen))
        );
    };
    for (const candidate of document.modelManager.findNodes()) {
        const features = (candidate as INode & { features?: unknown }).features;
        if (!Array.isArray(features)) continue;
        for (let index = 0; index < features.length; index++) {
            const feature = features[index] as Record<string, unknown>;
            const datumSources = datumIds(feature["constructionAxisRef"]);
            const sketchId = feature["sketchId"];
            if (typeof sketchId === "string") {
                const sketch = document.modelManager.findNode((node) => node.id === sketchId) as
                    | (INode & { constructionPlaneRef?: ConstructionRef })
                    | undefined;
                datumSources.push(...datumIds(sketch?.constructionPlaneRef));
            }
            if (!datumSources.some((id) => reachesEditedDatum(id))) continue;
            if (
                shapeRefs.some(
                    (ref) =>
                        ref.nodeId === candidate.id &&
                        (ref.featureIndex === undefined || ref.featureIndex > index),
                )
            )
                return Result.err(`Construction source refers beyond the consuming feature ${index}`);
        }
    }
    return Result.ok(undefined);
}

export function captureConstructionRef(
    _document: IDocument,
    node: INode,
    shape?: IShape,
): Result<ConstructionRef> {
    if (isConstructionNode(node)) return Result.ok({ kind: "datum", nodeId: node.id });
    if (!(node instanceof ShapeNode) || !shape)
        return Result.err("Select a face, edge, vertex, or construction object");
    const kind = shapeKind(shape);
    if (!kind || !node.shape.isOk) return Result.err("Unsupported source shape");
    const type = kind === "face" ? ShapeTypes.face : kind === "edge" ? ShapeTypes.edge : ShapeTypes.vertex;
    const shapes = node.shape.value.findSubShapes(type);
    const index = shapes.findIndex((candidate) => candidate.isSame(shape));
    if (index < 0) return Result.err("Selected sub-shape is not part of the source node");
    const tracker = node as unknown as Record<string, (index: number) => string | undefined>;
    const lookup = kind === "face" ? "faceIdAt" : kind === "edge" ? "edgeIdAt" : undefined;
    const trackedId = lookup && typeof tracker[lookup] === "function" ? tracker[lookup](index) : undefined;
    let orientation: XYZ | undefined;
    if (kind === "edge")
        orientation = (shapes[index] as IEdge)
            .endPoint()
            .sub((shapes[index] as IEdge).startPoint())
            .normalize();
    if (kind === "face") {
        const surface = (shapes[index] as IFace).surface();
        try {
            const bounds = surface.bounds();
            const u =
                Number.isFinite(bounds.u1) && Number.isFinite(bounds.u2) ? (bounds.u1 + bounds.u2) / 2 : 0;
            const v =
                Number.isFinite(bounds.v1) && Number.isFinite(bounds.v2) ? (bounds.v1 + bounds.v2) / 2 : 0;
            orientation = (shapes[index] as IFace).normal(u, v)[1].normalize();
        } finally {
            surface.dispose();
        }
    }
    let incidentEdgeIds: string[] | undefined;
    if (kind === "vertex" && typeof tracker["edgeIdAt"] === "function") {
        const point = (shapes[index] as IVertex).point();
        incidentEdgeIds = (node.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[])
            .flatMap((edge, i) =>
                edge.startPoint().distanceTo(point) < 1e-6 || edge.endPoint().distanceTo(point) < 1e-6
                    ? [tracker["edgeIdAt"](i)]
                    : [],
            )
            .filter((id): id is string => typeof id === "string");
        if (incidentEdgeIds.length < 2) incidentEdgeIds = undefined;
    }
    const body = node as ShapeNode & { featureCount?: number };
    const proposedSemantic =
        trackedId || incidentEdgeIds?.length ? undefined : semanticOf(shapes[index], node.shape.value);
    const semantic =
        proposedSemantic &&
        shapes.filter(
            (shape) =>
                JSON.stringify(semanticOf(shape, node.shape.value)) === JSON.stringify(proposedSemantic),
        ).length === 1
            ? proposedSemantic
            : undefined;
    return Result.ok({
        kind: "shape",
        nodeId: node.id,
        shapeType: kind,
        index,
        trackedId,
        incidentEdgeIds,
        featureIndex: body.featureCount,
        orientation,
        semantic,
        fingerprint:
            trackedId || incidentEdgeIds?.length || semantic ? undefined : fingerprint(shapes[index]),
    });
}

export function captureFacePointRef(
    document: IDocument,
    node: INode,
    face: IFace,
    worldPoint: XYZ,
): Result<ConstructionRef> {
    const captured = captureConstructionRef(document, node, face);
    if (!captured.isOk) return captured;
    const resolver = new DocumentConstructionResolver(document);
    try {
        const resolved = resolver.resolve(captured.value);
        if (!resolved.isOk || resolved.value.kind !== "face")
            return Result.err(resolved.isOk ? "Source is not a face" : resolved.error);
        const surface = resolved.value.face.surface();
        try {
            const uv = surface.parameter(worldPoint, 1e-5);
            if (!uv) return Result.err("Point is not on the selected face");
            return Result.ok({ kind: "face-point", face: captured.value, u: uv.u, v: uv.v });
        } finally {
            surface.dispose();
        }
    } finally {
        resolver.dispose();
    }
}
