// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IEdge, type IFace, type IShape, ShapeTypes, XYZ } from "@spicy3d/core";
import { trackCornerSetback } from "../../parametric/src/features/cornerSetbackTracking";
import type { ShapeTracking } from "../../parametric/src/features/feature";
import { OccCylindricalSurface, OccRectangularSurface } from "../src/surface";
import { CORNER_WORKER_DEADLINE_MS } from "../src/workerClient";
import { createBox, createTestConverter, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
const converter = createTestConverter();
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    const previous = owned;
    owned = [];
    for (const value of previous.reverse()) value.dispose();
});

function incidentEdges(shape: IShape): { indexes: number[]; edges: IEdge[] } {
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    owned.push(...edges);
    const indexes = edges.flatMap((edge, index) =>
        edge.startPoint().distanceTo(XYZ.zero) < 1e-6 || edge.endPoint().distanceTo(XYZ.zero) < 1e-6
            ? [index]
            : [],
    );
    expect(indexes).toHaveLength(3);
    return { indexes, edges };
}

describe("bounded fitted corner setbacks", () => {
    test("three unequal distances retain exact strip sections, valid geometry and actual history", () => {
        const box = keep(createBox(factory, 40, 40, 40));
        const { indexes, edges: inputEdges } = incidentEdges(box);
        const distances = [2.49, 2.5, 2.51];
        const mesh = box.mesh;
        expect(mesh.faces).not.toBeUndefined();
        const positions = Array.from(mesh.faces!.position);
        const brep = unwrapOk(converter.convertToBrep(box));
        const started = performance.now();
        const answer = factory.filletCornerSetbackTracked(box, indexes, 2, distances, {
            synchronousProof: true,
        });
        const elapsed = performance.now() - started;
        expect(unwrapOk(converter.convertToBrep(box))).toBe(brep);
        expect(box.mesh).toBe(mesh);
        expect(Array.from(box.mesh.faces!.position)).toEqual(positions);
        const result = unwrapOk(answer);
        console.info("Corner setback measured acceptance", {
            elapsedMs: elapsed,
            boundaryDistanceMm: result.g0Error,
            boundaryAngleRad: result.g1Error,
            occtApproxErrorMm: result.fitDistanceError,
            occtCriterionErrorRad: result.fitAngleError,
        });
        const output = keep(result.shape);
        expect(output.checkShape()).toBe(true);
        expect(output.volume()).toBeGreaterThan(0);
        expect(output.volume()).toBeLessThan(64000);
        expect(elapsed).toBeLessThan(CORNER_WORKER_DEADLINE_MS);
        expect(result.g0Error).toBeLessThanOrEqual(1e-4);
        expect(result.g1Error).toBeLessThanOrEqual(1e-3);
        expect(result.fitDistanceError).toBeLessThanOrEqual(1e-4);
        expect(result.fitAngleError).toBeLessThanOrEqual(1e-3);
        const faces = output.findSubShapes(ShapeTypes.face) as IFace[];
        const edges = output.findSubShapes(ShapeTypes.edge) as IEdge[];
        owned.push(...faces, ...edges);
        expect(result.faceMap).toHaveLength(faces.length);
        expect(result.edgeMap).toHaveLength(edges.length);
        expect(result.cornerFaces).toHaveLength(1);
        expect(result.faceEdgeMap).toHaveLength(faces.length);
        const corner = result.cornerFaces[0];
        const inputFaces = box.findSubShapes(ShapeTypes.face);
        owned.push(...inputFaces);
        const tracking: ShapeTracking = {
            inputFaceIds: inputFaces.map((_, index) => `base:face${index}`),
            inputEdgeIds: inputEdges.map((_, index) => `base:edge${index}`),
            outputFaceIds: [],
            outputEdgeIds: [],
        };
        expect(trackCornerSetback("corner", tracking, indexes, result).isOk).toBe(true);
        expect(tracking.outputFaceIds[corner]).toMatch(/^corner:setback:corner:/);
        const cornerId = tracking.outputFaceIds[corner];
        expect(trackCornerSetback("corner", tracking, [...indexes].reverse(), result).isOk).toBe(true);
        expect(tracking.outputFaceIds[corner]).toBe(cornerId);
        expect(tracking.outputEdgeIds).toHaveLength(edges.length);
        const supports = new Set<number>();
        const ancestors = result.faceAncestors!;
        for (let i = 0; i < ancestors.length; i += 2)
            if (ancestors[i] === corner) supports.add(ancestors[i + 1]);
        expect(supports.size).toBe(3);
        expect(
            result.faceEdgeMap!.filter((edge, face) => face !== corner && edge >= 0).sort((a, b) => a - b),
        ).toEqual([...indexes].sort((a, b) => a - b));
        expect(result.edgeAncestors!.length).toBeGreaterThan(0);
        const radii = faces.flatMap((face) => {
            let surface = keep(face.surface());
            if (surface instanceof OccRectangularSurface) surface = keep(surface.basisSurface());
            return surface instanceof OccCylindricalSurface ? [surface.radius] : [];
        });
        expect(radii).toEqual([2, 2, 2]);
        for (let i = 0; i < indexes.length; i++) {
            const input = inputEdges[indexes[i]];
            const end =
                input.startPoint().distanceTo(XYZ.zero) < 1e-6 ? input.endPoint() : input.startPoint();
            const direction = end.normalize();
            expect(direction).not.toBeUndefined();
            const sections = edges.filter((edge) =>
                [
                    edge.firstParameter(),
                    (edge.firstParameter() + edge.lastParameter()) / 2,
                    edge.lastParameter(),
                ].every(
                    (parameter) => Math.abs(edge.pointAt(parameter).dot(direction!) - distances[i]) <= 1e-4,
                ),
            );
            expect(sections).toHaveLength(1);
            expect(sections[0].length()).toBeCloseTo(Math.PI, 5);
        }
    });

    test.each([
        [0, 10, 10],
        [2, 10, 10],
        [40, 10, 10],
        [NaN, 10, 10],
    ])("invalid setback distances preserve the input %j", (...distances) => {
        const box = keep(createBox(factory, 40, 40, 40));
        const { indexes } = incidentEdges(box);
        const mesh = box.mesh;
        const brep = unwrapOk(converter.convertToBrep(box));
        const answer = factory.filletCornerSetbackTracked(box, indexes, 2, distances, {
            synchronousProof: true,
        });
        expect(answer.isOk).toBe(false);
        expect(answer.error).toMatch(/setback|Setback/);
        expect(unwrapOk(converter.convertToBrep(box))).toBe(brep);
        expect(box.mesh).toBe(mesh);
    });

    test("ordinary browser calls require the cancelable worker instead of entering native fitting", () => {
        const box = keep(createBox(factory, 40, 40, 40));
        const { indexes } = incidentEdges(box);
        const answer = factory.filletCornerSetbackTracked(box, indexes, 2, [2.49, 2.5, 2.51]);
        expect(answer.isOk).toBe(false);
        expect(answer.error).toContain("cancelable worker");
    });
});
