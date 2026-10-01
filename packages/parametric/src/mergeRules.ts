// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CONSTRUCTION_REF_RULE,
    GEOMETRY_NODE_PROPERTIES,
    type MergeValueRule,
    registerMergePayload,
    registerMergeRule,
} from "@spicy3d/core";
import { type SketchData, syncExternalRoles } from "./sketch/sketchModel";

// Merge rules of the parametric module's classes and of the JSON payloads they store
// (docs/merge.md, "Features" and "Sketches"). Changing a payload's shape (a migration in
// `migrations.ts`) means updating its rule here.

const scalar: MergeValueRule = { kind: "scalar" };
const atomic: MergeValueRule = { kind: "atomic" };
const expression: MergeValueRule = { kind: "expression" };
const nodeRef: MergeValueRule = { kind: "ref", target: "node" };
const edges: MergeValueRule = { kind: "atomic", of: { kind: "ref", target: "edge" } };
const profiles: MergeValueRule = { kind: "atomic", of: { kind: "ref", target: "profile" } };

/**
 * An extrude's extent (parametric 3): by its `type`. A to-object face and the body it is on are one
 * pick; its offset is a parameter of its own. A changed type is one value.
 */
const extrudeExtent: MergeValueRule = {
    kind: "union",
    tag: "type",
    variants: {
        distance: { kind: "object", fields: { type: scalar } },
        next: {
            kind: "object",
            atomic: true,
            fields: { type: scalar, nodeIds: { kind: "atomic", of: nodeRef }, offset: expression },
        },
        toObject: {
            kind: "object",
            fields: {
                type: scalar,
                face: { kind: "ref", target: "profile" },
                nodeId: nodeRef,
                offset: expression,
            },
            groups: { face: ["face", "nodeId"] },
        },
        throughAll: { kind: "object", fields: { type: scalar } },
    },
    fallback: atomic,
};

/**
 * Derived state of a merged sketch (docs/merge.md, "Post-merge normalization"): an unpinned external
 * reference's role follows the constraints now using it, and dimension anchors of removed
 * constraints go (the solver drops them too).
 */
function normalizeSketchData(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const data = structuredClone(value) as SketchData;
    if (Array.isArray(data.constraints)) {
        syncExternalRoles(data);
        if (Array.isArray(data.anchors)) {
            const ids = new Set(data.constraints.map((c) => c.id));
            data.anchors = data.anchors.filter((anchor) => ids.has(anchor.id));
        }
    }
    return data;
}

/** Fields every feature has (`FeatureBase`). `id` is the list key. */
const featureBase = { id: scalar, type: scalar, suppressed: scalar, name: scalar };

registerMergeRule("ParametricBodyNode", {
    strategy: "node",
    properties: {
        ...GEOMETRY_NODE_PROPERTIES,
        featuresJson: { kind: "json", payload: "parametric.features" },
    },
    note:
        "A feature-list body: the stored features are its whole content (shapes are replayed). Consumed " +
        "boolean tools are its children in the tree.",
});

registerMergeRule("SketchNode", {
    strategy: "node",
    properties: {
        ...GEOMETRY_NODE_PROPERTIES,
        plane: atomic,
        planeRefJson: { kind: "json", payload: "sketch.planeRef" },
        constructionPlaneRefJson: { kind: "json", payload: "construction.ref" },
        dataJson: { kind: "json", payload: "sketch.data" },
    },
    note:
        "A 2D sketch. The plane is one value (a snapshot the plane reference re-derives); the sketch data is " +
        "merged entity by entity.",
});

registerMergePayload("parametric.features", {
    rule: {
        kind: "list",
        key: "id",
        order: "timeline",
        segment: "feature",
        item: {
            kind: "union",
            tag: "type",
            variants: {
                extrude: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        sketchId: nodeRef,
                        source: {
                            kind: "object",
                            atomic: true,
                            fields: { nodeId: nodeRef, profiles },
                        },
                        depth: expression,
                        symmetric: scalar,
                        startOffset: expression,
                        startFace: {
                            kind: "object",
                            atomic: true,
                            fields: { nodeId: nodeRef, face: atomic },
                        },
                        operation: scalar,
                        profiles,
                        // where each side ends (parametric 3)
                        extent: extrudeExtent,
                        secondExtent: extrudeExtent,
                    },
                    // the input is a sketch (and its picked profiles) or source faces (press-pull):
                    // alternatives of one choice, one value
                    groups: { input: ["sketchId", "source", "profiles"] },
                },
                revolve: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        sketchId: nodeRef,
                        axis: atomic,
                        axisSource: {
                            kind: "object",
                            atomic: true,
                            fields: { nodeId: nodeRef, edge: { kind: "ref", target: "edge" } },
                        },
                        constructionAxisRef: CONSTRUCTION_REF_RULE,
                        angle: expression,
                        profiles,
                    },
                    // the axis is a snapshot, a picked edge or a construction axis: one choice
                    groups: {
                        input: ["sketchId", "profiles"],
                        axis: ["axis", "axisSource", "constructionAxisRef"],
                    },
                },
                // A radius law is one interpolation function: merging individual knots could make
                // their order or endpoint values invalid, so resolve the whole law atomically.
                fillet: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        radius: expression,
                        radiusLaw: atomic,
                        edges,
                        // A triplet's references and their associated distances must remain coherent.
                        cornerSetbacks: {
                            kind: "atomic",
                            of: {
                                kind: "object",
                                atomic: true,
                                fields: { edges, distances: { kind: "atomic", of: expression } },
                            },
                        },
                    },
                },
                chamfer: { kind: "object", fields: { ...featureBase, distance: expression, edges } },
                boolean: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        operation: scalar,
                        // the tool order is the order of the tool id ranges (operationIds.ts): one value
                        toolIds: { kind: "atomic", of: nodeRef },
                        consumeTools: scalar,
                    },
                },
                // a loft (parametric 4): the sections are one pick, in loft order — one value
                loft: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        sections: {
                            kind: "atomic",
                            of: {
                                kind: "object",
                                fields: { sketchId: nodeRef, profile: { kind: "ref", target: "profile" } },
                            },
                        },
                        guided: {
                            kind: "object",
                            atomic: true,
                            fields: {
                                spine: { kind: "object", atomic: true, fields: { nodeId: nodeRef, edges } },
                                boundary: {
                                    kind: "object",
                                    atomic: true,
                                    fields: { nodeId: nodeRef, edges },
                                },
                            },
                        },
                        solid: scalar,
                        ruled: scalar,
                        continuity: scalar,
                    },
                },
                // Each sweep input is an atomic pick: neither its node nor its anchors can merge separately.
                sweep: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        section: {
                            kind: "object",
                            atomic: true,
                            fields: { sketchId: nodeRef, profile: { kind: "ref", target: "profile" } },
                        },
                        path: { kind: "object", atomic: true, fields: { nodeId: nodeRef, edges } },
                        solid: scalar,
                        roundCorner: scalar,
                    },
                },
                faceSweep: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        section: {
                            kind: "object",
                            atomic: true,
                            fields: { sketchId: nodeRef, profile: { kind: "ref", target: "profile" } },
                        },
                        path: { kind: "object", atomic: true, fields: { nodeId: nodeRef, edges } },
                        support: {
                            kind: "object",
                            atomic: true,
                            fields: { nodeId: nodeRef, face: { kind: "ref", target: "profile" } },
                        },
                        operation: scalar,
                        roundCorner: scalar,
                    },
                },
                projection: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        source: { kind: "object", atomic: true, fields: { nodeId: nodeRef, edges } },
                        target: {
                            kind: "object",
                            atomic: true,
                            fields: { nodeId: nodeRef, face: { kind: "ref", target: "profile" } },
                        },
                        direction: atomic,
                    },
                },
                // a thicken (parametric 5): the thickness is a parameter; the open faces are one pick
                thicken: {
                    kind: "object",
                    fields: {
                        ...featureBase,
                        thickness: expression,
                        joinType: scalar,
                        mode: scalar,
                        openFaces: profiles,
                    },
                },
                // an extrude hosted in another body, applied here (parametric 2): the host and the
                // extrude in it name one thing together — one value
                extrudeTarget: {
                    kind: "object",
                    fields: { ...featureBase, bodyId: nodeRef, featureId: scalar },
                    groups: { link: ["bodyId", "featureId"] },
                },
            },
            fallback: { kind: "object", fields: featureBase, rest: atomic },
        },
    },
    note:
        "`ParametricBodyNode.featuresJson` (`FeatureData[]`). The timeline: order is geometry. Parameters " +
        "one by one; a selection (edges, profiles, tools, a source face) is one value — the user picked it " +
        "as a whole. A feature type this build does not know merges its base fields and treats the rest " +
        "as one value each.",
});

registerMergePayload("sketch.data", {
    rule: {
        kind: "object",
        fields: {
            entities: {
                kind: "list",
                key: "id",
                order: "stable",
                segment: "entity",
                item: {
                    kind: "object",
                    fields: {
                        id: scalar,
                        type: scalar,
                        params: atomic,
                        construction: scalar,
                        control: atomic,
                        parametrization: scalar,
                        periodic: scalar,
                    },
                },
            },
            constraints: {
                kind: "list",
                key: "id",
                order: "stable",
                segment: "constraint",
                item: {
                    kind: "object",
                    fields: {
                        id: scalar,
                        kind: scalar,
                        refs: {
                            kind: "atomic",
                            of: {
                                kind: "object",
                                fields: {
                                    entityId: { kind: "ref", target: "sketch-entity" },
                                    pointIndex: scalar,
                                },
                            },
                        },
                        datum: expression,
                        datums: { kind: "atomic", of: expression },
                        blockedParams: atomic,
                        direction: atomic,
                    },
                },
            },
            anchors: {
                kind: "list",
                key: "id",
                order: "stable",
                segment: "anchor",
                item: {
                    kind: "object",
                    fields: { id: { kind: "ref", target: "sketch-constraint" }, anchor: atomic },
                },
            },
            externalRefs: {
                kind: "list",
                key: "entityId",
                order: "stable",
                segment: "external",
                item: {
                    kind: "object",
                    fields: {
                        entityId: scalar,
                        nodeId: nodeRef,
                        edge: { kind: "ref", target: "edge" },
                        role: scalar,
                        pinned: scalar,
                        type: { kind: "derived" },
                        snapshot: { kind: "derived" },
                        dangling: { kind: "derived" },
                    },
                },
            },
            refPositions: {
                kind: "map",
                segment: "refPosition",
                value: { kind: "timeline-position", bodyFrom: "key" },
            },
            entityIdSeq: { kind: "max" },
            externalIdSeq: { kind: "min" },
        },
    },
    normalize: normalizeSketchData,
    note:
        "`SketchNode.dataJson` (`SketchData`). Entities, constraints, dimension anchors and external " +
        "references are keyed by id; an entity's `params` is one value (its geometry; a bspline's fit points), " +
        "a bspline's `parametrization` and `periodic` one value each, a constraint's `refs` " +
        "one value that must resolve. The resolution results of an external reference (`type`, `snapshot`, " +
        "`dangling`) are recomputed by the rebuild. The legacy id counters merge by max / min.",
});

registerMergePayload("sketch.planeRef", {
    segment: "planeRef",
    rule: {
        kind: "object",
        atomic: true,
        fields: { nodeId: nodeRef, faceId: { kind: "ref", target: "plane-face" } },
    },
    note:
        "`SketchNode.planeRefJson` (`PlaneFaceRef`): the face the sketch sits on, one value; its node and " +
        "tracked face must resolve.",
});
