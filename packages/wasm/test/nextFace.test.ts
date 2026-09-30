// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, Matrix4, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";
const factory = createTestFactory();
const planeAt = (x: number, y: number, z: number) =>
    new Plane({ origin: new XYZ({ x, y, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });
const target = (z: number) => unwrapOk(factory.box(planeAt(-5, -5, z), 20, 20, 5));
function next(profile: IShape, candidates: IShape[], offset = 0, start?: { face: IFace; offset: number }) {
    return factory.prismNextTracked(profile, XYZ.unitZ, candidates, offset, start);
}

test("next chooses the nearest complete trimmed face independently of candidate order", () => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const near = target(10);
    const far = target(30);
    try {
        const result = next(profile, [far, near]);
        expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
        expect(result.value.nextTarget).toMatchObject({ candidateIndex: 1 });
        expect(Math.abs(result.value.shape.volume())).toBeCloseTo(160, 4);
        result.value.shape.dispose();
        const reverse = next(profile, [near, far], -2);
        expect(reverse.isOk).toBe(true);
        expect(reverse.value.nextTarget).toMatchObject({ candidateIndex: 0 });
        expect(Math.abs(reverse.value.shape.volume())).toBeCloseTo(128, 4);
        reverse.value.shape.dispose();
    } finally {
        profile.dispose();
        near.dispose();
        far.dispose();
    }
});

test("next ends on the exact cylinder underside before a farther planar body", () => {
    const profile = unwrapOk(factory.rect(planeAt(0, 5, 0), 4, 4));
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitY, new XYZ({ x: 2, y: 0, z: 20 }), 5, 20));
    const far = target(30);
    try {
        const result = next(profile, [far, cylinder]);
        expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
        expect(result.value.nextTarget).toMatchObject({ candidateIndex: 1 });
        const expected = 320 - 4 * (2 * Math.sqrt(21) + 25 * Math.asin(2 / 5));
        expect(Math.abs(result.value.shape.volume())).toBeCloseTo(expected, 3);
        const caps = result.value.shape.findSubShapes(ShapeTypes.face) as IFace[];
        expect(result.value.capFaces?.every((index) => !caps[index].surface().isPlanar())).toBe(true);
        result.value.shape.dispose();
    } finally {
        profile.dispose();
        cylinder.dispose();
        far.dispose();
    }
});

test("full projected coverage accepts a thin curved wall with no common axial cross section", () => {
    const profile = unwrapOk(factory.rect(planeAt(0, 5, 0), 4, 4));
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitY, new XYZ({ x: 2, y: 0, z: 20 }), 5, 20));
    const shifted = cylinder.transformedMul(Matrix4.fromTranslation(0, 0, 0.05));
    try {
        const curved = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (face) => !face.surface().isPlanar(),
        );
        expect(curved).not.toBeUndefined();
        if (curved === undefined) throw new Error("Expected curved start");
        // Cap height varies by more than 0.4 mm; the wall is only 0.05 mm thick.
        expect(20 - Math.sqrt(21) - 15).toBeGreaterThan(0.05);
        const result = next(profile, [shifted], 0, { face: curved, offset: 0 });
        expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
        expect(Math.abs(result.value.shape.volume())).toBeCloseTo(0.8, 4);
        result.value.shape.dispose();
    } finally {
        profile.dispose();
        cylinder.dispose();
        shifted.dispose();
    }
});

test.each(["missing", "partial", "tied", "crossing"])("next reports %s boundaries explicitly", (kind) => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const candidates: IShape[] = [];
    try {
        if (kind === "partial") candidates.push(unwrapOk(factory.box(planeAt(0, 0, 5), 2, 4, 1)), target(20));
        if (kind === "tied") candidates.push(target(10), target(10));
        if (kind === "crossing")
            for (const slope of [-0.2, 0.2])
                candidates.push(
                    unwrapOk(
                        factory.rect(
                            new Plane({
                                origin: new XYZ({ x: 20, y: -20, z: 10 + 18 * slope }),
                                normal: new XYZ({ x: -slope, y: 0, z: 1 }),
                                xvec: XYZ.unitY,
                            }),
                            40,
                            40,
                        ),
                    ),
                );
        const result = next(profile, candidates);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(
            kind === "missing"
                ? /No complete next face/
                : kind === "partial"
                  ? /partial|piecewise/
                  : /ambiguous/,
        );
    } finally {
        profile.dispose();
        for (const shape of candidates) shape.dispose();
    }
});

test("next never reverses direction when every candidate is behind the profile", () => {
    const profile = unwrapOk(factory.rect(planeAt(0, 0, 30), 4, 4));
    const behind = target(10);
    try {
        const result = next(profile, [behind]);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("No complete next face");
    } finally {
        profile.dispose();
        behind.dispose();
    }
});

test("next bounds its valid-tool search after pruning", () => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const candidates = Array.from({ length: 33 }, (_, i) => target(i * 5 + 10));
    try {
        const result = next(profile, candidates);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("32 valid bounded tools");
    } finally {
        profile.dispose();
        for (const shape of candidates) shape.dispose();
    }
});

test("next prunes unrelated bodies before applying candidate limits", () => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const candidates = Array.from({ length: 70 }, () =>
        unwrapOk(factory.box(planeAt(1000, 1000, 10), 4, 4, 5)),
    );
    candidates.push(target(10));
    try {
        const result = next(profile, candidates);
        expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
        expect(result.value.nextTarget?.candidateIndex).toBe(70);
        expect(Math.abs(result.value.shape.volume())).toBeCloseTo(160, 4);
        result.value.shape.dispose();
    } finally {
        profile.dispose();
        for (const shape of candidates) shape.dispose();
    }
});

test("next bounds intersecting candidate bodies even when every face is partial", () => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const candidates = Array.from({ length: 65 }, (_, i) =>
        unwrapOk(factory.rect(planeAt(0, 0, 10 + i), 2, 2)),
    );
    try {
        const result = next(profile, candidates);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("64 intersecting candidate bodies");
    } finally {
        profile.dispose();
        for (const shape of candidates) shape.dispose();
    }
});

test("next bounds intersecting faces within a single candidate compound", () => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const faces = Array.from({ length: 513 }, (_, i) => unwrapOk(factory.rect(planeAt(0, 0, 10 + i), 2, 2)));
    const candidate = unwrapOk(factory.combine(faces));
    try {
        const result = next(profile, [candidate]);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("512 intersecting candidate faces");
    } finally {
        profile.dispose();
        candidate.dispose();
        for (const shape of faces) shape.dispose();
    }
});
