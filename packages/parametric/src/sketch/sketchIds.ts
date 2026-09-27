// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FIRST_EXTERNAL_ENTITY_ID } from "./sketchModel";

/**
 * Sketch entity, external-entity and constraint ids.
 *
 * The ids are the keys the merge of two versions matches sketch items by (docs/merge.md). A counter
 * (`max + 1`, or a per-sketch sequence) would hand the same number to two different lines drawn on
 * two devices from the same base, and an id-keyed merge would silently fuse them. So every id of an
 * item added to an *existing* sketch is drawn at random from a space large enough for two devices
 * never to meet ({@link SKETCH_ID_SPACE}), re-drawn when it hits an id the sketch already holds.
 *
 * The serialized type does not change — still an integer, positive for real entities and
 * constraints, `<= FIRST_EXTERNAL_ENTITY_ID` for external ones — so no document migration is needed
 * and every existing document keeps its ids.
 *
 * {@link sequentialSketchIds} counts instead (1, 2, … and -100, -101, …). It is only for a sketch
 * created in the same edit session, which no other version can hold yet: the ids are unique inside
 * the sketch, and the sketch's own node id (a nanoid) keeps it apart from every other one. The MCP
 * `sketch` op relies on it ("entity ids are the 1-based position in entities").
 */
/** The three id spaces of a sketch: they are independent (an entity and a constraint may share a number). */
export type SketchIdKind = "entity" | "constraint" | "external";

export interface SketchIdAllocator {
    /**
     * A new id of `kind` for which `taken` is false: `> 0` for entities and constraints,
     * `<= FIRST_EXTERNAL_ENTITY_ID` for external entities.
     */
    next(kind: SketchIdKind, taken: (id: number) => boolean): number;
}

/**
 * How many values a random id is drawn from: 2^40. Two devices each adding `n` items to one sketch
 * collide with probability about n² / 2^40 (5·10⁻⁹ for 50 each) — and a collision is still caught
 * by the merge as a `duplicate-id` conflict, never fused. 2^40 keeps ids at most 13 digits (read
 * back by agents through MCP) and far inside `Number.MAX_SAFE_INTEGER`, so JSON and every `number`
 * path stay exact.
 */
export const SKETCH_ID_SPACE = 2 ** 40;

/** The default allocator: collision-checked random ids (see the module comment). */
export const randomSketchIds: SketchIdAllocator = {
    next(kind, taken) {
        for (;;) {
            const offset = Math.floor(Math.random() * SKETCH_ID_SPACE);
            // 1 .. 2^40, or FIRST_EXTERNAL_ENTITY_ID - 1 .. FIRST_EXTERNAL_ENTITY_ID - 2^40
            const id = kind === "external" ? FIRST_EXTERNAL_ENTITY_ID - 1 - offset : offset + 1;
            if (!taken(id)) return id;
        }
    },
};

/**
 * Counting ids — only for a sketch created in this session (see the module comment): entity and
 * constraint ids from 1 up, external ids from `FIRST_EXTERNAL_ENTITY_ID` down, each skipping any id
 * already taken.
 */
export function sequentialSketchIds(): SketchIdAllocator {
    const counters: Record<SketchIdKind, number> = {
        entity: 1,
        constraint: 1,
        external: FIRST_EXTERNAL_ENTITY_ID,
    };
    return {
        next(kind, taken) {
            const step = kind === "external" ? -1 : 1;
            while (taken(counters[kind])) counters[kind] += step;
            const id = counters[kind];
            counters[kind] += step;
            return id;
        },
    };
}

let defaultFactory: () => SketchIdAllocator = () => randomSketchIds;

/** The allocator a solver (or a data-level copy) uses when none is given: {@link randomSketchIds}. */
export function defaultSketchIds(): SketchIdAllocator {
    return defaultFactory();
}

/**
 * Test hook: replaces what {@link defaultSketchIds} returns — one allocator per call, so each solver
 * gets its own (e.g. `sequentialSketchIds`, for suites written against counted ids). Returns a
 * function restoring the previous factory.
 */
export function setDefaultSketchIds(factory: () => SketchIdAllocator): () => void {
    const previous = defaultFactory;
    defaultFactory = factory;
    return () => {
        defaultFactory = previous;
    };
}
