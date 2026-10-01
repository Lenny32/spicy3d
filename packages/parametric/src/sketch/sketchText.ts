// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@spicy3d/core";
import { defaultSketchIds, type SketchIdAllocator } from "./sketchIds";
import type { SketchData } from "./sketchModel";
import { type TextOutlineOptions, textContours } from "./textGeometry";

/** Editable text, independent of the constraint solver. All dimensions are sketch UV millimetres. */
export interface SketchTextData extends TextOutlineOptions {
    id: number;
    frame: { width: number; height: number };
    /** Stable contour slots, including retired slots after shortening text. Never reused by entities. */
    profileIds: number[];
}

export type SketchTextSettings = Omit<SketchTextData, "id" | "profileIds">;

export function textIds(data: Pick<SketchData, "texts">): number[] {
    return (data.texts ?? []).flatMap((text) => [text.id, ...text.profileIds]);
}

/** Shared by UI and script callers: validate first, then allocate only missing contour identities. */
export function createSketchText(
    data: SketchData,
    settings: SketchTextSettings,
    previous?: SketchTextData,
    allocator: SketchIdAllocator = defaultSketchIds(),
): Result<SketchTextData> {
    const contours = textContours(settings);
    if (!contours.isOk) return Result.err(contours.error);
    const taken = new Set([...data.entities.map((e) => e.id), ...textIds(data)]);
    const next = () => {
        const id = allocator.next("entity", (candidate) => taken.has(candidate));
        taken.add(id);
        return id;
    };
    const id = previous?.id ?? next();
    const profileIds = [...(previous?.profileIds ?? [])];
    while (profileIds.length < contours.value.length) profileIds.push(next());
    return Result.ok({ ...structuredClone(settings), id, profileIds });
}

export function textFramePoints(text: TextOutlineOptions): [number, number][] {
    const { width, height } = text.frame ?? { width: 0, height: text.height };
    return [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
    ].map(([u, v]) => textWorldPoint(text, u, v));
}

export function textWorldPoint(text: TextOutlineOptions, u: number, v: number): [number, number] {
    const radians = ((text.angle % 360) * Math.PI) / 180;
    return [
        text.x + u * Math.cos(radians) - v * Math.sin(radians),
        text.y + u * Math.sin(radians) + v * Math.cos(radians),
    ];
}

export function textRotationPoint(text: SketchTextData): [number, number] {
    return textWorldPoint(text, text.frame.width / 2, text.frame.height + text.height);
}

export function textContains(text: SketchTextData, [x, y]: [number, number], tolerance = 0): boolean {
    const angle = (-(text.angle % 360) * Math.PI) / 180;
    const dx = x - text.x,
        dy = y - text.y;
    const u = dx * Math.cos(angle) - dy * Math.sin(angle);
    const v = dx * Math.sin(angle) + dy * Math.cos(angle);
    return (
        u >= -tolerance &&
        v >= -tolerance &&
        u <= text.frame.width + tolerance &&
        v <= text.frame.height + tolerance
    );
}
