// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isLengthUnit } from "../units/lengthUnit";
import { type DocumentView, payloadProperties } from "./documentView";
import { isAbsent, isRecord, type Json } from "./json";
import { fieldPath, itemFieldPrefix, itemLabel, joinPath, nodeLabel } from "./paths";
import type { MergeRefTarget, MergeRuleRegistry, MergeValueRule } from "./rules";
import { Section } from "./structural";

// Referential integrity (docs/merge.md, "Referential integrity"): every reference of a document,
// with whether it resolves there. The merge runs it on the merged document and on both parents: a
// reference that fails only in the merge (its value came from a parent where it resolved) is a
// `dangling-ref`. Tracked sub-shape ids are read without the kernel — their components name the
// feature (`<featureId>:…`) or tool node (`tool:<nodeId>:…`) that made them.

export interface ReferenceRecord {
    /** The referrer value's path (the conflict path). */
    readonly path: string;
    readonly value: unknown;
    readonly resolved: boolean;
    /** Labels of what is missing (the first is the conflict's `args[1]`). */
    readonly missing: readonly string[];
    /** The innermost item holding the reference (a feature, entity, constraint, variable, node). */
    readonly item: string;
    /** Item paths of the missing targets (a resolution takes them from the chosen side). */
    readonly targets: readonly string[];
    readonly section: Section;
    readonly nodeId?: string;
    readonly label: string;
}

/** Names a label for a missing target from every version (the target exists in some parent). */
/**
 * The sketches a stored feature sweeps — what its `sketch:<sketchId>:…` tracked ids name: an
 * extrude's or revolve's `sketchId`, every section's of a loft.
 */
export function featureSketchIds(feature: object): string[] {
    const fields = feature as Readonly<Record<string, unknown>>;
    const ids = typeof fields["sketchId"] === "string" ? [fields["sketchId"]] : [];
    const sections = fields["sections"];
    if (Array.isArray(sections)) {
        for (const section of sections) {
            const id = typeof section === "object" && section !== null ? section["sketchId"] : undefined;
            if (typeof id === "string") ids.push(id);
        }
    }
    return ids;
}

export interface TargetNames {
    node(id: string): string;
    /** The feature of `body` that swept `sketchId` in some version (what a `sketch:<id>:…` tracked id needs). */
    sketchFeature(body: string, sketchId: string): string | undefined;
    entity(sketchId: string, entityId: number): string;
    /** Owning item to restore: text contour ids resolve through their text record. */
    entityTarget(sketchId: string, entityId: number): string;
    variableItem(name: string): string | undefined;
}

interface Env {
    readonly view: DocumentView;
    readonly nodeId?: string;
    readonly section: Section;
    readonly item: string;
    readonly label: string;
    /** What a reference from inside a timeline may use: the features before its feature. */
    readonly before?: Sources;
    /** The sketch whose entity ids `sketch-entity` refs name, and its ids. */
    readonly sketch?: { readonly id: string; readonly entities: ReadonlySet<number> };
    readonly siblings?: Json;
    readonly prefix?: readonly string[];
}

/** The sources tracked ids may name: feature ids, and sketches those features swept. */
interface Sources {
    readonly features: ReadonlySet<string>;
    readonly sketches: ReadonlySet<string>;
}

const FUNCTION_OR_CONSTANT = new Set([
    "abs",
    "sqrt",
    "floor",
    "ceil",
    "round",
    "min",
    "max",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "atan2",
    "pi",
    "e",
]);

/** The variable names an expression uses (functions, constants and unit suffixes left out). */
export function expressionNames(value: unknown): string[] {
    if (typeof value !== "string") return [];
    const names: string[] = [];
    const pattern = /[A-Za-z_]\w*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+|\S/g;
    const tokens = [...value.matchAll(pattern)].map((m) => m[0]);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!/^[A-Za-z_]/.test(token)) continue;
        const previous = tokens[i - 1];
        const unitSuffix = previous !== undefined && (/^[\d.]/.test(previous) || previous === ")");
        if (unitSuffix && isLengthUnit(token)) continue;
        if (tokens[i + 1] === "(" || FUNCTION_OR_CONSTANT.has(token)) continue;
        names.push(token);
    }
    return names;
}

/** Every reference of `view`, by path (docs/merge.md's reference table). */
export function collectReferences(
    view: DocumentView,
    rules: MergeRuleRegistry,
    names: TargetNames,
): Map<string, ReferenceRecord> {
    const records = new Map<string, ReferenceRecord>();
    const variableNames = new Set(view.list("variables").map((v) => String(v["name"])));
    const materials = new Set(view.modelList("materials").map((m) => String(m["id"])));
    const components = new Set(view.modelList("components").map((c) => String(c["id"])));

    const record = (
        env: Env,
        path: string,
        value: unknown,
        missing: { label: string; target?: string }[],
    ) => {
        records.set(path, {
            path,
            value,
            resolved: missing.length === 0,
            missing: missing.map((m) => m.label),
            item: env.item,
            targets: missing.flatMap((m) => (m.target === undefined ? [] : [m.target])),
            section: env.section,
            nodeId: env.nodeId,
            label: env.label,
        });
    };

    // Variables: an expression may use the ones above it.
    const above = new Set<string>();
    for (const variable of view.list("variables")) {
        const id = String(variable["id"]);
        const item = joinPath("variable", id);
        const env: Env = { view, section: Section.Variables, item, label: String(variable["name"] ?? id) };
        const missing = expressionNames(variable["expression"])
            .filter((name) => !above.has(name))
            .map((name) => ({ label: name, target: names.variableItem(name) }));
        record(env, joinPath(item, "expression"), variable["expression"], missing);
        above.add(String(variable["name"]));
    }

    /**
     * Tracked-id components that name nothing (docs/merge.md): `tool:<nodeId>:…` a node that is
     * gone, `sketch:<sketchId>:…` a sketch no allowed feature swept, `<featureId>:…` a feature not
     * allowed (not before the referrer in its own body, or gone from the referenced one).
     */
    const trackedMissing = (id: unknown, body: string | undefined, allowed: Sources | undefined) => {
        const missing: { label: string; target?: string }[] = [];
        if (typeof id !== "string") return missing;
        for (const component of id.split("|")) {
            const parts = component.split(":");
            if (parts[0] === "tool") {
                const node = parts[1];
                if (node && !view.byId.has(node))
                    missing.push({ label: names.node(node), target: joinPath("node", node) });
                continue;
            }
            if (parts.length < 2 || allowed === undefined) continue;
            if (parts[0] === "sketch") {
                const sketch = parts[1];
                if (allowed.sketches.has(sketch)) continue;
                const feature = body === undefined ? undefined : names.sketchFeature(body, sketch);
                missing.push({
                    label: feature ?? names.node(sketch),
                    target:
                        feature === undefined || body === undefined
                            ? undefined
                            : joinPath("node", body, "feature", feature),
                });
                continue;
            }
            if (!allowed.features.has(parts[0])) {
                missing.push({
                    label: parts[0],
                    target: body === undefined ? undefined : joinPath("node", body, "feature", parts[0]),
                });
            }
        }
        return missing;
    };
    const sourcesOf = (features: readonly Json[]): Sources => ({
        features: new Set(features.map((f) => String(f["id"]))),
        sketches: new Set(features.flatMap(featureSketchIds)),
    });
    /** What a reference into `body` from outside it may use: all its features (when it has a timeline). */
    const featuresOf = (body: unknown): Sources | undefined => {
        if (typeof body !== "string") return undefined;
        const features = view.features(body);
        return features === undefined ? undefined : sourcesOf(features);
    };
    /** A sketch's data: the payload of the node that has `entities`. */
    const sketchDataOf = (id: string): Json | undefined => {
        const className = view.className(id);
        if (className === undefined) return undefined;
        for (const property of payloadProperties(rules, className).keys()) {
            const parsed = view.payload(id, property);
            if (parsed.ok && isRecord(parsed.value) && Array.isArray(parsed.value["entities"]))
                return parsed.value;
        }
        return undefined;
    };
    const nodeMissing = (id: unknown) =>
        typeof id === "string" && !view.byId.has(id)
            ? [{ label: names.node(id), target: joinPath("node", id) }]
            : [];

    /** Every `ConstructionRef` inside `value` (they nest: snap sources, path segments). */
    const constructionMissing = (value: unknown): { label: string; target?: string }[] => {
        if (Array.isArray(value)) return value.flatMap(constructionMissing);
        if (!isRecord(value)) return [];
        const missing: { label: string; target?: string }[] = [];
        if (typeof value["nodeId"] === "string") {
            missing.push(...nodeMissing(value["nodeId"]));
            const allowed = featuresOf(value["nodeId"]);
            missing.push(...trackedMissing(value["trackedId"], value["nodeId"], allowed));
            if (Array.isArray(value["incidentEdgeIds"])) {
                for (const edge of value["incidentEdgeIds"])
                    missing.push(...trackedMissing(edge, value["nodeId"], allowed));
            }
        }
        for (const [key, item] of Object.entries(value)) {
            if (key !== "incidentEdgeIds") missing.push(...constructionMissing(item));
        }
        return missing;
    };

    const refMissing = (
        target: MergeRefTarget,
        value: unknown,
        env: Env,
    ): { label: string; target?: string }[] => {
        if (isAbsent(value)) return [];
        const siblings = env.siblings ?? {};
        switch (target) {
            case "node":
                return nodeMissing(value);
            case "material":
                return (Array.isArray(value) ? value : [value])
                    .filter((id) => typeof id === "string" && id !== "" && !materials.has(id))
                    .map((id) => ({ label: String(id), target: joinPath("material", String(id)) }));
            case "component":
                return typeof value === "string" && !components.has(value)
                    ? [{ label: value, target: joinPath("component", value) }]
                    : [];
            case "sketch-entity": {
                if (typeof value !== "number" || env.sketch === undefined) return [];
                if (value < 0 && value >= -3) return [];
                if (env.sketch.entities.has(value)) return [];
                return [
                    {
                        label: names.entity(env.sketch.id, value),
                        target: names.entityTarget(env.sketch.id, value),
                    },
                ];
            }
            case "sketch-constraint":
                // an anchor of a removed constraint is dropped by the normalization, never dangling
                return [];
            case "edge": {
                const edgeId = isRecord(value) ? value["edgeId"] : undefined;
                const body = typeof siblings["nodeId"] === "string" ? siblings["nodeId"] : env.nodeId;
                const own = body === env.nodeId && env.before !== undefined;
                return trackedMissing(edgeId, body, own ? env.before : featuresOf(body));
            }
            case "profile": {
                if (!isRecord(value)) return [];
                const missing: { label: string; target?: string }[] = [];
                const sketchId = siblings["sketchId"];
                if (
                    Array.isArray(value["entities"]) &&
                    typeof sketchId === "string" &&
                    view.byId.has(sketchId)
                ) {
                    const data = sketchDataOf(sketchId);
                    const entities = data === undefined ? undefined : sketchEntities(data);
                    for (const entity of value["entities"]) {
                        if (entities !== undefined && typeof entity === "number" && !entities.has(entity)) {
                            missing.push({
                                label: names.entity(sketchId, entity),
                                target: names.entityTarget(sketchId, entity),
                            });
                        }
                    }
                }
                if (value["id"] !== undefined) {
                    const body = siblings["nodeId"];
                    const own = body === env.nodeId && env.before !== undefined;
                    missing.push(
                        ...trackedMissing(
                            value["id"],
                            typeof body === "string" ? body : undefined,
                            own ? env.before : featuresOf(body),
                        ),
                    );
                }
                return missing;
            }
            case "construction-ref":
                return constructionMissing(value);
            case "plane-face": {
                if (!isRecord(value)) return [];
                return [
                    ...nodeMissing(value["nodeId"]),
                    ...trackedMissing(
                        value["faceId"],
                        value["nodeId"] as string,
                        featuresOf(value["nodeId"]),
                    ),
                ];
            }
        }
    };

    /** The missing targets inside `value` by `rule` (reported together at the enclosing path when `atomic`). */
    const missingIn = (
        rule: MergeValueRule | undefined,
        value: unknown,
        env: Env,
    ): { label: string; target?: string }[] => {
        if (rule === undefined || isAbsent(value)) return [];
        switch (rule.kind) {
            case "ref":
                return refMissing(rule.target, value, env);
            case "expression":
                return expressionNames(value)
                    .filter((name) => !variableNames.has(name))
                    .map((name) => ({ label: name, target: names.variableItem(name) }));
            case "atomic": {
                if (rule.of === undefined) return [];
                if (typeof value === "string" && rule.of.kind === "ref" && rule.of.target === "node") {
                    // a JSON string of picks (an analysis's sources): every `nodeId` in it
                    try {
                        return nodeIdsIn(JSON.parse(value)).flatMap(nodeMissing);
                    } catch {
                        return nodeMissing(value);
                    }
                }
                return (Array.isArray(value) ? value : [value]).flatMap((item) =>
                    missingIn(rule.of, item, env),
                );
            }
            case "object": {
                if (!isRecord(value)) return [];
                if (
                    Object.values(rule.fields).some(
                        (f) => f.kind === "timeline-position" && f.bodyFrom === "nodeId",
                    )
                ) {
                    return constructionMissing(value);
                }
                const inner = { ...env, siblings: value };
                return Object.entries(rule.fields).flatMap(([key, fieldRule]) =>
                    missingIn(fieldRule, value[key], inner),
                );
            }
            default:
                return [];
        }
    };

    const walk = (rule: MergeValueRule | undefined, value: unknown, path: string, env: Env): void => {
        if (rule === undefined || isAbsent(value)) return;
        switch (rule.kind) {
            case "ref":
            case "expression":
            case "atomic":
                if (rule.kind !== "atomic" || rule.of !== undefined)
                    record(env, path, value, missingIn(rule, value, env));
                return;
            case "object": {
                if (!isRecord(value)) return;
                if (rule.atomic) {
                    record(env, path, value, missingIn(rule, value, env));
                    return;
                }
                const prefix = env.prefix ?? [];
                const inner: Env = { ...env, siblings: value, prefix: undefined };
                for (const [key, fieldRule] of Object.entries(rule.fields)) {
                    walk(fieldRule, value[key], fieldPath(path, prefix, key, fieldRule), inner);
                }
                if (rule.rest !== undefined) {
                    for (const key of Object.keys(value)) {
                        if (!(key in rule.fields))
                            walk(rule.rest, value[key], fieldPath(path, prefix, key, rule.rest), inner);
                    }
                }
                return;
            }
            case "union": {
                if (!isRecord(value)) return;
                const tag = value[rule.tag];
                walk(
                    (typeof tag === "string" ? rule.variants[tag] : undefined) ?? rule.fallback,
                    value,
                    path,
                    env,
                );
                return;
            }
            case "list": {
                if (!Array.isArray(value)) return;
                const items = value.filter(isRecord);
                for (const [index, item] of items.entries()) {
                    const key = item[rule.key];
                    const itemPath = joinPath(path, rule.segment, String(key));
                    walk(rule.item, item, itemPath, {
                        ...env,
                        item: itemPath,
                        label: itemLabel(rule.segment, item, key),
                        before: rule.order === "timeline" ? sourcesOf(items.slice(0, index)) : env.before,
                        prefix: itemFieldPrefix(rule.segment),
                    });
                }
                return;
            }
            case "map":
                if (!isRecord(value)) return;
                for (const [key, entry] of Object.entries(value)) {
                    walk(
                        rule.value,
                        entry,
                        rule.segment ? joinPath(path, rule.segment, key) : joinPath(path, key),
                        env,
                    );
                }
                return;
            default:
                return;
        }
    };

    for (const node of view.nodes) {
        const id = node["id"] as string;
        const className = String(node["__cla$$__"]);
        const rule = rules.classRule(className);
        if (rule === undefined) continue;
        const payloads = payloadProperties(rules, className);
        const nodePath = joinPath("node", id);
        const env: Env = {
            view,
            nodeId: id,
            section: Section.Nodes,
            item: nodePath,
            label: nodeLabel(node, id),
        };
        for (const [property, propertyRule] of Object.entries(rule.properties ?? {})) {
            const payload = payloads.get(property);
            if (payload === undefined) {
                walk(propertyRule, node[property], joinPath(nodePath, "prop", property), env);
                continue;
            }
            const payloadRule = rules.payloadRule(payload);
            const parsed = view.payload(id, property);
            if (payloadRule === undefined || !parsed.ok) continue;
            const root =
                payloadRule.segment === undefined ? nodePath : joinPath(nodePath, payloadRule.segment);
            const sketch =
                isRecord(parsed.value) && Array.isArray(parsed.value["entities"])
                    ? { id, entities: sketchEntities(parsed.value) }
                    : undefined;
            walk(payloadRule.rule, parsed.value, root, { ...env, sketch });
        }
    }
    return records;
}

function sketchEntities(data: Json): Set<number> {
    const ids = new Set<number>();
    for (const text of Array.isArray(data["texts"]) ? data["texts"] : []) {
        if (!isRecord(text)) continue;
        if (typeof text["id"] === "number") ids.add(text["id"]);
        for (const id of Array.isArray(text["profileIds"]) ? text["profileIds"] : []) {
            if (typeof id === "number") ids.add(id);
        }
    }
    for (const entity of Array.isArray(data["entities"]) ? data["entities"] : []) {
        if (isRecord(entity) && typeof entity["id"] === "number") ids.add(entity["id"]);
    }
    for (const external of Array.isArray(data["externalRefs"]) ? data["externalRefs"] : []) {
        if (isRecord(external) && typeof external["entityId"] === "number") ids.add(external["entityId"]);
    }
    return ids;
}

function nodeIdsIn(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(nodeIdsIn);
    if (!isRecord(value)) return [];
    const own = typeof value["nodeId"] === "string" ? [value["nodeId"]] : [];
    return [...own, ...Object.values(value).flatMap(nodeIdsIn)];
}
