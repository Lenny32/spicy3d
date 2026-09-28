// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Browser-evaluable independent probe. Does not import/use the application's replica validator. */
export function captureProfileGeometry(brep) {
    const m = globalThis.wasm;
    const shape = m.Converter.convertFromBrep(brep);
    const owned = [shape];
    const own = (handle) => {
        owned.push(handle);
        return handle;
    };
    const buckets = new Map();
    const queue = [];
    const nodes = [];
    const identity = (value) => {
        const pointer = m.Shape.ptr(value);
        const bucket = buckets.get(pointer) ?? [];
        let index = bucket.find((entry) => entry.shape.isSame(value))?.index;
        if (index === undefined) {
            index = queue.length;
            bucket.push({ shape: value, index });
            buckets.set(pointer, bucket);
            queue.push(value);
        }
        return [index, value.getOrientation().value];
    };
    const point = (value) => [value.x, value.y, value.z];
    const copyForCast = (value) => own(value.located(own(value.getLocation()), false));
    let trapped = false;
    try {
        const root = identity(shape);
        // Breadth-first independent graph, not replicaTopology's depth-first numbering.
        for (let index = 0; index < queue.length; index++) {
            const sub = queue[index];
            const kind = sub.shapeType().value;
            let anchors = null;
            if (kind === m.TopAbs_ShapeEnum.TopAbs_VERTEX.value) {
                anchors = point(m.Vertex.point(own(m.TopoDS.vertex(copyForCast(sub)))));
            } else if (kind === m.TopAbs_ShapeEnum.TopAbs_EDGE.value) {
                const edge = own(m.TopoDS.edge(copyForCast(sub)));
                const first = m.Edge.firstParameter(edge);
                const last = m.Edge.lastParameter(edge);
                anchors = [
                    first,
                    last,
                    ...[0, 0.25, 0.5, 0.75, 1].map((fraction) =>
                        point(m.Edge.pointAt(edge, first + (last - first) * fraction)),
                    ),
                ];
            } else if (kind === m.TopAbs_ShapeEnum.TopAbs_FACE.value) {
                const bounds = m.Shape.boundingBox(sub, false);
                anchors = [point(bounds.min), point(bounds.max)];
            }
            const children = m.Shape.getDirectSubShapes(sub).map(own).map(identity);
            nodes.push({ kind, children, anchors });
        }
        const order = (kind) =>
            m.Shape.findSubShapes(shape, m.TopAbs_ShapeEnum[kind])
                .map(own)
                .map((value) => {
                    const match = buckets.get(m.Shape.ptr(value))?.find((entry) => entry.shape.isSame(value));
                    if (!match) throw new Error("Ordered subshape was not in the independent graph");
                    return [match.index, value.getOrientation().value];
                });
        return {
            algorithm: "ordered-bfs-v1",
            root,
            nodes,
            faces: order("TopAbs_FACE"),
            edges: order("TopAbs_EDGE"),
            vertices: order("TopAbs_VERTEX"),
            bounds: m.Shape.boundingBox(shape, false),
            volume: m.Shape.volume(shape),
        };
    } catch (error) {
        trapped = error instanceof WebAssembly.RuntimeError;
        throw error;
    } finally {
        if (!trapped) for (const handle of owned.reverse()) handle.delete();
    }
}

/** Exact ordered graph/adjacency/orientations, roundoff-only geometry anchors, independent mass. */
export function compareProfileGeometry(left, right) {
    if (
        !left ||
        !right ||
        left.algorithm !== "ordered-bfs-v1" ||
        right.algorithm !== left.algorithm ||
        !Array.isArray(left.nodes) ||
        !Array.isArray(right.nodes) ||
        !left.nodes.length ||
        !right.nodes.length
    )
        return { ok: false, reason: "missing independent geometry probes" };
    const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let maxAnchorDelta = 0;
    const coordinates = (a, b) => {
        if (typeof a === "number" && typeof b === "number") {
            if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
            const delta = Math.abs(a - b);
            maxAnchorDelta = Math.max(maxAnchorDelta, delta);
            return delta <= 1e-9 + 32 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
        }
        if (a === null || b === null) return a === b;
        return (
            Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((value, index) => coordinates(value, b[index]))
        );
    };
    const orderedGraphMatch =
        exact(left.root, right.root) &&
        left.nodes.length === right.nodes.length &&
        left.nodes.every(
            (node, index) =>
                node.kind === right.nodes[index].kind && exact(node.children, right.nodes[index].children),
        ) &&
        ["faces", "edges", "vertices"].every(
            (kind) =>
                Array.isArray(left[kind]) && Array.isArray(right[kind]) && exact(left[kind], right[kind]),
        );
    const geometryAnchorsMatch =
        left.nodes.length === right.nodes.length &&
        left.nodes.every((node, index) => coordinates(node.anchors, right.nodes[index].anchors));
    const boundsMatch = !!left.bounds && !!right.bounds && exact(left.bounds, right.bounds);
    const volumeDelta = Math.abs(left.volume - right.volume);
    const volumeMatch = Number.isFinite(left.volume) && Number.isFinite(right.volume) && volumeDelta <= 1e-6;
    return {
        ok: orderedGraphMatch && geometryAnchorsMatch && boundsMatch && volumeMatch,
        orderedGraphMatch,
        geometryAnchorsMatch,
        boundsMatch,
        volumeMatch,
        maxAnchorDelta,
        volumeDelta,
        anchorAbsoluteTolerance: 1e-9,
        anchorScaleEpsilons: 32,
        volumeAbsoluteTolerance: 1e-6,
    };
}

/** Only an explicitly requested hybrid mode may substitute the approved geometry checks for cold bytes. */
export function profileGeometryIssues(comparison, expectedMode = "main") {
    if (!comparison) return ["missing geometry comparison"];
    const issues = [];
    if (expectedMode === "hybrid") {
        for (const label of ["afterCold", "afterCycles"]) {
            const result = compareProfileGeometry(
                comparison.baselineCold?.geometryProbe,
                comparison[label]?.geometryProbe,
            );
            if (!result.ok)
                issues.push(
                    `${label}: independent ordered graph/anchors/bounds/volume differ or are missing`,
                );
        }
    } else if (comparison.coldCleanBrepIdentical !== true) issues.push("cold geometry-only BREP differs");
    // Unchanged operations still preserve the representation produced by this backend.
    if (comparison.cyclesCleanBrepIdentical !== true) issues.push("cycle geometry-only BREP differs");
    return issues;
}
