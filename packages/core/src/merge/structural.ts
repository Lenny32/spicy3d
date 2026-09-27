// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isBlobRef } from "../documentManifest";
import type { I18nKeys } from "../i18n";
import { type DocumentView, type ParsedPayload, payloadProperties, type SideName } from "./documentView";
import { isAbsent, isRecord, type Json, JsonEquality, PositionMarker, preferInline } from "./json";
import { mergeOrder, START } from "./listOrder";
import { fieldPath, itemFieldPrefix, itemLabel, joinPath, keySegments, nodeLabel } from "./paths";
import type { MergeRuleRegistry, MergeValueRule } from "./rules";
import { CONFLICT_MESSAGE_KEYS, type ConflictKind, type MergeConflict, type ResolutionChoice } from "./types";

// The structural three-way merge (docs/merge.md, "Pipeline" steps 2–4): document fields, the
// document lists, the node set, every node's properties and payloads, the tree. Rule-driven: the
// registry says how each value merges; this interprets it. Pure — the inputs are read, never
// written; merged objects are fresh (their leaves may be shared with the inputs).

/** Conflict order (docs/merge.md, "Conflicts"): document fields, variables, acts, materials, components, nodes, rebuilds. */
export enum Section {
    Document = 0,
    Variables = 1,
    Acts = 2,
    Materials = 3,
    Components = 4,
    Nodes = 5,
    Rebuild = 6,
}

export interface Scope {
    readonly section: Section;
    readonly nodeId?: string;
    /** The label of the innermost item (`args[0]` of its conflicts). */
    readonly label: string;
    /** Path segments before the fields of the object merged next (`param` for a feature). */
    readonly fieldPrefix?: readonly string[];
    /** The body a `timeline-position` value counts features of (a `refPositions` key). */
    readonly positionBody?: string;
    /** The enclosing object on each side, for `timeline-position` with `bodyFrom: "nodeId"`. */
    readonly siblings?: readonly [unknown, unknown, unknown];
}

export interface PendingConflict {
    readonly conflict: MergeConflict;
    readonly section: Section;
    readonly nodeId?: string;
    readonly seq: number;
}

/** A JSON payload of a merged node, kept parsed until the document is serialized. */
export class MergedPayload {
    constructor(
        readonly payload: string,
        public value: unknown,
        /** The payload as each side had it (for byte-identical output when it is unchanged). */
        readonly sides: readonly [
            ParsedPayload | undefined,
            ParsedPayload | undefined,
            ParsedPayload | undefined,
        ],
        readonly raws: readonly [unknown, unknown, unknown],
    ) {}
}

export interface MergeViews {
    readonly base: DocumentView;
    readonly ours: DocumentView;
    readonly theirs: DocumentView;
}

export interface StructuralResult {
    /** The merged document; JSON payloads are {@link MergedPayload}s, positions {@link PositionMarker}s. */
    readonly document: Json;
    /** Merged node ids in pre-order. */
    readonly order: readonly string[];
    readonly conflicts: readonly PendingConflict[];
}

type ListRule = Extract<MergeValueRule, { kind: "list" }>;
type ObjectRule = Extract<MergeValueRule, { kind: "object" }>;

const SIDE_CHOICES: readonly ResolutionChoice[] = ["ours", "theirs"];
const INSERT_CHOICES: readonly ResolutionChoice[] = ["ours-first", "theirs-first", "ours", "theirs"];
const SIDES: readonly SideName[] = ["base", "ours", "theirs"];

/** Keys of `values` in first-seen order (ours' keys first, then theirs' new ones, then base's). */
function unionKeys(...values: unknown[]): string[] {
    const keys = new Set<string>();
    for (const value of values) if (isRecord(value)) for (const key of Object.keys(value)) keys.add(key);
    return [...keys];
}

/** The value with every position marker replaced by the number it stood for (conflict values). */
export function rawOf(value: unknown): unknown {
    if (value instanceof PositionMarker) return value.raw;
    if (Array.isArray(value)) return value.some(hasMarker) ? value.map(rawOf) : value;
    if (isRecord(value) && hasMarker(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rawOf(item)]));
    }
    return isAbsent(value) ? undefined : value;
}

function hasMarker(value: unknown): boolean {
    if (value instanceof PositionMarker) return true;
    if (Array.isArray(value)) return value.some(hasMarker);
    if (isRecord(value)) return Object.values(value).some(hasMarker);
    return false;
}

/** Whether a rule has timeline positions in it (then equal-looking values may still differ). */
function hasPositions(rule: MergeValueRule | undefined): boolean {
    if (rule === undefined) return false;
    switch (rule.kind) {
        case "timeline-position":
            return true;
        case "atomic":
            return hasPositions(rule.of);
        case "object":
            return Object.values(rule.fields).some(hasPositions) || hasPositions(rule.rest);
        case "union":
            return Object.values(rule.variants).some(hasPositions) || hasPositions(rule.fallback);
        case "list":
            return hasPositions(rule.item);
        case "map":
            return hasPositions(rule.value);
        default:
            return false;
    }
}

/** A position inside an atomic value (a `ConstructionRef.featureIndex`): its body is the object's `nodeId`. */
function isDeepPositionRule(rule: MergeValueRule | undefined): boolean {
    if (rule === undefined) return false;
    if (rule.kind === "atomic") return isDeepPositionRule(rule.of);
    if (rule.kind === "object") {
        return Object.values(rule.fields).some(
            (field) => field.kind === "timeline-position" && field.bodyFrom === "nodeId",
        );
    }
    return false;
}

export class StructuralMerge {
    readonly eq = new JsonEquality();
    private readonly conflicts: PendingConflict[] = [];
    private seq = 0;

    constructor(
        private readonly views: MergeViews,
        private readonly rules: MergeRuleRegistry,
        /** The user's resolutions, by conflict path. */
        private readonly choices: ReadonlyMap<string, ResolutionChoice>,
        /** Item paths taken whole from one side (a dangling-ref or duplicate-name resolution). */
        private readonly forces: ReadonlyMap<string, SideName>,
    ) {}

    run(): StructuralResult {
        const { base, ours, theirs } = this.views;
        const [b, o, t] = [base.data, ours.data, theirs.data];
        const documentRule = this.rules.classRule("Document")?.properties ?? {};
        const scope: Scope = { section: Section.Document, label: String(o["name"] ?? "") };
        const out: Json = {};
        let order: string[] = [];
        for (const key of unionKeys(o, t, b)) {
            let value: unknown;
            switch (key) {
                case "__cla$$__":
                case "id":
                case "formatVersion":
                case "moduleVersions":
                    // all inputs are migrated to this build's format; the id is checked equal beforehand
                    value = o[key] ?? t[key];
                    break;
                case "name":
                    value = this.value({ kind: "lww" }, b[key], o[key], t[key], "doc/name", scope, key);
                    break;
                case "models": {
                    const tree = this.tree();
                    order = tree.order;
                    value = this.models(tree.nodes);
                    break;
                }
                case "variables": {
                    const rule = documentRule["variables"];
                    value = this.list(
                        rule?.kind === "list"
                            ? rule
                            : {
                                  kind: "list",
                                  key: "id",
                                  order: "stable",
                                  segment: "variable",
                                  item: { kind: "atomic" },
                              },
                        b[key],
                        o[key],
                        t[key],
                        "",
                        { section: Section.Variables, label: "" },
                        "doc/variables",
                    );
                    break;
                }
                case "acts":
                    value = this.recordList("acts", "act", "name", Section.Acts, b[key], o[key], t[key]);
                    break;
                case "settings":
                case "userData":
                    value = this.value(
                        documentRule[key] ?? { kind: "map", value: { kind: "atomic" }, segment: key },
                        b[key],
                        o[key],
                        t[key],
                        "doc",
                        scope,
                        key,
                    );
                    break;
                default:
                    value = this.value(undefined, b[key], o[key], t[key], joinPath("doc", key), scope, key);
            }
            if (value !== undefined) out[key] = value;
        }
        return { document: out, order, conflicts: this.conflicts };
    }

    // ------------------------------------------------------------------ Conflicts

    private push(conflict: MergeConflict, scope: Scope): void {
        this.conflicts.push({ conflict, section: scope.section, nodeId: scope.nodeId, seq: this.seq++ });
    }

    private makeConflict(
        kind: ConflictKind,
        path: string,
        values: readonly [unknown, unknown, unknown],
        args: readonly unknown[],
        choices: readonly ResolutionChoice[] = SIDE_CHOICES,
        messageKey: I18nKeys = CONFLICT_MESSAGE_KEYS[kind],
    ): MergeConflict {
        return {
            kind,
            path,
            base: rawOf(values[0]),
            ours: rawOf(values[1]),
            theirs: rawOf(values[2]),
            messageKey,
            args,
            choices,
        };
    }

    private isBlobValue(value: unknown): boolean {
        if (isBlobRef(value)) return true;
        if (!isRecord(value)) return false;
        const className = value["__cla$$__"];
        return typeof className === "string" && this.rules.classRule(className)?.strategy === "blob";
    }

    // ------------------------------------------------------------------ Values

    /**
     * The three-way rule on one value (docs/merge.md): equal → it; one side changed → that side;
     * both, differently → a conflict of `kind` (merged: ours, or theirs when so resolved).
     * `raws` are the values reported in the conflict when the compared ones are normalized.
     */
    private three(
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
        kind: ConflictKind = "property",
        raws: readonly [unknown, unknown, unknown] = [b, o, t],
    ): unknown {
        if (this.eq.equals(o, t)) return isAbsent(o) ? undefined : preferInline(o, t);
        if (this.eq.equals(o, b)) return isAbsent(t) ? undefined : t;
        if (this.eq.equals(t, b)) return isAbsent(o) ? undefined : o;
        const blob = kind === "blob" || [b, o, t].some((x) => this.isBlobValue(x));
        this.push(this.makeConflict(blob ? "blob" : kind, path, raws, [scope.label, field]), scope);
        const picked = this.choices.get(path) === "theirs" ? t : o;
        return isAbsent(picked) ? undefined : picked;
    }

    private defaultRule(value: unknown): MergeValueRule {
        if (isBlobRef(value)) return { kind: "blob" };
        if (isRecord(value)) {
            const className = value["__cla$$__"];
            if (typeof className === "string" && this.rules.classRule(className)?.strategy === "blob") {
                return { kind: "blob" };
            }
            return { kind: "atomic" };
        }
        return Array.isArray(value) ? { kind: "atomic" } : { kind: "scalar" };
    }

    value(
        rule: MergeValueRule | undefined,
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
    ): unknown {
        const forced = this.forces.get(path);
        if (forced !== undefined) {
            const value = [b, o, t][SIDES.indexOf(forced)];
            return isAbsent(value) ? undefined : value;
        }
        const r = rule ?? this.defaultRule(isAbsent(o) ? (isAbsent(t) ? b : t) : o);
        switch (r.kind) {
            case "scalar":
            case "expression":
            case "ref":
                return this.three(b, o, t, path, scope, field);
            case "atomic":
                return this.atomic(r, b, o, t, path, scope, field);
            case "blob":
                return this.three(b, o, t, path, scope, field, "blob");
            case "lww":
                if (this.eq.equals(o, t) || this.eq.equals(t, b)) return isAbsent(o) ? undefined : o;
                return isAbsent(t) ? undefined : t;
            case "max":
            case "min": {
                if (this.eq.equals(o, t) || this.eq.equals(t, b)) return isAbsent(o) ? undefined : o;
                if (this.eq.equals(o, b)) return isAbsent(t) ? undefined : t;
                // both changed: the larger / smaller number; a side that dropped the counter wins
                if (typeof o === "number" && typeof t === "number") {
                    return r.kind === "max" ? Math.max(o, t) : Math.min(o, t);
                }
                return undefined;
            }
            case "derived":
                if (this.eq.equals(o, b)) return isAbsent(t) ? undefined : t;
                return isAbsent(o) ? undefined : o;
            case "timeline-position":
                return this.position(r.bodyFrom, b, o, t, path, scope, field);
            case "parent":
                return isAbsent(o) ? (isAbsent(t) ? undefined : t) : o;
            case "object":
                return this.object(r, b, o, t, path, scope, field);
            case "union":
                return this.union(r, b, o, t, path, scope, field);
            case "list":
                return this.list(r, b, o, t, path, scope, path);
            case "map":
                return this.map(r, b, o, t, path, scope, field);
            case "json":
                // a JSON payload nested in a payload: one value (payload rules never nest)
                return this.three(b, o, t, path, scope, field);
        }
    }

    private atomic(
        rule: MergeValueRule,
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
    ): unknown {
        if (!isDeepPositionRule(rule)) return this.three(b, o, t, path, scope, field);
        const [nb, no, nt] = [b, o, t].map((value, index) => this.normalizeRefs(value, SIDES[index]));
        return this.three(nb, no, nt, path, scope, field, "property", [b, o, t]);
    }

    /** Timeline positions inside a value (every object with a `nodeId` and a numeric `featureIndex`) as markers. */
    private normalizeRefs(value: unknown, side: SideName): unknown {
        if (Array.isArray(value)) {
            const items = value.map((item) => this.normalizeRefs(item, side));
            return items.some((item, index) => item !== value[index]) ? items : value;
        }
        if (!isRecord(value)) return value;
        let copy: Json | undefined;
        for (const [key, item] of Object.entries(value)) {
            let next = this.normalizeRefs(item, side);
            if (key === "featureIndex" && typeof item === "number" && typeof value["nodeId"] === "string") {
                next = this.marker(value["nodeId"], side, item, false);
            }
            if (next !== item) {
                copy ??= { ...value };
                copy[key] = next;
            }
        }
        return copy ?? value;
    }

    /** A feature count on `side` as the feature it follows there (docs/merge.md, "Timeline positions"). */
    private marker(body: string, side: SideName, raw: number, droppable: boolean): PositionMarker {
        const list = this.views[side].timeline(body);
        let anchor: string | null | undefined;
        if (list !== undefined)
            anchor = raw <= 0 || list.length === 0 ? null : list[Math.min(raw, list.length) - 1];
        return new PositionMarker(body, anchor, side, raw, droppable);
    }

    private position(
        bodyFrom: "key" | "nodeId",
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
    ): unknown {
        const values = [b, o, t].map((value, index) => {
            const body =
                bodyFrom === "key"
                    ? scope.positionBody
                    : (scope.siblings?.[index] as Json | undefined)?.["nodeId"];
            return typeof value === "number" && typeof body === "string"
                ? this.marker(body, SIDES[index], value, bodyFrom === "key")
                : value;
        });
        return this.three(values[0], values[1], values[2], path, scope, field, "property", [b, o, t]);
    }

    /** Presence of a container three-way: kept unless one side removed it and the other left it alone. */
    private present(b: unknown, o: unknown, t: unknown): boolean {
        const [pb, po, pt] = [b, o, t].map((x) => !isAbsent(x));
        if (po === pt) return po;
        return po === pb ? pt : po;
    }

    private object(
        rule: ObjectRule,
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
    ): unknown {
        const prefix = scope.fieldPrefix ?? [];
        const inner: Scope = { ...scope, fieldPrefix: undefined };
        if (rule.atomic) return this.atomic(rule, b, o, t, path, inner, field);
        const values = [b, o, t];
        if (values.some((x) => !isAbsent(x) && !isRecord(x))) return this.three(b, o, t, path, inner, field);
        if (isAbsent(o) && isAbsent(t)) return undefined;
        // removed on one side, kept on the other: the whole object is one value
        if (isAbsent(o) !== isAbsent(t) && !isAbsent(b)) return this.three(b, o, t, path, inner, field);

        const groupOf = new Map<string, string>();
        for (const [group, fields] of Object.entries(rule.groups ?? {})) {
            for (const name of fields) groupOf.set(name, group);
        }
        const done = new Set<string>();
        const siblings = [b, o, t] as const;
        const out: Json = {};
        for (const key of unionKeys(o, t, b)) {
            const group = groupOf.get(key);
            if (group !== undefined) {
                if (done.has(group)) continue;
                done.add(group);
                const fields = rule.groups![group];
                const pick = (value: unknown): Json | undefined => {
                    if (!isRecord(value)) return undefined;
                    const picked: Json = {};
                    for (const name of fields) if (!isAbsent(value[name])) picked[name] = value[name];
                    return Object.keys(picked).length > 0 ? picked : undefined;
                };
                const groupRule: MergeValueRule = {
                    kind: "object",
                    atomic: true,
                    fields: Object.fromEntries(
                        fields.map((name) => [name, rule.fields[name] ?? { kind: "atomic" }]),
                    ),
                };
                const deep = fields.some((name) => hasPositions(rule.fields[name]));
                const chosen = this.atomic(
                    deep ? { kind: "atomic", of: CONSTRUCTION_POSITIONS } : groupRule,
                    pick(b),
                    pick(o),
                    pick(t),
                    joinPath(path, ...prefix, group),
                    inner,
                    group,
                );
                if (isRecord(chosen))
                    for (const name of fields) if (!isAbsent(chosen[name])) out[name] = chosen[name];
                continue;
            }
            const fieldRule = rule.fields[key] ?? rule.rest;
            const value = this.value(
                fieldRule,
                isRecord(b) ? b[key] : undefined,
                isRecord(o) ? o[key] : undefined,
                isRecord(t) ? t[key] : undefined,
                fieldPath(path, prefix, key, fieldRule),
                { ...inner, siblings },
                key,
            );
            if (value !== undefined) out[key] = value;
        }
        return out;
    }

    private union(
        rule: Extract<MergeValueRule, { kind: "union" }>,
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
    ): unknown {
        const present = [b, o, t].filter((x) => !isAbsent(x));
        if (present.some((x) => !isRecord(x))) return this.three(b, o, t, path, scope, field);
        const tags = new Set(present.map((x) => JSON.stringify((x as Json)[rule.tag] ?? null)));
        if (tags.size > 1) return this.three(b, o, t, path, { ...scope, fieldPrefix: undefined }, rule.tag);
        const tag = present.length > 0 ? (present[0] as Json)[rule.tag] : undefined;
        const variant = (typeof tag === "string" ? rule.variants[tag] : undefined) ?? rule.fallback;
        return this.value(variant, b, o, t, path, scope, field);
    }

    private map(
        rule: Extract<MergeValueRule, { kind: "map" }>,
        b: unknown,
        o: unknown,
        t: unknown,
        path: string,
        scope: Scope,
        field: string,
    ): unknown {
        const inner: Scope = { ...scope, fieldPrefix: undefined };
        if ([b, o, t].some((x) => !isAbsent(x) && !isRecord(x)))
            return this.three(b, o, t, path, inner, field);
        if (isAbsent(o) && isAbsent(t)) return undefined;
        const out: Json = {};
        for (const key of unionKeys(o, t, b)) {
            const entryPath =
                rule.segment !== undefined ? joinPath(path, rule.segment, key) : joinPath(path, key);
            const value = this.value(
                rule.value,
                isRecord(b) ? b[key] : undefined,
                isRecord(o) ? o[key] : undefined,
                isRecord(t) ? t[key] : undefined,
                entryPath,
                { ...inner, positionBody: key },
                key,
            );
            if (value !== undefined) out[key] = value;
        }
        if (Object.keys(out).length === 0 && !this.present(b, o, t)) return undefined;
        return out;
    }

    // ------------------------------------------------------------------ Id-keyed lists

    private keysOf(
        items: unknown,
        keyField: string,
        repeats: boolean,
    ):
        | {
              keys: string[];
              items: Map<string, unknown>;
              raw: Map<string, unknown>;
              segments: Map<string, (string | number)[]>;
          }
        | undefined {
        const result = { keys: [] as string[], items: new Map(), raw: new Map(), segments: new Map() };
        if (isAbsent(items)) return result;
        if (!Array.isArray(items)) return undefined;
        const counts = new Map<string, number>();
        for (const item of items) {
            if (!isRecord(item)) return undefined;
            const key = item[keyField];
            if (typeof key !== "string" && typeof key !== "number") return undefined;
            const base = `${typeof key === "number" ? "n" : "s"}:${key}`;
            const occurrence = (counts.get(base) ?? 0) + 1;
            counts.set(base, occurrence);
            if (occurrence > 1 && !repeats) return undefined;
            const id = occurrence > 1 ? `${base}\u0000${occurrence}` : base;
            result.keys.push(id);
            result.items.set(id, item);
            result.raw.set(id, key);
            result.segments.set(id, keySegments(key, occurrence));
        }
        return result;
    }

    /**
     * An id-keyed list (docs/merge.md, "Ordered, id-keyed lists"). `ownerPath` prefixes the item
     * paths (`""` for the document's top-level lists: `variable/<id>`); `atomicPath` is where the
     * whole list conflicts when it cannot be keyed (an item without a key, a repeated key).
     */
    list(
        rule: ListRule,
        b: unknown,
        o: unknown,
        t: unknown,
        ownerPath: string,
        scope: Scope,
        atomicPath: string,
        itemRuleOf: (items: readonly [unknown, unknown, unknown]) => MergeValueRule | undefined = () =>
            rule.item,
    ): unknown[] | undefined {
        const inner: Scope = { ...scope, fieldPrefix: undefined };
        const repeats = rule.segment === "act";
        const [kb, ko, kt] = [b, o, t].map((x) => this.keysOf(x, rule.key, repeats));
        if (kb === undefined || ko === undefined || kt === undefined) {
            return this.three(b, o, t, atomicPath, inner, rule.segment) as unknown[] | undefined;
        }
        if (isAbsent(o) && isAbsent(t) && isAbsent(b)) return undefined;
        const segmentsOf = (key: string) =>
            ko.segments.get(key) ?? kt.segments.get(key) ?? kb.segments.get(key)!;
        const rawOfKey = (key: string) => ko.raw.get(key) ?? kt.raw.get(key) ?? kb.raw.get(key);
        const itemPath = (key: string) => joinPath(ownerPath, rule.segment, ...segmentsOf(key));
        const union = [...new Set([...ko.keys, ...kt.keys, ...kb.keys])];

        // 1. Which items the list keeps, and from which sides their content comes.
        const keep = new Set<string>();
        const contentSides = new Map<string, [unknown, unknown, unknown]>();
        const presenceConflicts = new Map<string, MergeConflict>();
        for (const key of union) {
            const [bi, oi, ti] = [kb.items.get(key), ko.items.get(key), kt.items.get(key)];
            const path = itemPath(key);
            const label = itemLabel(rule.segment, oi ?? ti ?? bi, rawOfKey(key));
            const forced = this.forces.get(path);
            const only = (side: SideName): [unknown, unknown, unknown] =>
                side === "base"
                    ? [bi, undefined, undefined]
                    : side === "ours"
                      ? [undefined, oi, undefined]
                      : [undefined, undefined, ti];
            if (forced !== undefined) {
                if ([bi, oi, ti][SIDES.indexOf(forced)] !== undefined) {
                    keep.add(key);
                    contentSides.set(key, only(forced));
                }
                continue;
            }
            const choice = this.choices.get(path);
            if (bi === undefined) {
                if (oi !== undefined && ti !== undefined && !this.eq.equals(oi, ti)) {
                    presenceConflicts.set(
                        key,
                        this.makeConflict("duplicate-id", path, [undefined, oi, ti], [label]),
                    );
                    keep.add(key);
                    contentSides.set(key, only(choice === "theirs" ? "theirs" : "ours"));
                } else {
                    keep.add(key);
                    contentSides.set(key, [undefined, oi, ti]);
                }
            } else if (oi !== undefined && ti !== undefined) {
                keep.add(key);
                contentSides.set(key, [bi, oi, ti]);
            } else if (oi === undefined && ti !== undefined) {
                if (!this.eq.equals(bi, ti)) {
                    presenceConflicts.set(
                        key,
                        this.makeConflict("delete-vs-modify", path, [bi, undefined, ti], [label]),
                    );
                    if (choice === "theirs") {
                        keep.add(key);
                        contentSides.set(key, only("theirs"));
                    }
                }
            } else if (oi !== undefined && ti === undefined) {
                if (!this.eq.equals(bi, oi)) {
                    presenceConflicts.set(
                        key,
                        this.makeConflict("delete-vs-modify", path, [bi, oi, undefined], [label]),
                    );
                    if (choice !== "theirs") {
                        keep.add(key);
                        contentSides.set(key, only("ours"));
                    }
                }
            }
        }

        // 2. The order.
        const insertPath = (anchor: string) =>
            anchor === START
                ? joinPath(ownerPath, "insertAtStart")
                : joinPath(ownerPath, "insertAfter", ...segmentsOf(anchor));
        const merged = mergeOrder({ base: kb.keys, ours: ko.keys, theirs: kt.keys }, keep, {
            timeline: rule.order === "timeline",
            positionChoice: (key) => this.choices.get(joinPath(itemPath(key), "position")),
            insertChoice: (anchor) => this.choices.get(insertPath(anchor)),
        });
        const final = new Set(merged.order);

        // 3. Contents and conflicts, in merged order (removed items after their base predecessor).
        const positions = new Map(merged.positionConflicts.map((c) => [c.key, c]));
        const inserts = new Map(merged.insertConflicts.map((c) => [c.anchor, c]));
        const removedAfter = new Map<string, string[]>();
        for (const key of union) {
            if (final.has(key)) continue;
            const sequence = kb.items.has(key) ? kb.keys : ko.items.has(key) ? ko.keys : kt.keys;
            let index = sequence.indexOf(key) - 1;
            while (index >= 0 && !final.has(sequence[index])) index--;
            const anchor = index < 0 ? START : sequence[index];
            const list = removedAfter.get(anchor);
            if (list) list.push(key);
            else removedAfter.set(anchor, [key]);
        }
        const out: unknown[] = [];
        const visit = (key: string) => {
            const label = itemLabel(
                rule.segment,
                ko.items.get(key) ?? kt.items.get(key) ?? kb.items.get(key),
                rawOfKey(key),
            );
            const itemScope: Scope = { ...inner, label, fieldPrefix: itemFieldPrefix(rule.segment) };
            const presence = presenceConflicts.get(key);
            if (presence) this.push(presence, itemScope);
            if (final.has(key)) {
                const sides = contentSides.get(key)!;
                const content = this.value(
                    itemRuleOf(sides),
                    sides[0],
                    sides[1],
                    sides[2],
                    itemPath(key),
                    itemScope,
                    rule.segment,
                );
                if (content !== undefined) out.push(content);
            }
            const position = positions.get(key);
            if (position) {
                const anchorOf = (anchor: string | null | undefined) =>
                    anchor === null || anchor === undefined ? anchor : rawOfKey(anchor);
                this.push(
                    this.makeConflict(
                        "order",
                        joinPath(itemPath(key), "position"),
                        [anchorOf(position.base), anchorOf(position.ours), anchorOf(position.theirs)],
                        [label],
                    ),
                    itemScope,
                );
            }
        };
        const afterAnchor = (anchor: string) => {
            const insert = inserts.get(anchor);
            if (insert) {
                this.push(
                    {
                        kind: "order",
                        path: insertPath(anchor),
                        base: [],
                        ours: insert.ours.map(rawOfKey),
                        theirs: insert.theirs.map(rawOfKey),
                        messageKey: "merge.conflict.insertAt{0}",
                        args: [scope.label],
                        choices: INSERT_CHOICES,
                    },
                    inner,
                );
            }
            for (const removed of removedAfter.get(anchor) ?? []) visit(removed);
        };
        afterAnchor(START);
        for (const key of merged.order) {
            visit(key);
            afterAnchor(key);
        }
        if (out.length === 0 && !this.present(b, o, t)) return undefined;
        return out;
    }

    /** A list of serializer records (materials, components, acts): each item by its class rule. */
    private recordList(
        field: string,
        segment: string,
        key: string,
        section: Section,
        b: unknown,
        o: unknown,
        t: unknown,
    ): unknown[] | undefined {
        return this.list(
            { kind: "list", key, order: "stable", segment, item: { kind: "atomic" } },
            b,
            o,
            t,
            "",
            { section, label: "" },
            joinPath("doc", field),
            (items) => {
                const classes = new Set(
                    items.filter((x) => !isAbsent(x)).map((x) => String((x as Json)["__cla$$__"] ?? "")),
                );
                if (classes.size !== 1) return { kind: "atomic" };
                const rule = this.rules.classRule([...classes][0]);
                if (rule?.strategy === "record") return { kind: "object", fields: rule.properties ?? {} };
                return rule?.strategy === "blob" ? { kind: "blob" } : { kind: "atomic" };
            },
        );
    }

    private models(nodes: Json[]): Json {
        const { base, ours, theirs } = this.views;
        const [b, o, t] = [base.data["models"], ours.data["models"], theirs.data["models"]];
        const out: Json = {};
        for (const key of unionKeys(o, t, b)) {
            const sides = [b, o, t].map((x) => (isRecord(x) ? x[key] : undefined));
            let value: unknown;
            if (key === "nodes") value = nodes;
            else if (key === "materials" || key === "components") {
                value = this.recordList(
                    key,
                    key === "materials" ? "material" : "component",
                    "id",
                    key === "materials" ? Section.Materials : Section.Components,
                    sides[0],
                    sides[1],
                    sides[2],
                );
            } else {
                value = this.value(
                    undefined,
                    sides[0],
                    sides[1],
                    sides[2],
                    joinPath("doc", "models", key),
                    {
                        section: Section.Document,
                        label: "models",
                    },
                    key,
                );
            }
            if (value !== undefined) out[key] = value;
        }
        if (!("nodes" in out)) out["nodes"] = nodes;
        return out;
    }

    // ------------------------------------------------------------------ The node set and the tree

    private nodeEquals(a: Json | undefined, b: Json | undefined): boolean {
        if (a === undefined || b === undefined) return a === b;
        for (const key of unionKeys(a, b)) {
            if (key === "parentId") continue;
            if (!this.eq.equals(a[key], b[key])) return false;
        }
        return true;
    }

    /** The tree (docs/merge.md, "Node set" and "Tree"): which nodes, their contents, parents and order. */
    private tree(): { nodes: Json[]; order: string[] } {
        const { base: B, ours: O, theirs: T } = this.views;
        const view = (side: SideName) => this.views[side];
        const root = O.rootId ?? T.rootId ?? B.rootId;
        if (root === undefined) return { nodes: [], order: [] };
        const ids = [...new Set([...O.byId.keys(), ...T.byId.keys(), ...B.byId.keys()])];
        const nodePath = (id: string) => joinPath("node", id);
        const labelOf = (id: string) => nodeLabel(O.byId.get(id) ?? T.byId.get(id) ?? B.byId.get(id), id);
        const scopeOf = (id: string): Scope => ({ section: Section.Nodes, nodeId: id, label: labelOf(id) });
        const rank = (id: string) =>
            B.index.get(id) ?? B.nodes.length + (O.index.get(id) ?? O.nodes.length + (T.index.get(id) ?? 0));
        const grown = (side: DocumentView, id: string) =>
            side.childrenOf(id).some((child) => !B.byId.has(child) || B.parentOf(child) !== id);
        // a new parent is a modification (sibling order is not): a delete never silently beats a move
        const modified = (side: DocumentView, id: string) =>
            !this.nodeEquals(B.byId.get(id), side.byId.get(id)) ||
            side.parentOf(id) !== B.parentOf(id) ||
            grown(side, id);

        // 1. Presence.
        const present = new Set<string>();
        /** Nodes taken whole from one side: kept through a delete-vs-modify, a duplicate id or a resolution. */
        const keeper = new Map<string, SideName>();
        const keptByConflict = new Set<string>();
        const explicitlyDeleted = new Set<string>();
        for (const id of ids) {
            if (id === root) {
                present.add(id);
                continue;
            }
            const [bn, on, tn] = [B.byId.get(id), O.byId.get(id), T.byId.get(id)];
            const path = nodePath(id);
            const forced = this.forces.get(path);
            if (forced !== undefined) {
                if (view(forced).byId.has(id)) {
                    present.add(id);
                    keeper.set(id, forced);
                }
                continue;
            }
            const choice = this.choices.get(path);
            if (bn === undefined) {
                present.add(id);
                if (on !== undefined && tn !== undefined && !this.nodeEquals(on, tn)) {
                    this.push(
                        this.makeConflict("duplicate-id", path, [undefined, on, tn], [labelOf(id)]),
                        scopeOf(id),
                    );
                    keeper.set(id, choice === "theirs" ? "theirs" : "ours");
                }
            } else if (on !== undefined && tn !== undefined) {
                present.add(id);
            } else if (on === undefined && tn !== undefined) {
                if (modified(T, id)) {
                    this.push(
                        this.makeConflict("delete-vs-modify", path, [bn, undefined, tn], [labelOf(id)]),
                        scopeOf(id),
                    );
                    if (choice === "theirs") {
                        present.add(id);
                        keeper.set(id, "theirs");
                        keptByConflict.add(id);
                    }
                }
            } else if (on !== undefined && tn === undefined) {
                if (modified(O, id)) {
                    this.push(
                        this.makeConflict("delete-vs-modify", path, [bn, on, undefined], [labelOf(id)]),
                        scopeOf(id),
                    );
                    if (choice === "theirs") {
                        explicitlyDeleted.add(id);
                    } else {
                        present.add(id);
                        keeper.set(id, "ours");
                        keptByConflict.add(id);
                    }
                }
            }
        }
        // A node kept against the other side's deletion keeps its subtree as that side has it (except
        // what a resolution deletes), and every ancestor the other side deleted with it.
        for (const id of keptByConflict) {
            const side = keeper.get(id)!;
            const skip = new Set<string>();
            for (const child of view(side).descendants(id)) {
                const parent = view(side).parentOf(child);
                if (explicitlyDeleted.has(child) || (parent !== undefined && skip.has(parent))) {
                    skip.add(child);
                    continue;
                }
                if (!present.has(child) && B.byId.has(child)) {
                    present.add(child);
                    keeper.set(child, side);
                }
            }
        }
        for (const [id, side] of [...keeper]) {
            let parent = view(side).parentOf(id);
            while (parent !== undefined && parent !== root && !present.has(parent)) {
                present.add(parent);
                keeper.set(parent, side);
                parent = view(side).parentOf(parent);
            }
        }

        // 2. Parents.
        const parent = new Map<string, string>();
        const parentFrom = new Map<string, SideName | "both" | "resolved">();
        for (const id of ids) {
            if (!present.has(id) || id === root) continue;
            const side = keeper.get(id);
            if (side !== undefined) {
                parent.set(id, view(side).parentOf(id) ?? root);
                parentFrom.set(id, side);
                continue;
            }
            const [pb, po, pt] = [B.parentOf(id), O.parentOf(id), T.parentOf(id)];
            const inO = O.byId.has(id);
            const inT = T.byId.has(id);
            if (inO && inT) {
                if (po === pt) {
                    parent.set(id, po ?? root);
                    parentFrom.set(id, "both");
                } else if (po === pb) {
                    parent.set(id, pt ?? root);
                    parentFrom.set(id, "theirs");
                } else if (pt === pb) {
                    parent.set(id, po ?? root);
                    parentFrom.set(id, "ours");
                } else {
                    const path = joinPath(nodePath(id), "parent");
                    this.push(this.makeConflict("move", path, [pb, po, pt], [labelOf(id)]), scopeOf(id));
                    const theirsWins = this.choices.get(path) === "theirs";
                    parent.set(id, (theirsWins ? pt : po) ?? root);
                    parentFrom.set(id, theirsWins ? "resolved" : "ours");
                }
            } else {
                parent.set(id, (inO ? po : pt) ?? root);
                parentFrom.set(id, inO ? "ours" : "theirs");
            }
        }
        // A parent that is gone: ours' parent, else theirs', else base's. None left: a node only one
        // side has (added under a node the other deleted — that deletion's delete-vs-modify reports
        // it) goes with it; a node both sides kept is never dropped — the parent chain of the side
        // chosen at `node/<id>/parent` (ours by default) comes back with it, reported as a `move`.
        const moveConflicts = new Set<string>();
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of ids) {
                if (!present.has(id) || id === root) continue;
                if (present.has(parent.get(id)!)) continue;
                const fallback = (["ours", "theirs", "base"] as const)
                    .map(
                        (side) =>
                            [side, view(side).byId.has(id) ? view(side).parentOf(id) : undefined] as const,
                    )
                    .find(([, candidate]) => candidate !== undefined && present.has(candidate));
                if (fallback !== undefined) {
                    parent.set(id, fallback[1]!);
                    parentFrom.set(id, fallback[0]);
                    continue;
                }
                changed = true;
                const kept = keeper.has(id) || (O.byId.has(id) && T.byId.has(id));
                if (!kept) {
                    present.delete(id);
                    continue;
                }
                const path = joinPath(nodePath(id), "parent");
                const [pb, po, pt] = [B.parentOf(id), O.parentOf(id), T.parentOf(id)];
                if (!moveConflicts.has(path) && !this.conflicts.some((c) => c.conflict.path === path)) {
                    moveConflicts.add(path);
                    this.push(this.makeConflict("move", path, [pb, po, pt], [labelOf(id)]), scopeOf(id));
                }
                const wanted = this.choices.get(path) === "theirs" ? "theirs" : "ours";
                const side: SideName = view(wanted).byId.has(id)
                    ? wanted
                    : wanted === "ours"
                      ? "theirs"
                      : "ours";
                // bring the chosen side's chain back, down from its first ancestor still present
                let child = id;
                let up: string | undefined = view(side).parentOf(id);
                while (up !== undefined && up !== root && !present.has(up) && view(side).byId.has(up)) {
                    present.add(up);
                    keeper.set(up, side);
                    parent.set(child, up);
                    parentFrom.set(child, side);
                    child = up;
                    up = view(side).parentOf(up);
                }
                parent.set(child, up !== undefined && present.has(up) ? up : root);
                parentFrom.set(child, side);
            }
        }
        this.breakCycles(root, ids, present, parent, parentFrom, labelOf, scopeOf);

        // 3. Sibling order, then the pre-order walk.
        const childrenOf = new Map<string, Set<string>>();
        for (const id of ids) {
            if (!present.has(id) || id === root) continue;
            const p = parent.get(id)!;
            const set = childrenOf.get(p);
            if (set) set.add(id);
            else childrenOf.set(p, new Set([id]));
        }
        const order: string[] = [];
        const stack = [root];
        while (stack.length > 0) {
            const id = stack.pop()!;
            order.push(id);
            const children = childrenOf.get(id);
            if (children === undefined) continue;
            const sorted = mergeOrder(
                { base: B.childrenOf(id), ours: O.childrenOf(id), theirs: T.childrenOf(id) },
                children,
                { timeline: false },
            ).order;
            // children no side has under this parent (a cycle broken to a fallback parent): last, in
            // base, then ours', then theirs' pre-order
            if (sorted.length < children.size) {
                const emitted = new Set(sorted);
                sorted.push(
                    ...[...children].filter((c) => !emitted.has(c)).sort((a, c) => rank(a) - rank(c)),
                );
            }
            for (let i = sorted.length - 1; i >= 0; i--) stack.push(sorted[i]);
        }

        const nodes = order.map((id) => {
            const side = keeper.get(id);
            const sides: [Json | undefined, Json | undefined, Json | undefined] =
                side === undefined
                    ? [B.byId.get(id), O.byId.get(id), T.byId.get(id)]
                    : [
                          side === "base" ? B.byId.get(id) : undefined,
                          side === "ours" ? O.byId.get(id) : undefined,
                          side === "theirs" ? T.byId.get(id) : undefined,
                      ];
            return this.nodeContent(id, sides, id === root ? undefined : parent.get(id), scopeOf(id));
        });
        return { nodes, order };
    }

    /**
     * Moves fine on their own can close a cycle together (docs/merge.md, "Tree"). While one exists,
     * the first of its nodes in base pre-order whose parent came from theirs goes back to ours'
     * parent — one `cycle` conflict per reverted node; ours' tree alone is acyclic, so this ends.
     * Resolved `theirs`, the node keeps theirs' parent and ours' moves in the cycle are reverted.
     */
    private breakCycles(
        root: string,
        ids: readonly string[],
        present: Set<string>,
        parent: Map<string, string>,
        parentFrom: Map<string, SideName | "both" | "resolved">,
        labelOf: (id: string) => string,
        scopeOf: (id: string) => Scope,
    ): void {
        const { base: B, ours: O, theirs: T } = this.views;
        const rank = (id: string) =>
            B.index.get(id) ?? B.nodes.length + (O.index.get(id) ?? O.nodes.length + (T.index.get(id) ?? 0));
        const findCycle = (): string[] | undefined => {
            const state = new Map<string, 1 | 2>();
            for (const start of ids) {
                if (!present.has(start) || state.has(start)) continue;
                const path: string[] = [];
                let current: string | undefined = start;
                while (current !== undefined && current !== root && !state.has(current)) {
                    state.set(current, 1);
                    path.push(current);
                    current = parent.get(current);
                }
                if (current !== undefined && state.get(current) === 1)
                    return path.slice(path.indexOf(current));
                for (const id of path) state.set(id, 2);
            }
            return undefined;
        };
        // The node to revert: theirs' moves first, then ours', then the rest; a resolution's choice last.
        const preference = (id: string) => {
            const from = parentFrom.get(id);
            return from === "theirs" ? 0 : from === "ours" ? 1 : from === "resolved" ? 3 : 2;
        };
        const reported = new Set<string>();
        for (let guard = 0; guard <= ids.length + 1; guard++) {
            const cycle = findCycle();
            if (cycle === undefined) return;
            const inCycle = new Set(cycle);
            const ordered = [...cycle].sort((a, c) => preference(a) - preference(c) || rank(a) - rank(c));
            const node = ordered[0];
            const [pb, po, pt] = [B.parentOf(node), O.parentOf(node), T.parentOf(node)];
            const path = joinPath("node", node, "parent");
            if (!reported.has(path)) {
                reported.add(path);
                this.push(
                    this.makeConflict(
                        "cycle",
                        path,
                        [pb, po, pt],
                        [labelOf(node), labelOf(parent.get(node)!)],
                    ),
                    scopeOf(node),
                );
            }
            /** A parent that breaks this cycle: present and outside it (the root always is). */
            const outside = (...candidates: (string | undefined)[]) =>
                candidates.find((c) => c !== undefined && present.has(c) && !inCycle.has(c)) ?? root;
            const others = cycle.filter((id) => id !== node && parentFrom.get(id) === "ours");
            if (
                this.choices.get(path) === "theirs" &&
                parentFrom.get(node) === "theirs" &&
                others.length > 0
            ) {
                // theirs' move stays; ours' moves in the cycle go back to theirs' (or base's) parents
                parentFrom.set(node, "resolved");
                for (const other of others) {
                    parent.set(
                        other,
                        outside(T.byId.has(other) ? T.parentOf(other) : undefined, B.parentOf(other)),
                    );
                    parentFrom.set(other, "resolved");
                }
            } else {
                parent.set(node, outside(O.byId.has(node) ? po : undefined, pt, pb));
                parentFrom.set(node, "both");
            }
        }
    }

    /** A node's properties and payloads by its class rule, with the merged `parentId`. */
    private nodeContent(
        id: string,
        sides: readonly [Json | undefined, Json | undefined, Json | undefined],
        parentId: string | undefined,
        scope: Scope,
    ): Json {
        const [b, o, t] = sides;
        const primary = o ?? t ?? b ?? {};
        const nodePath = joinPath("node", id);
        const classes = new Set(sides.filter((x) => x !== undefined).map((x) => String(x!["__cla$$__"])));
        const out: Json = {};
        const setParent = () => {
            if (parentId !== undefined) out["parentId"] = parentId;
        };
        if (classes.size > 1) {
            const strip = (node: Json | undefined) => {
                if (node === undefined) return undefined;
                const { parentId: _, ...rest } = node;
                return rest;
            };
            const chosen = this.three(strip(b), strip(o), strip(t), nodePath, scope, "__cla$$__") as
                | Json
                | undefined;
            Object.assign(out, chosen ?? strip(primary));
            setParent();
            return out;
        }
        const className = [...classes][0];
        const rule = this.rules.ruleOf(className);
        const properties = rule.properties ?? {};
        const payloads = payloadProperties(this.rules, className);
        const rest: string[] = [];
        for (const key of unionKeys(primary, o, t, b)) {
            if (key === "parentId") {
                setParent();
                continue;
            }
            if (key === "id" || key === "__cla$$__") {
                out[key] = primary[key];
                continue;
            }
            const propertyRule = properties[key];
            if (rule.strategy !== "node" && propertyRule === undefined) {
                rest.push(key);
                out[key] = undefined;
                continue;
            }
            const [vb, vo, vt] = [b?.[key], o?.[key], t?.[key]];
            const payload = payloads.get(key);
            const value =
                payload !== undefined
                    ? this.payload(id, key, payload, sides, scope)
                    : this.value(propertyRule, vb, vo, vt, joinPath(nodePath, "prop", key), scope, key);
            if (value !== undefined) out[key] = value;
            else delete out[key];
        }
        if (rest.length > 0) {
            const pick = (node: Json | undefined) =>
                node === undefined ? undefined : Object.fromEntries(rest.map((key) => [key, node[key]]));
            const chosen = this.three(
                pick(b),
                pick(o),
                pick(t),
                joinPath(nodePath, "content"),
                scope,
                "content",
            );
            for (const key of rest) {
                const value = isRecord(chosen) ? chosen[key] : undefined;
                if (isAbsent(value)) delete out[key];
                else out[key] = value;
            }
        }
        if (parentId !== undefined && !("parentId" in out)) out["parentId"] = parentId;
        return out;
    }

    /** A JSON payload property: parsed on each side and merged by its payload rule. */
    private payload(
        id: string,
        property: string,
        payloadName: string,
        sides: readonly [Json | undefined, Json | undefined, Json | undefined],
        scope: Scope,
    ): unknown {
        const raws = sides.map((node) => node?.[property]) as [unknown, unknown, unknown];
        const parsed = sides.map((node, index) =>
            node === undefined || isAbsent(raws[index])
                ? undefined
                : this.views[SIDES[index]].payload(id, property),
        ) as [ParsedPayload | undefined, ParsedPayload | undefined, ParsedPayload | undefined];
        const rule = this.rules.payloadRule(payloadName);
        const propertyPath = joinPath("node", id, "prop", property);
        if (rule === undefined || parsed.some((x) => x !== undefined && !x.ok)) {
            // not JSON (a blob reference of a manifest, a hand edit): the string is one value
            return this.three(raws[0], raws[1], raws[2], propertyPath, scope, property);
        }
        const root = rule.segment === undefined ? joinPath("node", id) : joinPath("node", id, rule.segment);
        const value = this.value(
            rule.rule,
            parsed[0]?.value,
            parsed[1]?.value,
            parsed[2]?.value,
            root,
            scope,
            property,
        );
        if (value === undefined) return undefined;
        return new MergedPayload(payloadName, value, parsed, raws);
    }
}

/** How the engine treats timeline positions inside an atomic value (a `ConstructionRef`). */
const CONSTRUCTION_POSITIONS: MergeValueRule = {
    kind: "object",
    atomic: true,
    fields: { featureIndex: { kind: "timeline-position", bodyFrom: "nodeId" } },
};
