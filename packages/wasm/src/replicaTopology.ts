// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ClassHandle, MainModule, TopoDS_Shape, Vector3 } from "../lib/spicy-wasm";
import type { ReplicaTopology, ShapeReplica } from "./workerProtocol";

/**
 * Verify findSubShapes order against an INDEPENDENT direct-child traversal. Canonical graph ids
 * encode shared topology (including coincident but distinct TShapes), placements and orientations.
 * Vertex positions, edge curve samples and face bounds anchor the graph in geometry. This is an
 * enumeration-correspondence check, not a sampled substitute for the BREP geometry itself.
 */
export function replicaTopology(module: MainModule, shape: TopoDS_Shape): ReplicaTopology {
    const owned: ClassHandle[] = [];
    const own = <T extends ClassHandle>(value: T): T => {
        owned.push(value);
        return value;
    };
    const ids = new Map<number, Array<{ shape: TopoDS_Shape; id: number }>>();
    const graph: unknown[] = [];
    const round = (value: number) => {
        if (!Number.isFinite(value)) throw new Error("Non-finite replica geometry");
        return Math.abs(value) < 1e-11 ? 0 : Number(value.toPrecision(13));
    };
    const point = (value: Vector3) => [round(value.x), round(value.y), round(value.z)];
    const find = (sub: TopoDS_Shape) =>
        ids.get(module.Shape.ptr(sub))?.find((entry) => entry.shape.isSame(sub));
    const visit = (sub: TopoDS_Shape): [number, number] => {
        let id = find(sub)?.id;
        const orientation = sub.getOrientation().value;
        if (id !== undefined) return [id, orientation];
        const kind = sub.shapeType().value;
        // Casts move their argument. These are owned traversal values, so retain the typed
        // replacement AS the graph node instead of allocating a location + extra copy per leaf.
        if (kind === module.TopAbs_ShapeEnum.TopAbs_VERTEX.value) sub = own(module.TopoDS.vertex(sub));
        else if (kind === module.TopAbs_ShapeEnum.TopAbs_EDGE.value) sub = own(module.TopoDS.edge(sub));
        id = graph.length;
        const pointer = module.Shape.ptr(sub);
        const entries = ids.get(pointer) ?? [];
        entries.push({ shape: sub, id });
        ids.set(pointer, entries);
        graph.push(null);
        let geometry: unknown;
        if (kind === module.TopAbs_ShapeEnum.TopAbs_VERTEX.value) {
            geometry = point(module.Vertex.point(sub));
        } else if (kind === module.TopAbs_ShapeEnum.TopAbs_EDGE.value) {
            const first = module.Edge.firstParameter(sub);
            const last = module.Edge.lastParameter(sub);
            geometry = [
                round(first),
                round(last),
                ...[0, 0.5, 1].map((fraction) =>
                    point(module.Edge.pointAt(sub, first + (last - first) * fraction)),
                ),
            ];
        } else if (kind === module.TopAbs_ShapeEnum.TopAbs_FACE.value) {
            const bounds = module.Shape.boundingBox(sub, false);
            geometry = [point(bounds.min), point(bounds.max)];
        }
        // A TopoDS vertex is a leaf by definition. Its full geometry and orientation remain checked.
        const children =
            kind === module.TopAbs_ShapeEnum.TopAbs_VERTEX.value
                ? []
                : module.Shape.getDirectSubShapes(sub).map(own).map(visit);
        // Copy/Read may bake a vertex's Location into its coordinates. Compare world-space
        // geometry, not that incidental representation; isSame above still distinguishes instances.
        graph[id] = [kind, geometry ?? null, children];
        return [id, orientation];
    };
    let trapped = false;
    try {
        // The caller's root is borrowed; only this single value needs a copy before traversal casts.
        const root = visit(own(shape.located(own(shape.getLocation()), false)));
        const order = (kind: "TopAbs_FACE" | "TopAbs_EDGE") =>
            module.Shape.findSubShapes(shape, module.TopAbs_ShapeEnum[kind])
                .map(own)
                .map((sub) => {
                    const id = find(sub)?.id;
                    if (id === undefined) throw new Error("Topology enumeration is not in the shape graph");
                    return `${id}:${sub.getOrientation().value}`;
                });
        const faces = order("TopAbs_FACE");
        const edges = order("TopAbs_EDGE");
        return { faces, edges, graph: JSON.stringify([root, graph]) };
    } catch (error) {
        trapped = error instanceof WebAssembly.RuntimeError;
        throw error;
    } finally {
        if (!trapped) for (const handle of owned.reverse()) handle.delete();
    }
}

/** Strip mesh caches only on a detached deep copy. The live shape is never cleaned or mutated. */
export function captureReplica(module: MainModule, shape: TopoDS_Shape): ShapeReplica {
    const topology = replicaTopology(module, shape);
    const copy = module.Shape.clone(shape);
    let trapped = false;
    try {
        module.Shape.clean(copy);
        return { brep: module.Converter.convertToBrep(copy), topology };
    } catch (error) {
        trapped = error instanceof WebAssembly.RuntimeError;
        throw error;
    } finally {
        if (!trapped) copy.delete();
    }
}

export function sameReplicaTopology(a: ReplicaTopology, b: ReplicaTopology): boolean {
    return (
        a.faces.length === b.faces.length &&
        a.edges.length === b.edges.length &&
        a.faces.every((value, index) => value === b.faces[index]) &&
        a.edges.every((value, index) => value === b.edges[index]) &&
        sameGraph(a.graph, b.graph)
    );
}

type Coordinates = number | null | Coordinates[];
type GraphNode = [number, Coordinates, Array<[number, number]>];
function sameGraph(left: string, right: string): boolean {
    if (left === right) return true;
    const a = JSON.parse(left) as [[number, number], GraphNode[]];
    const b = JSON.parse(right) as [[number, number], GraphNode[]];
    // Ids, types, orientations and adjacency are EXACT. Only geometric values tolerate OCCT's
    // analytic reconstruction roundoff. Decimal-string equality is not a sound floating comparison.
    return (
        JSON.stringify(a[0]) === JSON.stringify(b[0]) &&
        a[1].length === b[1].length &&
        a[1].every((node, index) => {
            const other = b[1][index];
            return (
                node[0] === other[0] &&
                JSON.stringify(node[2]) === JSON.stringify(other[2]) &&
                sameCoordinates(node[1], other[1])
            );
        })
    );
}

function sameCoordinates(a: Coordinates, b: Coordinates): boolean {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") {
        return Math.abs(a - b) <= 1e-9 + 32 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
    }
    return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((value, index) => sameCoordinates(value, b[index]))
    );
}
