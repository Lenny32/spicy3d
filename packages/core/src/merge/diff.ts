// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentFormatError, DocumentMigrations } from "../documentFormat";
import { Result } from "../foundation/result";
import type { I18nKeys } from "../i18n";
import type { Serialized } from "../serialize";
import { DocumentView, payloadProperties } from "./documentView";
import { isAbsent, isRecord, type Json, JsonEquality } from "./json";
import { stableKeys } from "./listOrder";
import { fieldPath, itemFieldPrefix, itemLabel, joinPath, keySegments, nodeLabel } from "./paths";
import { type MergeRuleRegistry, MergeRules, type MergeValueRule } from "./rules";
import type { Change, ChangeKind } from "./types";

// The two-way diff (docs/merge.md, "Change model"): what changed from one version to another, at
// the merge's granularity and with its paths — the history's Compare and a clean merge's "View
// changes" (`MergeResult.changes`). Recomputed state (`derived`) and the legacy id counters are
// not changes the user made, so they are not reported; nor are sibling reorders in the tree.

/** The changes from `base` to `next` (both migrated first, never modified). */
export function diffDocuments(
    base: Serialized,
    next: Serialized,
    rules: MergeRuleRegistry = MergeRules,
): Result<Change[], DocumentFormatError> {
    const before = DocumentMigrations.migrate(base);
    if (!before.isOk) return Result.err(before.error);
    const after = DocumentMigrations.migrate(next);
    if (!after.isOk) return Result.err(after.error);
    return Result.ok(
        diffViews(
            new DocumentView("base", before.value, rules),
            new DocumentView("merged", after.value, rules),
            rules,
        ),
    );
}

const DISPLAYABLE = new Set(["number", "string", "boolean"]);

interface Scope {
    readonly nodeId?: string;
    readonly label: string;
    readonly prefix?: readonly string[];
}

/** The diff of two documents already migrated (views over them). */
export function diffViews(before: DocumentView, after: DocumentView, rules: MergeRuleRegistry): Change[] {
    const eq = new JsonEquality();
    const changes: Change[] = [];
    const push = (
        kind: ChangeKind,
        path: string,
        scope: Scope,
        b: unknown,
        a: unknown,
        messageKey: I18nKeys,
        args: readonly unknown[],
    ) => {
        changes.push({
            kind,
            path,
            nodeId: scope.nodeId,
            before: isAbsent(b) ? undefined : b,
            after: isAbsent(a) ? undefined : a,
            messageKey,
            args,
        });
    };
    const changedValue = (path: string, scope: Scope, field: string, b: unknown, a: unknown) => {
        if (DISPLAYABLE.has(typeof b) && DISPLAYABLE.has(typeof a)) {
            push("modified", path, scope, b, a, "diff.changedValue{0}{1}{2}{3}", [scope.label, field, b, a]);
        } else {
            push("modified", path, scope, b, a, "diff.modified{0}", [scope.label]);
        }
    };

    const value = (
        rule: MergeValueRule | undefined,
        b: unknown,
        a: unknown,
        path: string,
        scope: Scope,
        field: string,
    ) => {
        if (eq.equals(b, a)) return;
        const r =
            rule ??
            (isRecord(b) || isRecord(a) || Array.isArray(b) || Array.isArray(a)
                ? { kind: "atomic" as const }
                : { kind: "scalar" as const });
        switch (r.kind) {
            case "derived":
            case "max":
            case "min":
            case "parent":
                return;
            case "object": {
                if (r.atomic || !isRecord(b) || !isRecord(a)) {
                    changedValue(path, scope, field, b, a);
                    return;
                }
                const prefix = scope.prefix ?? [];
                const inner = { ...scope, prefix: undefined };
                const groupOf = new Map<string, string>();
                for (const [group, fields] of Object.entries(r.groups ?? {}))
                    for (const f of fields) groupOf.set(f, group);
                const done = new Set<string>();
                for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
                    const group = groupOf.get(key);
                    if (group !== undefined) {
                        if (done.has(group)) continue;
                        done.add(group);
                        const fields = r.groups![group];
                        const pick = (x: Json) =>
                            Object.fromEntries(fields.filter((f) => !isAbsent(x[f])).map((f) => [f, x[f]]));
                        if (!eq.equals(pick(b), pick(a))) {
                            push(
                                "modified",
                                joinPath(path, ...prefix, group),
                                inner,
                                pick(b),
                                pick(a),
                                "diff.modified{0}",
                                [scope.label],
                            );
                        }
                        continue;
                    }
                    const fieldRule = r.fields[key] ?? r.rest;
                    value(fieldRule, b[key], a[key], fieldPath(path, prefix, key, fieldRule), inner, key);
                }
                return;
            }
            case "union": {
                if (!isRecord(b) || !isRecord(a) || b[r.tag] !== a[r.tag]) {
                    push("modified", path, scope, b, a, "diff.modified{0}", [scope.label]);
                    return;
                }
                const tag = b[r.tag];
                value(
                    (typeof tag === "string" ? r.variants[tag] : undefined) ?? r.fallback,
                    b,
                    a,
                    path,
                    scope,
                    field,
                );
                return;
            }
            case "list":
                list(r, b, a, path, scope);
                return;
            case "map": {
                if ((!isAbsent(b) && !isRecord(b)) || (!isAbsent(a) && !isRecord(a))) {
                    changedValue(path, scope, field, b, a);
                    return;
                }
                const [x, y] = [(b ?? {}) as Json, (a ?? {}) as Json];
                for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
                    const entryPath =
                        r.segment !== undefined ? joinPath(path, r.segment, key) : joinPath(path, key);
                    value(r.value, x[key], y[key], entryPath, { ...scope, prefix: undefined }, key);
                }
                return;
            }
            case "atomic":
            case "blob":
            case "json":
                if (DISPLAYABLE.has(typeof b) && DISPLAYABLE.has(typeof a) && r.kind === "atomic") {
                    changedValue(path, scope, field, b, a);
                } else {
                    push("modified", path, scope, b, a, "diff.modified{0}", [scope.label]);
                }
                return;
            default:
                if (field === "name" && typeof b === "string" && typeof a === "string") {
                    push("renamed", path, scope, b, a, "diff.renamed{0}{1}", [b, a]);
                    return;
                }
                changedValue(path, scope, field, b, a);
        }
    };

    const keyed = (items: unknown, key: string) => {
        const map = new Map<string, { item: Json; raw: unknown; segments: (string | number)[] }>();
        const counts = new Map<string, number>();
        const order: string[] = [];
        for (const item of Array.isArray(items) ? items : []) {
            if (!isRecord(item)) continue;
            const raw = item[key];
            const base = `${typeof raw}:${String(raw)}`;
            const n = (counts.get(base) ?? 0) + 1;
            counts.set(base, n);
            const id = n > 1 ? `${base}\u0000${n}` : base;
            order.push(id);
            map.set(id, { item, raw, segments: keySegments(raw as string, n) });
        }
        return { map, order };
    };

    const list = (
        rule: Extract<MergeValueRule, { kind: "list" }>,
        b: unknown,
        a: unknown,
        ownerPath: string,
        scope: Scope,
        itemRuleOf: (item: Json) => MergeValueRule | undefined = () => rule.item,
    ) => {
        const [x, y] = [keyed(b, rule.key), keyed(a, rule.key)];
        const baseIndex = new Map(x.order.map((k, i) => [k, i]));
        const stable = rule.order === "timeline" ? stableKeys(baseIndex, y.order) : undefined;
        for (const key of [...y.order, ...x.order.filter((k) => !y.map.has(k))]) {
            const [was, is] = [x.map.get(key), y.map.get(key)];
            const entry = (is ?? was)!;
            const path = joinPath(ownerPath, rule.segment, ...entry.segments);
            const label = itemLabel(rule.segment, entry.item, entry.raw);
            const itemScope: Scope = { ...scope, label, prefix: itemFieldPrefix(rule.segment) };
            if (was === undefined) {
                push("added", path, itemScope, undefined, is!.item, "diff.added{0}", [label]);
            } else if (is === undefined) {
                push("removed", path, itemScope, was.item, undefined, "diff.removed{0}", [label]);
            } else {
                if (stable !== undefined && !stable.has(key)) {
                    push(
                        "reordered",
                        joinPath(path, "position"),
                        itemScope,
                        undefined,
                        undefined,
                        "diff.reordered{0}",
                        [label],
                    );
                }
                value(itemRuleOf(is.item), was.item, is.item, path, itemScope, rule.segment);
            }
        }
    };

    // Document fields.
    const docScope: Scope = { label: String(after.data["name"] ?? "") };
    if (!eq.equals(before.data["name"], after.data["name"])) {
        push(
            "renamed",
            "doc/name",
            { label: "" },
            before.data["name"],
            after.data["name"],
            "diff.renamed{0}{1}",
            [String(before.data["name"] ?? ""), String(after.data["name"] ?? "")],
        );
    }
    const documentRule = rules.classRule("Document")?.properties ?? {};
    value(
        documentRule["settings"] ?? { kind: "map", value: { kind: "scalar" }, segment: "settings" },
        before.data["settings"],
        after.data["settings"],
        "doc",
        docScope,
        "settings",
    );
    const userData = [before.data["userData"], after.data["userData"]].map((x) => (isRecord(x) ? x : {}));
    for (const key of new Set([...Object.keys(userData[0]), ...Object.keys(userData[1])])) {
        if (!eq.equals(userData[0][key], userData[1][key])) {
            const path = joinPath("doc", "userData", key);
            push("modified", path, { label: "" }, userData[0][key], userData[1][key], "diff.modified{0}", [
                `userData.${key}`,
            ]);
        }
    }
    const variables = documentRule["variables"];
    if (variables?.kind === "list")
        list(variables, before.data["variables"], after.data["variables"], "", { label: "" });
    const recordRule = (item: Json): MergeValueRule => {
        const rule = rules.classRule(String(item["__cla$$__"] ?? ""));
        return rule?.strategy === "record"
            ? { kind: "object", fields: rule.properties ?? {} }
            : { kind: "atomic" };
    };
    const records = (segment: string, key: string, b: unknown, a: unknown) =>
        list(
            { kind: "list", key, order: "stable", segment, item: { kind: "atomic" } },
            b,
            a,
            "",
            { label: "" },
            recordRule,
        );
    records("act", "name", before.data["acts"], after.data["acts"]);
    records("material", "id", before.modelList("materials"), after.modelList("materials"));
    records("component", "id", before.modelList("components"), after.modelList("components"));

    // Nodes, in the new version's pre-order, removed ones last.
    const root = after.rootId ?? before.rootId;
    const ids = [...after.byId.keys(), ...[...before.byId.keys()].filter((id) => !after.byId.has(id))];
    for (const id of ids) {
        if (id === root) continue;
        const [was, is] = [before.byId.get(id), after.byId.get(id)];
        const path = joinPath("node", id);
        const label = nodeLabel(is ?? was, id);
        const scope: Scope = { nodeId: id, label };
        if (was === undefined) {
            push("added", path, scope, undefined, is, "diff.added{0}", [label]);
            continue;
        }
        if (is === undefined) {
            push("removed", path, scope, was, undefined, "diff.removed{0}", [label]);
            continue;
        }
        if (!eq.equals(was["name"], is["name"])) {
            push(
                "renamed",
                joinPath(path, "prop", "name"),
                scope,
                was["name"],
                is["name"],
                "diff.renamed{0}{1}",
                [String(was["name"] ?? ""), String(is["name"] ?? "")],
            );
        }
        if (before.parentOf(id) !== after.parentOf(id)) {
            push(
                "moved",
                joinPath(path, "parent"),
                scope,
                before.parentOf(id),
                after.parentOf(id),
                "diff.moved{0}",
                [label],
            );
        }
        const className = String(is["__cla$$__"]);
        if (className !== String(was["__cla$$__"])) {
            push("modified", path, scope, was, is, "diff.modified{0}", [label]);
            continue;
        }
        const rule = rules.ruleOf(className);
        const payloads = payloadProperties(rules, className);
        for (const key of new Set([...Object.keys(is), ...Object.keys(was)])) {
            if (key === "id" || key === "parentId" || key === "name" || key === "__cla$$__") continue;
            if (eq.equals(was[key], is[key])) continue;
            const payload = payloads.get(key);
            const payloadRule = payload === undefined ? undefined : rules.payloadRule(payload);
            if (payloadRule !== undefined) {
                const [pb, pa] = [before.payload(id, key), after.payload(id, key)];
                if (pb.ok && pa.ok) {
                    const rootPath =
                        payloadRule.segment === undefined ? path : joinPath(path, payloadRule.segment);
                    value(payloadRule.rule, pb.value, pa.value, rootPath, scope, key);
                    continue;
                }
            }
            const propertyRule = rule.properties?.[key];
            value(
                propertyRule?.kind === "json" ? { kind: "atomic" } : propertyRule,
                was[key],
                is[key],
                joinPath(path, "prop", key),
                scope,
                key,
            );
        }
    }
    return changes;
}
