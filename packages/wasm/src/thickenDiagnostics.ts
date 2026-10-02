// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, type ISurface, ShapeTypes, type XYZ } from "@spicy3d/core";

const SAMPLE_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const MAX_FACES = 64;
const NATIVE_TRAP = /aborted|RuntimeError|unreachable|out of bounds|signature mismatch|crashed/i;

type CurvatureRegion = { faceIndex: number; radius: number; point: XYZ };

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
        !/offset|thick\s*solid/i.test(error) ||
        NATIVE_TRAP.test(error)
    ) {
        return error;
    }
    let faces: IFace[] = [];
    let region: CurvatureRegion | undefined;
    let trapped = false;
    try {
        faces = input.findSubShapes(ShapeTypes.face) as IFace[];
        for (const [faceIndex, face] of faces.slice(0, MAX_FACES).entries()) {
            if (openingFaces.some((opening) => face.isSame(opening))) continue;
            const candidate = sampleFace(face, faceIndex, thickness);
            if (candidate && (!region || candidate.radius < region.radius)) region = candidate;
        }
    } catch (failure) {
        // A diagnostic must never replace the actual offset failure.
        trapped = isNativeTrap(failure);
        if (trapped) return error;
    } finally {
        if (!trapped) for (const face of faces) disposeDiagnostic(face);
    }
    const sampled = faces.length > MAX_FACES ? ` (sampled the first 64 of ${faces.length} faces)` : "";
    if (!region) {
        // Keep validation errors verbatim; only an uninformative kernel offset status needs a hint.
        if (!/BRepOffset_|^Failed to create thick solid$/.test(error)) return error;
        return `${error}; local curvature or intersecting offset walls may be responsible. No limiting face was found by bounded sampling${sampled}; reduce |thickness| (${number(Math.abs(thickness))} mm) or smooth the crease. A maximum successful thickness is not known.`;
    }
    const { point, radius, faceIndex } = region;
    return `${error}; possible offset collapse on input face index ${faceIndex} near (${number(point.x)}, ${number(point.y)}, ${number(point.z)}) mm: sampled curvature radius ${number(radius)} mm <= |thickness| ${number(Math.abs(thickness))} mm in the offset direction. Try |thickness| below ${number(radius)} mm or smooth this region; retry with tolerant mode for supported solids. This sampled local limit${sampled} is not a guaranteed maximum successful thickness.`;
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

function sampleFace(face: IFace, faceIndex: number, thickness: number): CurvatureRegion | undefined {
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
        for (const fu of SAMPLE_FRACTIONS) {
            for (const fv of SAMPLE_FRACTIONS) {
                try {
                    const u = u1 + (u2 - u1) * fu;
                    const v = v1 + (v2 - v1) * fv;
                    const d = surface.d2(u, v);
                    if (!face.containsPoint(d.point, true, 1e-6)) continue;
                    const [, normal] = face.normal(u, v);
                    const radius = limitingRadius(d, normal, thickness);
                    if (radius !== undefined && (!region || radius < region.radius)) {
                        region = { faceIndex, radius, point: d.point };
                    }
                } catch (failure) {
                    if (isNativeTrap(failure)) throw failure;
                    // D2 can fail at a C0 knot or a degenerate point; other samples still help.
                }
            }
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
    if (!Number.isFinite(directed) || directed <= 0 || directed * Math.abs(thickness) < 1) {
        return undefined;
    }
    return 1 / directed;
}
