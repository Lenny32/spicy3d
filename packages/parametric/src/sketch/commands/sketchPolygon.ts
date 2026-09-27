// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    Dimensions,
    type IStep,
    Precision,
    PubSub,
    property,
    Result,
    type XYZ,
} from "@spicy3d/core";
import { applyPointAutoConstraints } from "../autoConstraints";
import { ConstraintKind, toUV, toWorld } from "../sketchModel";
import type { SketchSolver } from "../solver";
import { centerRef, lineRefs } from "../solverEntities";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

export function polygonVertices(
    center: [number, number],
    rim: [number, number],
    sides: number,
    inscribed: boolean,
): Result<[number, number][]> {
    const radius = Math.hypot(rim[0] - center[0], rim[1] - center[1]);
    if (
        !Number.isSafeInteger(sides) ||
        sides < 3 ||
        !Number.isFinite(radius) ||
        radius < Precision.Distance
    ) {
        return Result.err("A polygon needs at least three sides and a positive radius");
    }
    const r = inscribed ? radius : radius / Math.cos(Math.PI / sides);
    const start = Math.atan2(rim[1] - center[1], rim[0] - center[0]) - (inscribed ? 0 : Math.PI / sides);
    return Result.ok(
        Array.from({ length: sides }, (_, i) => {
            const angle = start + (i * 2 * Math.PI) / sides;
            return [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)] as [number, number];
        }),
    );
}

/** Equal chords on a circumcircle keep the polygon regular after edits. */
export function addPolygon(
    solver: SketchSolver,
    center: [number, number],
    rim: [number, number],
    sides: number,
    inscribed = true,
): Result<{ circle: number; edges: number[]; entities: number[] }> {
    const vertices = polygonVertices(center, rim, sides, inscribed);
    if (!vertices.isOk) return Result.err(vertices.error);
    const circle = solver.addCircle(...center, Math.hypot(rim[0] - center[0], rim[1] - center[1]));
    solver.setConstruction(circle, true);
    // An equilateral tangential polygon need not be regular. Keep every vertex
    // on a circumcircle in both modes; the incircle touches just the first edge.
    const circumcircle = inscribed
        ? circle
        : solver.addCircle(
              ...center,
              Math.hypot(rim[0] - center[0], rim[1] - center[1]) / Math.cos(Math.PI / sides),
          );
    solver.setConstruction(circumcircle, true);
    if (!inscribed)
        solver.addConstraint({
            kind: ConstraintKind.P2PCoincident,
            refs: [centerRef(circle), centerRef(circumcircle)],
        });
    const edges = vertices.value.map((p, i) => solver.addLine(...p, ...vertices.value[(i + 1) % sides]));
    for (let i = 0; i < sides; i++) {
        const edge = edges[i];
        solver.addConstraint({
            kind: ConstraintKind.P2PCoincident,
            refs: [
                { entityId: edge, pointIndex: 1 },
                { entityId: edges[(i + 1) % sides], pointIndex: 0 },
            ],
        });
        solver.addConstraint({
            kind: ConstraintKind.PointOnCircle,
            refs: [centerRef(edge), centerRef(circumcircle)],
        });
        if (i > 0)
            solver.addConstraint({
                kind: ConstraintKind.EqualLength,
                refs: [...lineRefs(edges[0]), ...lineRefs(edge)],
            });
    }
    if (!inscribed)
        solver.addConstraint({
            kind: ConstraintKind.TangentLineCircle,
            refs: [...lineRefs(edges[0]), centerRef(circle)],
        });
    return Result.ok({ circle, edges, entities: [...new Set([circle, circumcircle, ...edges])] });
}

@command({ key: "sketch.polygon", icon: "icon-polygon" })
export class SketchPolygonCommand extends SketchMultistepCommand {
    @property("regularPolygon.sides")
    get sides(): number {
        return this.getPrivateValue("sides", 6);
    }
    set sides(value: number) {
        if (Number.isSafeInteger(value) && value >= 3) this.setProperty("sides", value);
    }

    @property("sketch.polygon.inscribed")
    get inscribed(): boolean {
        return this.getPrivateValue("inscribed", true);
    }
    set inscribed(value: boolean) {
        this.setProperty("inscribed", value);
    }

    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickCircleCenter"),
            new SketchPointStep("prompt.pickRadius", () => ({
                refPoint: () => this.stepDatas[0].point!,
                dimension: Dimensions.D1,
                preview: this.previewPolygon,
            })),
        ];
    }

    protected executeMainTask(): void {
        const result = addPolygon(this.editor.solver, this.uvOf(0), this.uvOf(1), this.sides, this.inscribed);
        if (!result.isOk) {
            PubSub.default.pub("displayError", result.error);
            return;
        }
        applyPointAutoConstraints(
            this.editor.solver,
            [centerRef(result.value.circle)],
            result.value.entities,
            { pointTolerance: this.editor.screenTolerance() },
        );
        this.editor.solve(true);
        this.editor.commit();
    }

    private readonly previewPolygon = (point: XYZ | undefined) => {
        const center = this.stepDatas[0].point!;
        if (point === undefined) return [this.meshPoint(center)];
        const plane = this.editor.node.plane;
        const vertices = polygonVertices(this.uvOf(0), toUV(plane, point), this.sides, this.inscribed);
        if (!vertices.isOk) return [this.meshPoint(center)];
        const world = vertices.value.map((p) => toWorld(plane, ...p));
        return [
            this.meshPoint(center),
            ...world.map((p, i) => this.meshLine(p, world[(i + 1) % world.length])),
        ];
    };
}
