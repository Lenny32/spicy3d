// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, Result, type SvgDrawing, type SvgPoint } from "@spicy3d/core";
import { ConstraintKind, type SketchClipboard } from "./sketchModel";
import { SketchSolver } from "./solver";

export interface SvgSketchOptions {
    /** Uniform factor on the drawing's own millimetres. */
    readonly scale: number;
    /** Counter-clockwise rotation about the drawing's bounding-box centre, in degrees. */
    readonly angle: number;
    /**
     * Keeps the drawing in one piece: every piece gets a Block (Lock) constraint and the joints
     * are left out — over locked pieces they would only be redundant, and the shared endpoints are
     * computed from the same points, so outlines still close into profiles.
     */
    readonly lock?: boolean;
}

/** Under this length (mm, after scaling) a segment is dropped and its neighbours are joined. */
const DEGENERATE_LENGTH = 1e-9;

/**
 * An SVG drawing as ordinary sketch geometry, ready for the paste placement: straight segments
 * become lines, cubics exact degree-3 control B-splines, consecutive pieces of a subpath are tied
 * by coincident constraints (closed subpaths wrap around), so closed outlines build profiles —
 * or, with `lock`, every piece is locked instead (see `SvgSketchOptions.lock`).
 * The geometry is scaled, rotated about the bounding-box centre and centred on `origin` [0, 0].
 */
export function svgSketchClipboard(drawing: SvgDrawing, options: SvgSketchOptions): Result<SketchClipboard> {
    const bounds = drawing.bounds;
    if (bounds === undefined) return Result.err("The SVG file has no outlines to import");
    if (!(options.scale > 0) || !Number.isFinite(options.scale) || !Number.isFinite(options.angle))
        return Result.err("Scale and angle must be finite, the scale positive");
    const cx = (bounds.min.x + bounds.max.x) / 2,
        cy = (bounds.min.y + bounds.max.y) / 2;
    const radians = (options.angle * Math.PI) / 180;
    const cos = Math.cos(radians) * options.scale,
        sin = Math.sin(radians) * options.scale;
    const place = (p: SvgPoint): [number, number] => {
        const x = p.x - cx,
            y = p.y - cy;
        return [x * cos - y * sin, x * sin + y * cos];
    };
    const degenerate = (points: [number, number][]) =>
        points.every((p) => Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) < DEGENERATE_LENGTH);

    const solver = new SketchSolver(Plane.XY);
    try {
        for (const element of drawing.elements) {
            for (const subpath of element.subpaths) {
                const edges: { id: number; end: number }[] = [];
                for (const segment of subpath.segments) {
                    const points = segment.points.map(place);
                    if (degenerate(points)) continue;
                    if (segment.kind === "line") {
                        edges.push({ id: solver.addLine(...points[0], ...points[1]), end: 1 });
                        continue;
                    }
                    const added = solver.addBSpline(points, {
                        control: { degree: 3, knots: [0, 1], multiplicities: [4, 4] },
                    });
                    if (!added.isOk) return Result.err(added.error);
                    edges.push({ id: added.value, end: 3 });
                }
                for (const edge of options.lock ? edges : []) {
                    solver.addConstraint({
                        kind: ConstraintKind.Block,
                        refs: [{ entityId: edge.id, pointIndex: 0 }],
                    });
                }
                const joints = options.lock
                    ? 0
                    : subpath.closed && edges.length > 1
                      ? edges.length
                      : edges.length - 1;
                for (let index = 0; index < joints; index++) {
                    solver.addConstraint({
                        kind: ConstraintKind.P2PCoincident,
                        refs: [
                            { entityId: edges[index].id, pointIndex: edges[index].end },
                            { entityId: edges[(index + 1) % edges.length].id, pointIndex: 0 },
                        ],
                    });
                }
            }
        }
        const data = solver.toData();
        if (data.entities.length === 0) return Result.err("The SVG file has no outlines to import");
        return Result.ok({ entities: data.entities, constraints: data.constraints, origin: [0, 0] });
    } finally {
        solver.dispose();
    }
}
