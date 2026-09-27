// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isRecord, type Json } from "./json";
import type { MergeValueRule } from "./rules";

// Path and label helpers shared by the merge, the integrity pass and the diff, so a conflict and a
// change about the same thing get the same path (docs/merge.md, "Paths").

function escapeSegment(segment: string | number): string {
    return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** `base` extended by `segments` (escaped); `base` "" starts a path (its first segment is a root). */
export function joinPath(base: string, ...segments: readonly (string | number)[]): string {
    const tail = segments.map(escapeSegment).join("/");
    if (base === "") return tail;
    return tail === "" ? base : `${base}/${tail}`;
}

/** The path segments of the n-th (1-based) item of one key: `[key]`, then `[key, "#2"]`, … (acts). */
export function keySegments(key: string | number, occurrence: number): (string | number)[] {
    return occurrence <= 1 ? [key] : [key, `#${occurrence}`];
}

/** Where a field of an object merged by `fieldRule` lives: lists and segmented maps name their own items. */
export function fieldPath(
    objectPath: string,
    prefix: readonly string[],
    field: string,
    fieldRule: MergeValueRule | undefined,
): string {
    if (fieldRule?.kind === "list") return objectPath;
    if (fieldRule?.kind === "map" && fieldRule.segment !== undefined) return objectPath;
    return joinPath(objectPath, ...prefix, field);
}

/** Path segments inserted before an item's fields: a feature's parameters are `…/param/<key>`. */
export function itemFieldPrefix(segment: string): string[] {
    return segment === "feature" ? ["param"] : [];
}

/** The label of a list item (docs/merge.md, "Conflicts": `args[0]`). */
export function itemLabel(segment: string, item: unknown, key: unknown): string {
    const record: Json = isRecord(item) ? item : {};
    const name = typeof record["name"] === "string" && record["name"] !== "" ? record["name"] : undefined;
    switch (segment) {
        case "feature":
            return name ?? `${String(record["type"] ?? "feature")} ${String(key)}`;
        case "entity":
            return `${String(record["type"] ?? "entity")} ${String(key)}`;
        case "constraint":
        case "external":
        case "anchor":
            return `${segment} ${String(key)}`;
        case "variable":
        case "act":
        case "material":
        case "component":
            return name ?? String(key);
        default:
            return name ?? `${segment} ${String(key)}`;
    }
}

/** A node's label: its name, else its class. */
export function nodeLabel(node: unknown, id: string): string {
    if (!isRecord(node)) return id;
    const name = node["name"];
    if (typeof name === "string" && name !== "") return name;
    return String(node["__cla$$__"] ?? id);
}
