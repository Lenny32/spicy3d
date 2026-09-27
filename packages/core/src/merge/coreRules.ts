// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CONSTRUCTION_REF_RULE,
    GEOMETRY_NODE_PROPERTIES,
    type MergeValueRule,
    NODE_PROPERTIES,
    registerMergePayload,
    registerMergeRule,
} from "./rules";

// Merge rules of the classes core registers with the serializer (docs/merge.md). Parametric, app
// and wasm register theirs in their own `mergeRules.ts`.

const atomic: MergeValueRule = { kind: "atomic" };
const scalar: MergeValueRule = { kind: "scalar" };
const nodeRef: MergeValueRule = { kind: "ref", target: "node" };

// ------------------------------------------------------------------ The envelope

registerMergeRule("Document", {
    strategy: "document",
    properties: {
        id: scalar,
        name: { kind: "lww" },
        formatVersion: { kind: "derived" },
        moduleVersions: { kind: "derived" },
        models: {
            kind: "object",
            fields: {
                nodes: { kind: "list", key: "id", order: "stable", segment: "node", item: atomic },
                materials: { kind: "list", key: "id", order: "stable", segment: "material", item: atomic },
                components: { kind: "list", key: "id", order: "stable", segment: "component", item: atomic },
            },
        },
        variables: {
            kind: "list",
            key: "id",
            order: "stable",
            segment: "variable",
            item: {
                kind: "object",
                fields: { id: scalar, name: scalar, type: scalar, expression: { kind: "expression" } },
                rest: scalar,
            },
        },
        settings: { kind: "map", value: scalar, segment: "settings" },
        acts: { kind: "list", key: "name", order: "stable", segment: "act", item: atomic },
        userData: { kind: "map", value: atomic, segment: "userData" },
    },
    note:
        "The saved envelope; not a serializer class. Inputs are migrated to this build's format first, so the " +
        "version fields are this build's. `models.nodes` items follow their own class rule (the list rule " +
        "here is the tree: docs/merge.md, Tree). Variables keep a stable order (a variable may only use the " +
        "ones above it: the integrity pass checks every expression after the merge).",
});

// ------------------------------------------------------------------ Nodes

for (const name of ["FolderNode", "AnalysisGroup"]) {
    registerMergeRule(name, {
        strategy: "node",
        properties: NODE_PROPERTIES,
        note: "A folder: name, visibility and tree position.",
    });
}

registerMergeRule("GroupNode", {
    strategy: "node",
    properties: { ...NODE_PROPERTIES, transform: atomic },
    note: "A group: a folder with a transform (a matrix is one value).",
});

registerMergeRule("AnalysisNode", {
    strategy: "node",
    properties: {
        ...NODE_PROPERTIES,
        kind: scalar,
        sourcesJson: { kind: "atomic", of: nodeRef },
        settingsJson: atomic,
    },
    note: "A measurement: the picked sources are one selection; its settings one value.",
});

registerMergeRule("ComponentNode", {
    strategy: "node",
    properties: {
        ...NODE_PROPERTIES,
        transform: atomic,
        componentId: { kind: "ref", target: "component" },
        insert: atomic,
    },
    note: "An instance of a component definition.",
});

registerMergeRule("MeshNode", {
    strategy: "node",
    properties: {
        ...NODE_PROPERTIES,
        transform: atomic,
        materialId: { kind: "atomic", of: { kind: "ref", target: "material" } },
        mesh: { kind: "blob" },
    },
    note: "An imported mesh: the mesh data is opaque geometry.",
});

registerMergeRule("MultiShapeNode", {
    strategy: "node",
    properties: { ...GEOMETRY_NODE_PROPERTIES, shapes: { kind: "blob" } },
    note: "Imported shapes: the BREP list is opaque geometry.",
});

registerMergeRule("EditableShapeNode", {
    strategy: "node",
    properties: { ...GEOMETRY_NODE_PROPERTIES, shape: { kind: "blob" } },
    note: "A converted, directly edited shape: the BREP is opaque geometry.",
});

registerMergeRule("ConstructionNode", {
    strategy: "node",
    properties: {
        ...GEOMETRY_NODE_PROPERTIES,
        definitionJson: { kind: "json", payload: "construction.definition" },
        displaySize: scalar,
    },
    note: "A datum plane / axis / point / UCS defined by references to other geometry.",
});

for (const [name, fields] of [
    ["TextAnnotation", ["content", "position"]],
    ["RefInfiniteLineAnnotation", ["point", "direction"]],
    ["RefSegmentAnnotation", ["startPoint", "endPoint"]],
] as const) {
    registerMergeRule(name, {
        strategy: "node",
        properties: {
            ...NODE_PROPERTIES,
            transform: atomic,
            annotationType: scalar,
            color: scalar,
            ...Object.fromEntries(fields.map((field) => [field, field === "content" ? scalar : atomic])),
        },
        note: "An annotation: every field on its own, points and vectors as one value each.",
    });
}

// ------------------------------------------------------------------ Document lists

for (const name of ["Material", "PhongMaterial", "PhysicalMaterial"]) {
    registerMergeRule(name, {
        strategy: "record",
        key: "id",
        note:
            "An entry of `models.materials`, keyed by id: every field on its own (defaults), a texture as " +
            "one value.",
    });
}

registerMergeRule("Component", {
    strategy: "record",
    key: "id",
    properties: { name: scalar, origin: atomic, nodes: atomic },
    note:
        "An entry of `models.components`. Its nodes are stored inline, not in the tree, so the definition " +
        "is one value (a component is replaced as a whole by the commands that make one).",
});

registerMergeRule("Act", {
    strategy: "record",
    key: "name",
    properties: { cameraPosition: atomic, cameraTarget: atomic, cameraUp: atomic },
    note:
        "A saved view. Acts carry no id: keyed by name (the n-th act of one name is `name#n`); a camera is " +
        "three values set together, each atomic.",
});

// ------------------------------------------------------------------ Values and opaque data

for (const name of [
    "XY",
    "XYZ",
    "Plane",
    "Ray",
    "Line",
    "LineSegment",
    "Matrix4",
    "FaceMaterialPair",
    "MeshGroup",
]) {
    registerMergeRule(name, {
        strategy: "value",
        note: "An immutable value object: one value, exact equality.",
    });
}

registerMergeRule("Texture", {
    strategy: "value",
    note: "A material's texture: one value (its image is a data URL, a blob in cloud manifests).",
});

registerMergeRule("Mesh", {
    strategy: "blob",
    note: "Mesh buffers: opaque, compared by content.",
});

for (const name of ["Float16Array", "Float32Array", "Uint32Array"]) {
    registerMergeRule(name, {
        strategy: "blob",
        note: "A typed array (mesh buffers): opaque, compared by content.",
    });
}

registerMergeRule("Result", {
    strategy: "atomic",
    note: "Registered for serialization but never stored in a document: the explicit atomic fallback.",
});

// ------------------------------------------------------------------ Payloads

registerMergePayload("construction.definition", {
    rule: {
        // a changed `kind` makes the whole definition one value (the other fields change meaning);
        // within one kind every field is a ConstructionRef, a number or a small option: one value each
        kind: "union",
        tag: "kind",
        variants: {},
        fallback: { kind: "object", fields: {}, rest: CONSTRUCTION_REF_RULE },
    },
    segment: "definition",
    note:
        "`ConstructionNode.definitionJson` (`ConstructionDefinition`). A changed `kind` replaces the whole " +
        "definition (atomic); otherwise field by field, each `ConstructionRef` one value that must resolve " +
        "(its `nodeId`, tracked `trackedId`/`incidentEdgeIds`), its `featureIndex` a timeline position.",
});

registerMergePayload("construction.ref", {
    rule: CONSTRUCTION_REF_RULE,
    segment: "constructionPlaneRef",
    note:
        "`SketchNode.constructionPlaneRefJson` (`ConstructionRef`): the construction plane a sketch sits " +
        "on, one value; its `featureIndex` a timeline position.",
});
