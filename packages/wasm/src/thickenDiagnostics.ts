// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, type ISurface, ShapeTypes, type XYZ } from "@spicy3d/core";
import { OccSphericalSurface, OccToroidalSurface } from "./surface";

const MAX_FACES = 64;
/** Curvature samples over all sampled faces; a face gets a square grid of 5..32 per side. */
const SAMPLE_BUDGET = 1024;
const MIN_GRID = 5;
const MAX_GRID = 32;
/** Per side of the finer grid around the coarse minimum (spanning one coarse cell each way). */
const REFINE_GRID = 5;
const SELF_INTERSECTION = /intersects itself/i;
const NATIVE_TRAP = /aborted|RuntimeError|unreachable|out of bounds|signature mismatch|crashed/i;

type CurvatureRegion = {
    faceIndex: number;
    radius: number;
    point: XYZ;
    analytic: boolean;
    cavityClass: boolean;
};

/**
 * Behavior-only diagnosis using the existing D2/trimmed-domain bindings. This is a local
 * regularity estimate (1 - thickness * curvature = 0), not an offset feasibility test.
 * Sampling misses narrow creases and cannot diagnose collisions between distant faces.
 * Never retry the offset, change its result, or re-enter a trapped native module.
 */
export function thickenFailureDiagnostic(
    error: string,
    input: IShape,
    thickness: number,
    openingFaces: IShape[] = [],
): string {
    if (
        !Number.isFinite(thickness) ||
        thickness === 0 ||
        !/offset|thick\s*solid|tolerant|intersects itself/i.test(error) ||
        NATIVE_TRAP.test(error)
    ) {
        return error;
    }
    let faces: IFace[] = [];
    let region: CurvatureRegion | undefined;
    let trapped = false;
    try {
        faces = input.findSubShapes(ShapeTypes.face) as IFace[];
        if (error.includes("BRepOffset_C0Geometry")) {
            for (const [faceIndex, face] of faces.slice(0, MAX_FACES).entries()) {
                if (openingFaces.some((opening) => face.isSame(opening))) continue;
                if (hasC0Surface(face)) return continuityDiagnostic(error, faces.length, faceIndex);
            }
            return continuityDiagnostic(error, faces.length);
        }
        const sampledFaces = faces
            .slice(0, MAX_FACES)
            .filter((face) => !openingFaces.some((opening) => face.isSame(opening))).length;
        const grid = Math.max(
            MIN_GRID,
            Math.min(MAX_GRID, Math.floor(Math.sqrt(SAMPLE_BUDGET / Math.max(1, sampledFaces)))),
        );
        for (const [faceIndex, face] of faces.slice(0, MAX_FACES).entries()) {
            if (openingFaces.some((opening) => face.isSame(opening))) continue;
            const candidate = sampleFace(face, faceIndex, thickness, grid);
            if (candidate && (!region || candidate.radius < region.radius)) region = candidate;
        }
    } catch (failure) {
        // A diagnostic must never replace the actual offset failure.
        trapped = isNativeTrap(failure);
        if (trapped) return error;
    } finally {
        if (!trapped) for (const face of faces) disposeDiagnostic(face);
    }
    if (error.includes("BRepOffset_C0Geometry")) return continuityDiagnostic(error, faces.length);
    const sampled = faces.length > MAX_FACES ? ` (sampled the first 64 of ${faces.length} faces)` : "";
    if (!region) {
        // Keep validation errors verbatim; only an uninformative kernel offset status needs a hint.
        if (!/BRepOffset_|^Failed to create thick solid$|Tolerant envelope/.test(error)) return error;
        return `${error}; local curvature or intersecting offset walls may be responsible. No limiting face was found by bounded sampling${sampled}; reduce |thickness| (${number(Math.abs(thickness))} mm) or smooth the crease. A maximum successful thickness is not known.`;
    }
    const { point, radius, faceIndex } = region;
    const at = `input face index ${faceIndex} near (${number(point.x)}, ${number(point.y)}, ${number(point.z)}) mm`;
    if (radius > Math.abs(thickness)) {
        const minimum = `minimum sampled curvature radius toward the offset side ${number(radius)} mm on ${at}, larger than |thickness| ${number(Math.abs(thickness))} mm`;
        if (SELF_INTERSECTION.test(error))
            return `${error}; ${minimum}${sampled}: local curvature does not explain the crossing, so offset walls of separate regions likely meet (a narrow neck, closely spaced or folding sections). Reduce |thickness| or widen the region around the reported intersection. Sampling can miss a crease narrower than its grid.`;
        if (!/BRepOffset_|^Failed to create thick solid$|Tolerant envelope/.test(error)) return error;
        return `${error}; local curvature or intersecting offset walls may be responsible. No limiting face was found by bounded sampling${sampled} (${minimum}); reduce |thickness| (${number(Math.abs(thickness))} mm) or smooth the crease. A maximum successful thickness is not known.`;
    }
    const remedy = !region.analytic
        ? "the free-form crease envelope is not supported by tolerant mode"
        : /tolerant/i.test(error)
          ? "this analytic collapse was not resolved by tolerant mode"
          : input.shapeType === ShapeTypes.solid &&
              faces.length === 1 &&
              openingFaces.length === 0 &&
              region.cavityClass
            ? "retry with tolerant mode for supported analytic solids (complete spheres and ring tori)"
            : "tolerant recovery has not been verified for this solid; do not rely on it for this collapse";
    return `${error}; possible offset collapse on ${at}: sampled curvature radius ${number(radius)} mm <= |thickness| ${number(Math.abs(thickness))} mm in the offset direction. Try |thickness| below ${number(radius)} mm or smooth this region; ${remedy}. This sampled local limit${sampled} is not a guaranteed maximum successful thickness.`;
}

function continuityDiagnostic(error: string, faceCount: number, faceIndex?: number): string {
    const region =
        faceIndex === undefined
            ? `no C0 input face was identified among the first ${Math.min(faceCount, MAX_FACES)} faces`
            : `C0 surface on input face index ${faceIndex}`;
    return `${error}; ${region}. OCCT requires a surface with continuous first derivatives for this offset. Smooth the surface to at least C1 continuity or split it at its internal discontinuities before thickening. Reducing |thickness| does not fix this continuity error.`;
}

function hasC0Surface(face: IFace): boolean {
    let surface: ISurface | undefined;
    let trapped = false;
    try {
        surface = face.surface();
        return surface.continuity() === "c0";
    } catch (failure) {
        trapped = isNativeTrap(failure);
        if (trapped) throw failure;
        return false;
    } finally {
        if (surface && !trapped) disposeDiagnostic(surface);
    }
}

function number(value: number): string {
    return Number(value.toPrecision(4)).toString();
}

function isNativeTrap(error: unknown): boolean {
    return (
        error instanceof WebAssembly.RuntimeError ||
        (error instanceof Error && NATIVE_TRAP.test(error.message))
    );
}

function disposeDiagnostic(value: IShape | ISurface): void {
    try {
        value.dispose();
    } catch {
        // Retired handles cannot be released; preserve the operation's error.
    }
}

/**
 * The smallest curvature radius toward the offset side over a `grid` x `grid` sample of the
 * face's trimmed domain, then a finer grid around that sample (one coarse cell each way).
 */
function sampleFace(
    face: IFace,
    faceIndex: number,
    thickness: number,
    grid: number,
): CurvatureRegion | undefined {
    let surface: ISurface | undefined;
    let region: CurvatureRegion | undefined;
    let trapped = false;
    try {
        surface = face.surface();
        if (surface.isPlanar()) return undefined;
        const trimmed = face.inspectionUVBounds?.();
        if (trimmed && !trimmed.isOk) return undefined;
        const bounds = trimmed ? trimmed.value : surface.bounds();
        const { u1, u2, v1, v2 } = bounds;
        if (![u1, u2, v1, v2].every(Number.isFinite) || u2 <= u1 || v2 <= v1) return undefined;
        const queried = surface;
        // Written from `sample`; a plain `let` would stay narrowed to undefined after the loops.
        const minimum: { best?: { u: number; v: number; radius: number; point: XYZ } } = {};
        const sample = (u: number, v: number) => {
            try {
                const d = queried.d2(u, v);
                if (!face.containsPoint(d.point, true, 1e-6)) return;
                const [, normal] = face.normal(u, v);
                const radius = limitingRadius(d, normal, thickness);
                if (radius !== undefined && (!minimum.best || radius < minimum.best.radius))
                    minimum.best = { u, v, radius, point: d.point };
            } catch (failure) {
                if (isNativeTrap(failure)) throw failure;
                // D2 can fail at a C0 knot or a degenerate point; other samples still help.
            }
        };
        const du = (u2 - u1) / grid;
        const dv = (v2 - v1) / grid;
        for (let i = 0; i < grid; i++) {
            for (let j = 0; j < grid; j++) sample(u1 + du * (i + 0.5), v1 + dv * (j + 0.5));
        }
        const coarse = minimum.best;
        if (coarse) {
            for (let i = 0; i < REFINE_GRID; i++) {
                for (let j = 0; j < REFINE_GRID; j++) {
                    const u = coarse.u + du * ((2 * i) / (REFINE_GRID - 1) - 1);
                    const v = coarse.v + dv * ((2 * j) / (REFINE_GRID - 1) - 1);
                    if (u >= u1 && u <= u2 && v >= v1 && v <= v2 && (u !== coarse.u || v !== coarse.v))
                        sample(u, v);
                }
            }
        }
        const found = minimum.best;
        if (found) {
            region = {
                faceIndex,
                radius: found.radius,
                point: found.point,
                analytic: surface.isAnalytic?.() === true,
                cavityClass:
                    surface instanceof OccSphericalSurface ||
                    (surface instanceof OccToroidalSurface && surface.majorRadius > surface.minorRadius),
            };
        }
    } catch (failure) {
        trapped = isNativeTrap(failure);
        if (trapped) throw failure;
        // Missing geometry or domain: leave this face undiagnosed.
    } finally {
        if (surface && !trapped) disposeDiagnostic(surface);
    }
    return region;
}

/**
 * The radius of the sharpest principal curvature bending toward the offset side (undefined
 * when the surface bends away from it or is flat there). The offset collapses where it is at
 * most |thickness| (1 - thickness * curvature = 0).
 */
function limitingRadius(d: ReturnType<ISurface["d2"]>, normal: XYZ, thickness: number): number | undefined {
    if (normal.length() < 0.5) return undefined;
    // Eigenvalues of the second fundamental form relative to the first, with the face's
    // oriented normal. The sign matters: convex faces collapse inward, concave ones outward.
    const e = d.d1u.dot(d.d1u);
    const f = d.d1u.dot(d.d1v);
    const g = d.d1v.dot(d.d1v);
    const determinant = e * g - f * f;
    if (determinant <= 1e-12 * e * g || determinant <= 0) return undefined;
    const l = d.d2u.dot(normal);
    const m = d.d2uv.dot(normal);
    const n = d.d2v.dot(normal);
    const mean = (g * l - 2 * f * m + e * n) / (2 * determinant);
    const gaussian = (l * n - m * m) / determinant;
    const spread = Math.sqrt(Math.max(0, mean * mean - gaussian));
    const directed = Math.max((mean + spread) * Math.sign(thickness), (mean - spread) * Math.sign(thickness));
    if (!Number.isFinite(directed) || directed <= 0) return undefined;
    return 1 / directed;
}
