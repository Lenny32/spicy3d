// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentFormatError, DocumentMigrations } from "../documentFormat";
import { BLOB_REF_KEY, isBlobRef } from "../documentManifest";
import { Result } from "../foundation/result";
import type { Serialized } from "../serialize";
import { diffViews } from "./diff";
import { DocumentView, payloadProperties, type SideName, timelineProperty } from "./documentView";
import { collectReferences, featureSketchIds, type ReferenceRecord, type TargetNames } from "./integrity";
import { isRecord, type Json, type JsonEquality, PositionMarker } from "./json";
import { itemLabel, joinPath, nodeLabel } from "./paths";
import { type MergeRuleRegistry, MergeRules } from "./rules";
import { sha256HexSync } from "./sha256";
import { MergedPayload, type MergeViews, type PendingConflict, Section, StructuralMerge } from "./structural";
import type { MergeConflict, MergeInputs, MergeResolution, MergeResult, ResolutionChoice } from "./types";

// The merge engine's entry points (docs/merge.md, "Pipeline"): migrate, structural merge, timeline
// positions, normalization, referential integrity, serialize, changes. Pure and deterministic: the
// same inputs give a byte-identical `merged` and the same conflicts in the same order; the inputs
// are never modified. The kernel validation pass (step 8) is `validateMerge` (validation.ts).
//
// Documents are merged in the form they are given, assembled or as cloud manifests: a value is
// compared with a `{ "$blob": sha }` reference by hashing it the way `splitManifest` stores it, so
// an assembled `ours` merges with manifest `base` / `theirs` without spurious blob conflicts. The
// output keeps a value inline whenever any input had it inline; a reference stays only where no
// input held the content (the caller assembles it from its blob cache). A JSON payload that is a
// blob reference cannot be merged inside and merges as one value: assemble payload blobs first
// (CLOUD-10 does — the local side is always assembled).

export type MergeError =
    /** An input this build cannot migrate (a newer format, not a Spicy3D document). */
    | { kind: "format"; side: SideName; error: DocumentFormatError }
    /** The three inputs are not versions of one document (their ids differ). */
    | { kind: "differentDocuments" }
    /** A resolution for a path that is not a conflict of the result. */
    | { kind: "unknownConflict"; path: string }
    /** A resolution the conflict does not offer. */
    | { kind: "invalidChoice"; path: string; choice: ResolutionChoice };

const SIDES: readonly SideName[] = ["base", "ours", "theirs"];

/** The three inputs migrated to this build's format (fresh copies), or why they cannot be merged. */
export function prepareMergeInputs(
    base: Serialized,
    ours: Serialized,
    theirs: Serialized,
): Result<MergeInputs, MergeError> {
    const migrated: Serialized[] = [];
    for (const [index, data] of [base, ours, theirs].entries()) {
        const result = DocumentMigrations.migrate(data);
        if (!result.isOk) return Result.err({ kind: "format", side: SIDES[index], error: result.error });
        migrated.push(result.value);
    }
    const [b, o, t] = migrated;
    if (b["id"] !== o["id"] || o["id"] !== t["id"]) return Result.err({ kind: "differentDocuments" });
    return Result.ok({ base: b, ours: o, theirs: t });
}

/**
 * The three-way merge of `ours` and `theirs` against their common `base` (docs/merge.md). Every
 * conflicting location of `merged` holds the conflict's first choice.
 */
export function mergeDocuments(
    base: Serialized,
    ours: Serialized,
    theirs: Serialized,
    rules: MergeRuleRegistry = MergeRules,
): Result<MergeResult, MergeError> {
    const inputs = prepareMergeInputs(base, ours, theirs);
    if (!inputs.isOk) return Result.err(inputs.error);
    return Result.ok(runMerge(inputs.value, rules, new Map()));
}

/**
 * Re-merges with the user's choices: every chosen conflict is applied (and no longer listed), the
 * integrity pass runs again — a choice that takes a side's version of a reference can make new
 * dangling references, reported as new conflicts. `rebuild-failure`s of `result` not chosen are
 * carried over; run `validateMerge` again for fresh ones.
 */
export function resolveMerge(
    result: MergeResult,
    choices: readonly MergeResolution[],
    rules: MergeRuleRegistry = MergeRules,
): Result<MergeResult, MergeError> {
    // the choices applied before stay (a later one for the same path replaces it); a choice may
    // answer a conflict still open or one answered before
    const byPath = new Map<string, ResolutionChoice>(result.resolutions.map((r) => [r.path, r.choice]));
    const known = [...result.conflicts, ...result.resolved];
    for (const { path, choice } of choices) {
        const conflict = known.find((c) => c.path === path);
        if (conflict === undefined) return Result.err({ kind: "unknownConflict", path });
        if (!conflict.choices.includes(choice)) return Result.err({ kind: "invalidChoice", path, choice });
        byPath.set(path, choice);
    }
    const merged = runMerge(result.inputs, rules, byPath);
    const rebuilds = result.conflicts.filter((c) => c.kind === "rebuild-failure" && !byPath.has(c.path));
    const resolved = new Map(result.resolved.map((c) => [c.path, c]));
    for (const conflict of [...known, ...merged.resolved]) {
        if (byPath.has(conflict.path) && !resolved.has(conflict.path)) resolved.set(conflict.path, conflict);
    }
    return Result.ok({
        ...merged,
        conflicts: [...merged.conflicts, ...rebuilds],
        resolved: [...resolved.values()],
    });
}

/** The merged document with the user's choices applied (see {@link resolveMerge}). */
export function applyResolutions(
    result: MergeResult,
    choices: readonly MergeResolution[],
    rules: MergeRuleRegistry = MergeRules,
): Result<Serialized, MergeError> {
    const resolved = resolveMerge(result, choices, rules);
    return resolved.isOk ? Result.ok(resolved.value.merged) : Result.err(resolved.error);
}

// ------------------------------------------------------------------ The run

/**
 * For payloads a manifest stores as blob references: the inline text another input has for the
 * same hash, so the payload still merges inside (`undefined` when no input has any reference).
 */
function payloadBlobText(
    inputs: MergeInputs,
    rules: MergeRuleRegistry,
): ((ref: unknown) => string | undefined) | undefined {
    const texts: string[] = [];
    let references = false;
    for (const doc of [inputs.base, inputs.ours, inputs.theirs]) {
        const nodes =
            isRecord(doc["models"]) && Array.isArray(doc["models"]["nodes"]) ? doc["models"]["nodes"] : [];
        for (const node of nodes) {
            if (!isRecord(node)) continue;
            for (const property of payloadProperties(rules, String(node["__cla$$__"])).keys()) {
                const value = node[property];
                if (typeof value === "string") texts.push(value);
                else if (isBlobRef(value)) references = true;
            }
        }
    }
    if (!references) return undefined;
    let byHash: Map<string, string> | undefined;
    return (ref) => {
        if (!isBlobRef(ref) || ref.$as !== undefined) return undefined;
        byHash ??= new Map(texts.map((text) => [sha256HexSync(encoder.encode(text)), text]));
        return byHash.get(ref[BLOB_REF_KEY]);
    };
}

const encoder = new TextEncoder();

function createViews(inputs: MergeInputs, rules: MergeRuleRegistry): MergeViews {
    const blobText = payloadBlobText(inputs, rules);
    return {
        base: new DocumentView("base", inputs.base, rules, undefined, blobText),
        ours: new DocumentView("ours", inputs.ours, rules, undefined, blobText),
        theirs: new DocumentView("theirs", inputs.theirs, rules, undefined, blobText),
    };
}

/** Labels of targets a merged reference misses, read from whichever version still has them. */
function targetNames(views: MergeViews, rules: MergeRuleRegistry): TargetNames {
    const order = [views.ours, views.theirs, views.base];
    return {
        node: (id) => {
            const view = order.find((v) => v.byId.has(id));
            return view === undefined ? id : nodeLabel(view.byId.get(id), id);
        },
        entity: (sketchId, entityId) => {
            for (const view of order) {
                const className = view.className(sketchId);
                if (className === undefined) continue;
                for (const property of payloadProperties(rules, className).keys()) {
                    const parsed = view.payload(sketchId, property);
                    if (!parsed.ok || !isRecord(parsed.value)) continue;
                    const lists = [parsed.value["entities"], parsed.value["externalRefs"]];
                    for (const list of lists) {
                        if (!Array.isArray(list)) continue;
                        const item = list.find((x) => isRecord(x) && (x["id"] ?? x["entityId"]) === entityId);
                        if (item !== undefined) {
                            return list === lists[0]
                                ? itemLabel("entity", item, entityId)
                                : itemLabel("external", item, entityId);
                        }
                    }
                }
            }
            return `entity ${entityId}`;
        },
        sketchFeature: (body, sketchId) => {
            for (const view of order) {
                const feature = view.features(body)?.find((f) => featureSketchIds(f).includes(sketchId));
                if (feature !== undefined) return String(feature["id"]);
            }
            return undefined;
        },
        variableItem: (name) => {
            for (const view of order) {
                const variable = view.list("variables").find((v) => v["name"] === name);
                if (variable !== undefined) return joinPath("variable", String(variable["id"]));
            }
            return undefined;
        },
    };
}

interface Finalized {
    readonly document: Json;
    readonly preParsed: Map<string, unknown>;
}

const DROP = Symbol("drop");

/** Pipeline steps 4–5: timeline positions projected onto the merged feature lists, then normalization. */
function finalize(document: Json, views: MergeViews, rules: MergeRuleRegistry, eq: JsonEquality): Finalized {
    const models = document["models"] as Json;
    const nodes = (models["nodes"] ?? []) as Json[];
    const bodies = new Set(nodes.map((node) => node["id"] as string));
    const timelines = new Map<string, string[]>();
    for (const node of nodes) {
        const property = timelineProperty(rules, String(node["__cla$$__"]));
        const payload = property === undefined ? undefined : node[property];
        if (payload instanceof MergedPayload && Array.isArray(payload.value)) {
            timelines.set(
                node["id"] as string,
                payload.value.map((f) => String(isRecord(f) ? f["id"] : "")),
            );
        }
    }
    const project = (marker: PositionMarker): number | typeof DROP => {
        if (!bodies.has(marker.body)) return marker.droppable ? DROP : marker.raw;
        const merged = timelines.get(marker.body);
        if (merged === undefined || marker.anchor === undefined) return marker.raw;
        const own = views[marker.side].timeline(marker.body);
        if (own !== undefined && own.length === merged.length && own.every((id, i) => id === merged[i])) {
            return marker.raw;
        }
        if (marker.anchor === null) return 0;
        const index = merged.indexOf(marker.anchor);
        if (index >= 0) return index + 1;
        // the anchor feature is gone: the nearest earlier feature of its side that survives
        if (own === undefined) return 0;
        for (let i = own.indexOf(marker.anchor) - 1; i >= 0; i--) {
            const survivor = merged.indexOf(own[i]);
            if (survivor >= 0) return survivor + 1;
        }
        return 0;
    };
    const walk = (value: unknown): unknown => {
        if (value instanceof PositionMarker) return project(value);
        if (Array.isArray(value)) {
            const items = value.map(walk);
            return items.some((item, i) => item !== value[i]) ? items : value;
        }
        if (!isRecord(value)) return value;
        let copy: Json | undefined;
        for (const [key, item] of Object.entries(value)) {
            const next = walk(item);
            if (next === item) continue;
            copy ??= { ...value };
            if (next === DROP) delete copy[key];
            else copy[key] = next;
        }
        return copy ?? value;
    };
    const preParsed = new Map<string, unknown>();
    for (const node of nodes) {
        for (const [property, item] of Object.entries(node)) {
            if (!(item instanceof MergedPayload)) continue;
            item.value = walk(item.value);
            const normalize = rules.payloadRule(item.payload)?.normalize;
            if (
                normalize !== undefined &&
                !item.sides.some((side) => side?.ok && eq.equals(side.value, item.value))
            ) {
                item.value = normalize(item.value);
            }
            preParsed.set(`${node["id"]}\u0000${property}`, item.value);
        }
    }
    return { document, preParsed };
}

/** Step 7: payloads back to JSON strings — a side's own string when the payload equals it (byte-identical). */
function serializeMerged(document: Json, eq: JsonEquality): Serialized {
    const models = document["models"] as Json;
    const nodes = ((models["nodes"] ?? []) as Json[]).map((node) => {
        const out: Json = {};
        for (const [key, value] of Object.entries(node)) {
            if (!(value instanceof MergedPayload)) {
                out[key] = value;
                continue;
            }
            const same = [1, 2, 0].find((i) => {
                const side = value.sides[i];
                return (
                    side?.ok === true &&
                    typeof value.raws[i] === "string" &&
                    eq.equals(side.value, value.value)
                );
            });
            out[key] = same === undefined ? JSON.stringify(value.value) : value.raws[same];
        }
        return out;
    });
    return structuredClone({ ...document, models: { ...models, nodes } }) as unknown as Serialized;
}

function runMerge(
    inputs: MergeInputs,
    rules: MergeRuleRegistry,
    choices: ReadonlyMap<string, ResolutionChoice>,
): MergeResult {
    const views = createViews(inputs, rules);
    const names = targetNames(views, rules);
    const sideRefs = {
        base: collectReferences(views.base, rules, names),
        ours: collectReferences(views.ours, rules, names),
        theirs: collectReferences(views.theirs, rules, names),
    };
    const forces = new Map<string, SideName>();
    /** Duplicate-name conflicts: their forces removed the duplicate, so later runs no longer see them. */
    const carried = new Map<string, PendingConflict>();
    const appliedDangling = new Set<string>();

    let structural: ReturnType<StructuralMerge["run"]>;
    let merge: StructuralMerge;
    let finalized: Finalized;
    let dangling: PendingConflict[];
    /** Conflicts the choices answer, as first detected (their paths stay resolvable). */
    const answered = new Map<string, MergeConflict>();
    for (let round = 0; ; round++) {
        merge = new StructuralMerge(views, rules, choices, forces);
        structural = merge.run();
        finalized = finalize(structural.document, views, rules, merge.eq);
        const mergedView = new DocumentView(
            "merged",
            finalized.document as Serialized,
            rules,
            finalized.preParsed,
        );
        const found = integrity(mergedView, views, sideRefs, rules, names, merge.eq, round);
        dangling = found.dangling;
        for (const pending of [
            ...structural.conflicts,
            ...dangling,
            ...found.duplicates.map((d) => d.pending),
        ]) {
            const path = pending.conflict.path;
            if (choices.has(path) && !answered.has(path)) answered.set(path, pending.conflict);
        }
        let again = false;
        for (const record of found.danglingRecords) {
            const choice = choices.get(record.path);
            if ((choice === "ours" || choice === "theirs") && !appliedDangling.has(record.path)) {
                appliedDangling.add(record.path);
                forces.set(record.item, choice);
                for (const target of record.targets) forces.set(target, choice);
                again = true;
            }
        }
        for (const duplicate of found.duplicates) {
            if (carried.has(duplicate.pending.conflict.path)) continue;
            carried.set(duplicate.pending.conflict.path, duplicate.pending);
            const side = choices.get(duplicate.pending.conflict.path) === "theirs" ? "theirs" : "ours";
            for (const id of duplicate.ids) forces.set(joinPath("variable", id), side);
            again = true;
        }
        if (!again || round >= 8) break;
    }

    const order = new Map(structural.order.map((id, index) => [id, index]));
    const rank = (id: string | undefined): [number, number, number] => {
        if (id === undefined) return [-1, 0, 0];
        const own = order.get(id);
        if (own !== undefined) return [own, 0, 0];
        for (const [v, view] of [views.base, views.ours, views.theirs].entries()) {
            const index = view.index.get(id);
            if (index === undefined) continue;
            for (let i = index - 1; i >= 0; i--) {
                const previous = order.get(view.nodes[i]["id"] as string);
                if (previous !== undefined) return [previous, 1 + v, index];
            }
            return [-1, 1 + v, index];
        }
        return [Number.MAX_SAFE_INTEGER, 0, 0];
    };
    const all = [...structural.conflicts, ...carried.values(), ...dangling].filter(
        (p) => !choices.has(p.conflict.path),
    );
    const keyed = all.map((pending) => ({
        pending,
        key: [pending.section, ...rank(pending.nodeId), pending.seq],
    }));
    keyed.sort((a, b) => {
        for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        return 0;
    });
    const conflicts: MergeConflict[] = keyed.map((x) => x.pending.conflict);
    const merged = serializeMerged(finalized.document, merge.eq);
    const changes = diffViews(views.ours, new DocumentView("merged", merged, rules), rules);
    const resolutions = [...choices].map(([path, choice]) => ({ path, choice }));
    return { merged, conflicts, changes, inputs, resolutions, resolved: [...answered.values()] };
}

interface IntegrityFindings {
    readonly dangling: PendingConflict[];
    readonly danglingRecords: ReferenceRecord[];
    readonly duplicates: { pending: PendingConflict; ids: string[] }[];
}

/** Step 6: merge-introduced dangling references, and variable names the merge made ambiguous. */
function integrity(
    merged: DocumentView,
    views: MergeViews,
    sideRefs: Record<SideName, Map<string, ReferenceRecord>>,
    rules: MergeRuleRegistry,
    names: TargetNames,
    eq: JsonEquality,
    round: number,
): IntegrityFindings {
    const dangling: PendingConflict[] = [];
    const danglingRecords: ReferenceRecord[] = [];
    let seq = 1_000_000 * (round + 1);
    for (const record of collectReferences(merged, rules, names).values()) {
        if (record.resolved) continue;
        // introduced by the merge: the value comes from a parent where it resolved, and no parent
        // with the same value already had it dangling
        const parents = (["ours", "theirs"] as const)
            .map((side) => sideRefs[side].get(record.path))
            .filter((parent) => parent !== undefined && eq.equals(parent.value, record.value));
        if (parents.length === 0 || !parents.every((parent) => parent!.resolved)) continue;
        danglingRecords.push(record);
        dangling.push({
            conflict: {
                kind: "dangling-ref",
                path: record.path,
                base: sideRefs.base.get(record.path)?.value,
                ours: sideRefs.ours.get(record.path)?.value,
                theirs: sideRefs.theirs.get(record.path)?.value,
                messageKey: "merge.conflict.danglingRef{0}{1}",
                args: [record.label, record.missing[0]],
                choices: ["accept", "ours", "theirs"],
            },
            section: record.section,
            nodeId: record.nodeId,
            seq: seq++,
        });
    }

    // Two variables of one name (both added `thickness`, or one renamed onto the other's new name):
    // `evaluateVariables` would keep the first and silently change the other side's geometry.
    const duplicates: IntegrityFindings["duplicates"] = [];
    const byName = (view: DocumentView) => {
        const groups = new Map<string, string[]>();
        for (const variable of view.list("variables")) {
            const name = String(variable["name"]);
            const ids = groups.get(name);
            if (ids) ids.push(String(variable["id"]));
            else groups.set(name, [String(variable["id"])]);
        }
        return groups;
    };
    const [inOurs, inTheirs] = [byName(views.ours), byName(views.theirs)];
    for (const [name, ids] of byName(merged)) {
        if (ids.length < 2 || (inOurs.get(name)?.length ?? 0) > 1 || (inTheirs.get(name)?.length ?? 0) > 1)
            continue;
        const path = joinPath("variable", ids[1], "name");
        const valueIn = (view: DocumentView) =>
            view.list("variables").find((v) => v["id"] === ids[1])?.["name"];
        duplicates.push({
            ids,
            pending: {
                conflict: {
                    kind: "duplicate-id",
                    path,
                    base: valueIn(views.base),
                    ours: valueIn(views.ours),
                    theirs: valueIn(views.theirs),
                    messageKey: "merge.conflict.duplicateName{0}",
                    args: [name],
                    choices: ["ours", "theirs"],
                },
                section: Section.Variables,
                seq: seq++,
            },
        });
    }
    return { dangling, danglingRecords, duplicates };
}
