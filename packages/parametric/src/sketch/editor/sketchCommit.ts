// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { SketchData } from "../sketchModel";

/** Compare meaning, not property insertion order. Array order and numeric edits remain significant. */
export function sameSketchData(left: SketchData, right: SketchData, anchors = true): boolean {
    return canonical(normalized(left, anchors)) === canonical(normalized(right, anchors));
}

function normalized(data: SketchData, anchors: boolean): SketchData {
    return {
        ...data,
        entities: data.entities.map((entity) => ({ ...entity, construction: entity.construction ?? false })),
        externalRefs: (data.externalRefs ?? []).map((ref) => ({
            ...ref,
            pinned: ref.pinned ?? false,
            dangling: ref.dangling ?? false,
        })),
        refPositions: data.refPositions ?? {},
        anchors: anchors ? [...(data.anchors ?? [])].sort((a, b) => a.id - b.id) : [],
    };
}

function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
        return Object.fromEntries(
            Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
        );
    });
}
