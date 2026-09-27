// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The merge rule registry: how each serialized class, and each JSON payload stored inside a string
// property (a body's `featuresJson`, a sketch's `dataJson`, ...), is merged three-way. Rules are
// declarations — data the engine (CLOUD-12) interprets and docs/merge.md is generated from — and
// every module registers the rules of the classes it registers with the serializer, next to them.
// A class the serializer knows without a rule fails `mergeRules.test.ts` (packages/builder).

/** What a reference points at; the referential-integrity pass resolves each kind (docs/merge.md). */
export type MergeRefTarget =
    /** A node id in `models.nodes`. */
    | "node"
    /** A material id in `models.materials`. */
    | "material"
    /** A component id in `models.components`. */
    | "component"
    /** A sketch entity id of the same sketch (datum ids -1..-3 always resolve; externals via `externalRefs`). */
    | "sketch-entity"
    /** A constraint id of the same sketch. */
    | "sketch-constraint"
    /** An `EdgeRef`: its tracked `edgeId` components name the features that made the edge. */
    | "edge"
    /** A `ProfileRef`: sketch entity ids (`entities`) and/or a tracked face `id`. */
    | "profile"
    /** A tracked sub-shape id of a `ConstructionRef`, in the body named by the ref's `nodeId` (see {@link CONSTRUCTION_REF_RULE}). */
    | "construction-ref"
    /** A `PlaneFaceRef` (a sketch's `planeRefJson`): a node id and a tracked `faceId`. */
    | "plane-face";

/**
 * How one value is merged. The default for a property no rule lists: `scalar` for JSON primitives,
 * the class strategy for a `{ "__cla$$__": ... }` object, `blob` for a `{ "$blob": sha }` reference,
 * `atomic` for any other array or object (docs/merge.md, "Defaults").
 */
export type MergeValueRule =
    /** Exact 3-way on the JSON value: one side changed → that side; both, differently → `property` conflict. No tolerance. */
    | { readonly kind: "scalar" }
    /**
     * The whole value is one scalar (deep equality, key order ignored). `of` only describes the
     * elements for the integrity pass (e.g. a list of `EdgeRef`s that must resolve).
     */
    | { readonly kind: "atomic"; readonly of?: MergeValueRule }
    /** Opaque content compared by hash (`$blob`); both changed differently → `blob` conflict. */
    | { readonly kind: "blob" }
    /** No conflict: the side saved last wins (the document name). */
    | { readonly kind: "lww" }
    /** No conflict: the larger / smaller value (legacy monotonic counters). */
    | { readonly kind: "max" }
    | { readonly kind: "min" }
    /**
     * Recomputed by the rebuild (a resolution snapshot, a `dangling` flag): never a conflict — the
     * side that changed it, else ours; the validation pass refreshes it.
     */
    | { readonly kind: "derived" }
    /** A `ParameterValue` (number or expression): `scalar`, and every name in it must be a variable. */
    | { readonly kind: "expression" }
    /** `scalar`, and the value must resolve to an existing `target` after the merge. */
    | { readonly kind: "ref"; readonly target: MergeRefTarget }
    /**
     * A timeline position (a feature count) in the body named by the map key (`bodyFrom: "key"`)
     * or by the sibling `nodeId` field: merged as the id of the feature before it, then projected
     * onto the merged feature list (docs/merge.md, "Timeline positions").
     */
    | { readonly kind: "timeline-position"; readonly bodyFrom: "key" | "nodeId" }
    /** The node's parent (`parentId`): the tree rules (move / cycle). */
    | { readonly kind: "parent" }
    /**
     * Field by field; `rest` covers fields not listed (default: the "Defaults" above). `atomic`
     * merges the object as one value, the fields then only describe references. `groups` name
     * fields that are alternatives of one choice (a revolve axis snapshot, edge and construction
     * axis): each group is one value, at the path segment of its name.
     */
    | {
          readonly kind: "object";
          readonly fields: Readonly<Record<string, MergeValueRule>>;
          readonly rest?: MergeValueRule;
          readonly atomic?: boolean;
          readonly groups?: Readonly<Record<string, readonly string[]>>;
      }
    /**
     * An object whose shape depends on `tag`: the same tag on every side → that variant's rule
     * (`fallback` for a tag not listed); a changed tag → the whole value is atomic.
     */
    | {
          readonly kind: "union";
          readonly tag: string;
          readonly variants: Readonly<Record<string, MergeValueRule>>;
          readonly fallback?: MergeValueRule;
      }
    /**
     * An id-keyed list: items matched by `key`, merged by `item`, order by diff3 over the key
     * sequences. `timeline`: order is semantic (concurrent inserts at one position and different
     * reorders of one item are `order` conflicts). `stable`: order is incidental — inserts at one
     * position go ours first, then theirs; concurrent reorders keep ours. `segment` names the item
     * in merge paths (`feature`, `entity`, ...).
     */
    | {
          readonly kind: "list";
          readonly key: string;
          readonly order: "timeline" | "stable";
          readonly segment: string;
          readonly item: MergeValueRule;
      }
    /** A string-keyed map: per key 3-way on `value` (added / removed / changed keys). `segment` names the entry in paths. */
    | { readonly kind: "map"; readonly value: MergeValueRule; readonly segment?: string }
    /** A string property holding JSON: parsed, merged by the payload rule `payload`, written back as JSON. */
    | { readonly kind: "json"; readonly payload: string };

/**
 * How instances of a serialized class are merged:
 * - `document` — the envelope (only `Document`);
 * - `node` — an element of `models.nodes`: keyed by `id`, properties merged one by one, `parentId` and sibling order by the tree rules;
 * - `record` — an element of another document list (materials, components, acts), keyed by `key`, properties one by one;
 * - `value` — an immutable value object (a vector, plane, matrix): atomic, compared by deep equality;
 * - `blob` — opaque geometry (a BREP shape, a mesh, a typed array): atomic, compared by content hash, `blob` conflicts;
 * - `atomic` — the explicit fallback: the whole object is one value.
 */
export type MergeClassStrategy = "document" | "node" | "record" | "value" | "blob" | "atomic";

export interface MergeClassRule {
    readonly strategy: MergeClassStrategy;
    /** The field identifying a `record` (materials: `id`, acts: `name`). Nodes are keyed by `id`. */
    readonly key?: string;
    /** Rules of the properties that differ from the defaults; inherited ones are listed again (rules are flat). */
    readonly properties?: Readonly<Record<string, MergeValueRule>>;
    /** Why this rule — rendered into docs/merge.md. */
    readonly note: string;
}

export interface MergePayloadRule {
    readonly rule: MergeValueRule;
    readonly note: string;
    /**
     * The path segment of the payload's root below its node (`node/<id>/<segment>`, e.g.
     * `definition`); absent when the payload's items carry their own segments (`feature/…`,
     * `entity/…`) right below the node.
     */
    readonly segment?: string;
    /**
     * Post-merge normalization of derived state (docs/merge.md), applied to a merged payload that
     * differs from every side's: pure, returns the normalized value (never mutates its input).
     */
    readonly normalize?: (value: unknown) => unknown;
}

/** Properties every node shares (`Node`, `VisualNode`, `GeometryNode`); node rules spread this. */
export const NODE_PROPERTIES: Readonly<Record<string, MergeValueRule>> = {
    parentId: { kind: "parent" },
    name: { kind: "scalar" },
    visible: { kind: "scalar" },
};

/** `NODE_PROPERTIES` plus the ones of a `GeometryNode` (every body). */
export const GEOMETRY_NODE_PROPERTIES: Readonly<Record<string, MergeValueRule>> = {
    ...NODE_PROPERTIES,
    transform: { kind: "atomic" },
    materialId: { kind: "atomic", of: { kind: "ref", target: "material" } },
    faceMaterialPair: { kind: "atomic" },
};

/**
 * A `ConstructionRef` (core `construction/types.ts`), one value: its `nodeId` and tracked ids
 * (`trackedId`, `incidentEdgeIds`) must resolve, and its `featureIndex` is a timeline position in
 * the body named by its `nodeId`, merged as an anchor id like `refPositions` (docs/merge.md,
 * "Timeline positions"). Refs nest (a snap's `source`, a path's `segments`): every nested one is
 * read the same way.
 */
export const CONSTRUCTION_REF_RULE: MergeValueRule = {
    kind: "object",
    atomic: true,
    fields: {
        nodeId: { kind: "ref", target: "node" },
        featureIndex: { kind: "timeline-position", bodyFrom: "nodeId" },
        trackedId: { kind: "ref", target: "construction-ref" },
        incidentEdgeIds: { kind: "atomic", of: { kind: "ref", target: "construction-ref" } },
    },
};

/**
 * What a node of a class this build does not register (an `UnknownNode`, a plugin not loaded) is
 * merged by: its tree position like any node, everything else as one value.
 */
export const UNKNOWN_CLASS_RULE: MergeClassRule = {
    strategy: "atomic",
    properties: NODE_PROPERTIES,
    note: "Class not registered in this build: tree position as a node, the rest as one value.",
};

export class MergeRuleRegistry {
    private readonly classes = new Map<string, MergeClassRule>();
    private readonly payloads = new Map<string, MergePayloadRule>();

    /** Declares the rule of a serialized class (its `__cla$$__` name). */
    registerClass(className: string, rule: MergeClassRule): void {
        if (this.classes.has(className)) throw new Error(`Merge rule for ${className} is already registered`);
        if (rule.strategy === "record" && rule.key === undefined) {
            throw new Error(`Merge rule for ${className}: a record needs a key`);
        }
        this.classes.set(className, rule);
    }

    /** Declares a JSON payload rule, referenced by `{ kind: "json", payload: name }`. */
    registerPayload(name: string, rule: MergePayloadRule): void {
        if (this.payloads.has(name)) throw new Error(`Merge payload ${name} is already registered`);
        this.payloads.set(name, rule);
    }

    classRule(className: string): MergeClassRule | undefined {
        return this.classes.get(className);
    }

    /** The class rule, or {@link UNKNOWN_CLASS_RULE} for a class without one. */
    ruleOf(className: string): MergeClassRule {
        return this.classes.get(className) ?? UNKNOWN_CLASS_RULE;
    }

    payloadRule(name: string): MergePayloadRule | undefined {
        return this.payloads.get(name);
    }

    classNames(): string[] {
        return [...this.classes.keys()].sort();
    }

    payloadNames(): string[] {
        return [...this.payloads.keys()].sort();
    }

    /** The names of `classNames` without a rule. */
    uncovered(classNames: readonly string[]): string[] {
        return classNames.filter((name) => !this.classes.has(name));
    }

    /** Payload names referenced by some rule but never registered. */
    missingPayloads(): string[] {
        const referenced = new Set<string>();
        const visit = (rule: MergeValueRule | undefined): void => {
            if (rule === undefined) return;
            switch (rule.kind) {
                case "json":
                    referenced.add(rule.payload);
                    return;
                case "atomic":
                    visit(rule.of);
                    return;
                case "object":
                    Object.values(rule.fields).forEach(visit);
                    visit(rule.rest);
                    return;
                case "union":
                    Object.values(rule.variants).forEach(visit);
                    visit(rule.fallback);
                    return;
                case "list":
                    visit(rule.item);
                    return;
                case "map":
                    visit(rule.value);
                    return;
                default:
                    return;
            }
        };
        for (const rule of this.classes.values()) Object.values(rule.properties ?? {}).forEach(visit);
        for (const payload of this.payloads.values()) visit(payload.rule);
        return [...referenced].filter((name) => !this.payloads.has(name)).sort();
    }
}

/** The registry the merge engine uses; modules register on it when they load. */
export const MergeRules = new MergeRuleRegistry();

export function registerMergeRule(className: string, rule: MergeClassRule): void {
    MergeRules.registerClass(className, rule);
}

export function registerMergePayload(name: string, rule: MergePayloadRule): void {
    MergeRules.registerPayload(name, rule);
}
