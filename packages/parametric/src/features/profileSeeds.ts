// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, XYZLike } from "@spicy3d/core";
import { profileEdgeEntityIds, profileEntityIds } from "./profileEntities";
import { captureRegionFingerprint } from "./profileRef";
import { MATCH_TOLERANCE } from "./refGeometry";
import { ID_COMPONENT_SEPARATOR } from "./trackedId";

/**
 * Content-derived seed keys for profile regions and their boundary edges.
 *
 * A seed becomes the stem of the stable ids a sweep gives the geometry it generates from
 * a profile (see `sweepProfileTracked` in extrude.ts). It has to be derived from what the
 * region IS, not from where it sits in an enumeration: the kernel is free to re-enumerate
 * faces and edges after any rebuild, and a positional stem would then silently realign
 * onto a neighbour. Entity ids are the sketch's own stable identity, so they are the stem
 * — with a positional ordinal only as the fallback where attribution is unavailable.
 */

/**
 * Seed keys parallel to `all`: `e{id.id...}` of the sorted bounding entity ids,
 * falling back to the positional index when entity ids are unknown. Profiles bounded
 * by the same entity set (crossing-path lens regions) are told apart by an occurrence
 * suffix assigned in region-fingerprint order — content-derived, so the suffix
 * follows the region rather than the kernel's enumeration order. Computed over the
 * FULL profile list: the occurrence suffix of a duplicated entity set must not depend
 * on which profiles the feature selected.
 */
export function profileSeeds(all: IFace[]): string[] {
    const groups = new Map<string, number[]>();
    all.forEach((face, index) => {
        const entities = profileEntityIds(face);
        const key = entities === undefined ? `${index}` : `e${entities.join(".")}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [index]);
        else group.push(index);
    });
    const seeds = new Array<string>(all.length);
    for (const [key, group] of groups) {
        if (group.length === 1) {
            seeds[group[0]] = key;
            continue;
        }
        // Capture once per face: ranking reuses the fingerprint's two kernel queries.
        const ranked = rankRegions(
            group.map((index) => ({ index, region: captureRegionFingerprint(all[index]) })),
        );
        ranked.forEach(({ index }, occurrence) => {
            seeds[index] = occurrence === 0 ? key : `${key}~${occurrence}`;
        });
    }
    return seeds;
}

/**
 * Rank by center x/y/z, then area. On each axis, group coordinates within
 * MATCH_TOLERANCE of the group's minimum before ordering by the next axis.
 * Pairwise fuzzy comparisons are not transitive and can make Array.sort depend on
 * the kernel's enumeration order. Anchoring each group makes its membership deterministic.
 */
function rankRegions(
    regions: { index: number; region: { center: XYZLike; area: number } }[],
    axis = 0,
): typeof regions {
    if (axis === 3) return regions.sort((a, b) => a.region.area - b.region.area);
    const coordinate = ["x", "y", "z"] as const;
    const value = (entry: (typeof regions)[number]) => entry.region.center[coordinate[axis]];
    regions.sort((a, b) => value(a) - value(b));
    const ranked: typeof regions = [];
    for (let start = 0; start < regions.length; ) {
        let end = start + 1;
        while (end < regions.length && value(regions[end]) - value(regions[start]) <= MATCH_TOLERANCE) {
            end++;
        }
        ranked.push(...rankRegions(regions.slice(start, end), axis + 1));
        start = end;
    }
    return ranked;
}

/**
 * Sketch-scoped seeds of a profile face's boundary edges, for the swept sub-shape ids: the seed
 * of each edge is `ent<entityId>` of the sketch entity that generated it.
 *
 * - **Why entity ids, not ordinals.** They survive wire re-enumeration, where positional
 *   ordinals silently realign onto another edge when a mirrored or rewound profile permutes the
 *   edge order. The ordinal remains the fallback only where entity attribution is unavailable
 *   (test mocks).
 * - **Caller contract:** `edges` must be the face's OWN `findSubShapes(ShapeTypes.edge)`
 *   enumeration in the same order — the registered entity attribution
 *   (`profileEdgeEntityIds`) runs parallel to it.
 */
export function profileEdgeSeeds(face: IFace, baseSeed: string, edges: IEdge[]): string[] {
    const entities = profileEdgeEntityIds(face);
    return edges.map((_, index) => {
        const entity = entities?.[index];
        return entity === undefined ? `${baseSeed}:e${index}` : `${baseSeed}:ent${entity}`;
    });
}

/** The entity-seed suffix `profileEdgeSeeds` ends an edge seed with. */
const ENTITY_SEED = /:ent\d+$/;

/**
 * Whether a tracked id (or one component of a compound id) is an edge seed of a sketch entity
 * (`profileEdgeSeeds`) — an identity of the entity itself, not of an edge's position.
 */
export function isEntitySeededId(id: string): boolean {
    return id.split(ID_COMPONENT_SEPARATOR).some((component) => ENTITY_SEED.test(component));
}
