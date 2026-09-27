// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Serialized } from "../serialize";
import { isRecord, type Json } from "./json";
import type { MergeRuleRegistry, MergeValueRule } from "./rules";

// One serialized document as the merge reads it: O(1) node lookup by id, children per parent,
// pre-order positions, and its JSON payloads parsed once (docs/merge.md, "Inputs").

export type SideName = "base" | "ours" | "theirs";

export interface ParsedPayload {
    readonly ok: boolean;
    readonly value: unknown;
}

const NOT_PARSED: ParsedPayload = { ok: false, value: undefined };

/** The JSON-payload properties of a class (`json` rules), by property. */
export function payloadProperties(rules: MergeRuleRegistry, className: string): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    const properties = rules.classRule(className)?.properties ?? {};
    for (const [property, rule] of Object.entries(properties)) {
        if (rule.kind === "json") result.set(property, rule.payload);
    }
    return result;
}

/** The property holding a node's timeline (a `json` payload whose rule is a `timeline` list), if any. */
export function timelineProperty(rules: MergeRuleRegistry, className: string): string | undefined {
    for (const [property, payload] of payloadProperties(rules, className)) {
        const rule: MergeValueRule | undefined = rules.payloadRule(payload)?.rule;
        if (rule?.kind === "list" && rule.order === "timeline") return property;
    }
    return undefined;
}

export class DocumentView {
    readonly nodes: readonly Json[];
    readonly byId = new Map<string, Json>();
    readonly index = new Map<string, number>();
    readonly children = new Map<string, string[]>();
    readonly rootId: string | undefined;
    private readonly parsed = new Map<string, ParsedPayload>();
    private readonly timelines = new Map<string, string[] | undefined>();

    constructor(
        readonly side: SideName | "merged",
        readonly data: Serialized,
        private readonly rules: MergeRuleRegistry,
        /** Payload values already parsed (the merged document, before it is stringified). */
        private readonly preParsed?: ReadonlyMap<string, unknown>,
        /** The text of a payload stored as a blob reference (a manifest), when another input has it inline. */
        private readonly blobText?: (ref: unknown) => string | undefined,
    ) {
        const models = isRecord(data["models"]) ? data["models"] : {};
        const nodes = Array.isArray(models["nodes"]) ? models["nodes"] : [];
        this.nodes = nodes.filter((node): node is Json => isRecord(node) && typeof node["id"] === "string");
        this.rootId = this.nodes[0]?.["id"] as string | undefined;
        for (const [index, node] of this.nodes.entries()) {
            const id = node["id"] as string;
            if (this.byId.has(id)) continue;
            this.byId.set(id, node);
            this.index.set(id, index);
            const parent = node["parentId"];
            if (typeof parent === "string" && index > 0) {
                const siblings = this.children.get(parent);
                if (siblings) siblings.push(id);
                else this.children.set(parent, [id]);
            }
        }
    }

    parentOf(id: string): string | undefined {
        const parent = this.byId.get(id)?.["parentId"];
        return typeof parent === "string" && id !== this.rootId ? parent : undefined;
    }

    childrenOf(id: string): readonly string[] {
        return this.children.get(id) ?? [];
    }

    /** The node's pre-order descendants (not itself). */
    descendants(id: string): string[] {
        const result: string[] = [];
        const stack = [...this.childrenOf(id)].reverse();
        while (stack.length > 0) {
            const next = stack.pop()!;
            result.push(next);
            stack.push(...[...this.childrenOf(next)].reverse());
        }
        return result;
    }

    className(id: string): string | undefined {
        const name = this.byId.get(id)?.["__cla$$__"];
        return typeof name === "string" ? name : undefined;
    }

    /** A JSON payload of a node, parsed (once); `ok: false` when missing or not JSON. */
    payload(id: string, property: string): ParsedPayload {
        const key = `${id}\u0000${property}`;
        if (this.preParsed?.has(key)) return { ok: true, value: this.preParsed.get(key) };
        let parsed = this.parsed.get(key);
        if (parsed === undefined) {
            const stored = this.byId.get(id)?.[property];
            const raw = typeof stored === "string" ? stored : this.blobText?.(stored);
            if (typeof raw !== "string") {
                parsed = NOT_PARSED;
            } else {
                try {
                    parsed = { ok: true, value: JSON.parse(raw) };
                } catch {
                    parsed = NOT_PARSED;
                }
            }
            this.parsed.set(key, parsed);
        }
        return parsed;
    }

    /** The feature ids of a body's timeline in order, `undefined` when the node has none. */
    timeline(id: string): string[] | undefined {
        if (this.timelines.has(id)) return this.timelines.get(id);
        const ids = this.features(id)?.map((feature) => String(feature["id"] ?? ""));
        this.timelines.set(id, ids);
        return ids;
    }

    /** The features of a body's timeline (parsed), `undefined` when the node has none. */
    features(id: string): Json[] | undefined {
        const className = this.className(id);
        const property = className === undefined ? undefined : timelineProperty(this.rules, className);
        if (property === undefined) return undefined;
        const parsed = this.payload(id, property);
        if (!parsed.ok || !Array.isArray(parsed.value)) return undefined;
        return parsed.value.map((feature) => (isRecord(feature) ? feature : {}));
    }

    list(field: "variables" | "acts"): Json[] {
        const value = this.data[field];
        return Array.isArray(value) ? value.filter(isRecord) : [];
    }

    modelList(field: "materials" | "components"): Json[] {
        const models = this.data["models"];
        const value = isRecord(models) ? models[field] : undefined;
        return Array.isArray(value) ? value.filter(isRecord) : [];
    }
}
