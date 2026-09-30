// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type IWire,
    Plane,
    Result,
    ShapeTypes,
    XYZ,
    type XYZLike,
} from "@spicy3d/core";

import { combineIds, ID_COMPONENT_SEPARATOR } from "./trackedId";

const PROJECTION_TOLERANCE = 1e-6;

/** Exact forward projection of one logical source, requiring one complete unambiguous branch. */
export function projectForwardCurve(source: IEdge | IWire, target: IFace, direction: XYZLike): Result<IWire> {
    if (![direction.x, direction.y, direction.z].every(Number.isFinite))
        return Result.err("Projection direction must be finite");
    const dir = new XYZ(direction).normalize();
    if (dir === undefined) return Result.err("Projection direction must be nonzero");
    const owned: IShape[] = [];
    let output: IWire | undefined;
    const keep = <T extends IShape>(shape: T): T => {
        owned.push(shape);
        return shape;
    };
    try {
        const sourceEdges = source.findSubShapes(ShapeTypes.edge) as IEdge[];
        if (sourceEdges.length === 0 || sourceEdges.length > 128)
            return Result.err("Projection requires 1 to 128 source edge pieces");
        const box1 = source.geometryBoundingBox(),
            box2 = target.geometryBoundingBox();
        const low = new XYZ({
            x: Math.min(box1.min.x, box2.min.x),
            y: Math.min(box1.min.y, box2.min.y),
            z: Math.min(box1.min.z, box2.min.z),
        });
        const high = new XYZ({
            x: Math.max(box1.max.x, box2.max.x),
            y: Math.max(box1.max.y, box2.max.y),
            z: Math.max(box1.max.z, box2.max.z),
        });
        const radius = high.sub(low).length() + 1;
        if (!Number.isFinite(radius) || radius > 1e9)
            return Result.err("Projection bounds are nonfinite or exceed the supported geometric range");
        const projected = shapeFactory.curveProjection(source, target, dir);
        if (!projected.isOk)
            return Result.err(
                `Projection has no curve on the trimmed target (disjoint or unsupported geometry): ${projected.error}`,
            );
        keep(projected.value);
        const sheets: IShape[] = [];
        for (const edge of sourceEdges) {
            const swept = shapeFactory.prism(edge, dir.multiply(2 * radius));
            if (!swept.isOk)
                return Result.err(`Projection direction cannot sweep the source curve: ${swept.error}`);
            sheets.push(keep(swept.value));
        }
        const sheet = shapeFactory.combine(sheets);
        if (!sheet.isOk) return Result.err(sheet.error);
        keep(sheet.value);
        const forward = shapeFactory.booleanCommon([projected.value], [sheet.value]);
        if (!forward.isOk)
            return Result.err(
                `Projection has no forward intersection with the trimmed target: ${forward.error}`,
            );
        keep(forward.value);
        const edges = forward.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        if (edges.length === 0)
            return Result.err("Projection has no forward intersection: the target is behind or disjoint");
        if (edges.length > 512) return Result.err("Projection exceeds 512 output curve pieces");
        if (!oneConnectedBranch(edges))
            return Result.err("Projection is ambiguous: multiple forward branches or disconnected pieces");
        const wire = shapeFactory.wire(edges);
        if (!wire.isOk) return Result.err(`Projection cannot form one connected branch: ${wire.error}`);
        keep(wire.value);
        // Compare exact shadows on a shared transverse plane. Coverage cannot be inferred from
        // endpoint/midpoint samples: a trimmed target can omit an interior source segment.
        const xvec = dir.cross(Math.abs(dir.z) < 0.9 ? XYZ.unitZ : XYZ.unitY).normalize();
        if (xvec === undefined) return Result.err("Projection transverse plane is degenerate");
        const yvec = dir.cross(xvec);
        const origin = low
            .add(high)
            .multiply(0.5)
            .add(dir.multiply(2 * radius))
            .sub(xvec.multiply(radius))
            .sub(yvec.multiply(radius));
        const screen = shapeFactory.rect(new Plane({ origin, normal: dir, xvec }), 2 * radius, 2 * radius);
        if (!screen.isOk) return Result.err(screen.error);
        keep(screen.value);
        const sourceShadow = shapeFactory.curveProjection(source, screen.value, dir);
        if (!sourceShadow.isOk)
            return Result.err(`Projection source coverage cannot be established: ${sourceShadow.error}`);
        keep(sourceShadow.value);
        const resultShadow = shapeFactory.curveProjection(wire.value, screen.value, dir);
        if (!resultShadow.isOk)
            return Result.err(`Projection output coverage cannot be established: ${resultShadow.error}`);
        keep(resultShadow.value);
        const overlap = shapeFactory.booleanCommon([sourceShadow.value], [resultShadow.value]);
        if (!overlap.isOk) return Result.err("Projection does not cover the complete source curve");
        keep(overlap.value);
        const expected = curveLength(sourceShadow.value),
            actual = curveLength(resultShadow.value),
            common = curveLength(overlap.value);
        const tolerance = PROJECTION_TOLERANCE * Math.max(1, expected, actual);
        if (expected <= tolerance)
            return Result.err(
                "Projection source is parallel to the direction or has a degenerate transverse footprint",
            );
        if (Math.abs(common - expected) > tolerance)
            return Result.err("Projection does not cover the complete source curve on the trimmed target");
        if (Math.abs(actual - common) > tolerance)
            return Result.err(
                "Projection is ambiguous: its branches fold or overlap across the source curve",
            );
        output = wire.value;
        return Result.ok(output);
    } catch (error) {
        return Result.err(`Projection geometry failed: ${String(error)}`);
    } finally {
        for (const shape of owned) if (shape !== output) shape.dispose();
    }
}

function curveLength(shape: IShape): number {
    return (shape.findSubShapes(ShapeTypes.edge) as IEdge[]).reduce((sum, edge) => sum + edge.length(), 0);
}

/** Branch topology is geometric connectivity, independent of native edge enumeration. */
function oneConnectedBranch(edges: IEdge[]): boolean {
    const vertices: XYZ[] = [];
    const incidence: number[][] = [];
    const vertexOf = (point: XYZ): number => {
        const found = vertices.findIndex((vertex) => vertex.distanceTo(point) <= PROJECTION_TOLERANCE);
        if (found >= 0) return found;
        vertices.push(point);
        incidence.push([]);
        return vertices.length - 1;
    };
    edges.forEach((edge, index) => {
        incidence[vertexOf(edge.startPoint())].push(index);
        incidence[vertexOf(edge.endPoint())].push(index);
    });
    if (incidence.some((vertex) => vertex.length > 2)) return false;
    const reached = new Set<number>();
    const pending = [0];
    while (pending.length) {
        const edge = pending.pop();
        if (edge === undefined || reached.has(edge)) continue;
        reached.add(edge);
        for (const vertex of incidence)
            if (vertex.includes(edge)) for (const next of vertex) if (!reached.has(next)) pending.push(next);
    }
    return reached.size === edges.length;
}

/** Logical projection provenance, retaining overlap when source or target ancestry is merged. */
export function projectionCurveId(
    featureId: string,
    sourceNodeId: string,
    sourceEdgeId: string,
    targetNodeId: string,
    targetFaceId: string,
): string {
    const encode = (value: string) => encodeURIComponent(value);
    const sources = [...new Set(sourceEdgeId.split(ID_COMPONENT_SEPARATOR))];
    const targets = [...new Set(targetFaceId.split(ID_COMPONENT_SEPARATOR))];
    return combineIds(
        sources.flatMap((source) =>
            targets.map(
                (target) =>
                    `projection:${encode(featureId)}:${encode(sourceNodeId)}:${encode(source)}:${encode(targetNodeId)}:${encode(target)}`,
            ),
        ),
    );
}
