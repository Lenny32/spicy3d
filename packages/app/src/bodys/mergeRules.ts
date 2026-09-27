// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { GEOMETRY_NODE_PROPERTIES, registerMergeRule } from "@spicy3d/core";

// Merge rules of the primitive and operation bodies (docs/merge.md). Every parameter is merged on
// its own by the defaults — numbers exactly, points / vectors / planes as one value each — so only
// the node base and the kind of input are declared here.

const primitives = [
    "ArcNode",
    "BoxNode",
    "CircleNode",
    "ConeNode",
    "CylinderNode",
    "EllipseNode",
    "HelixNode",
    "LineNode",
    "PointNode",
    "PolygonNode",
    "PyramidNode",
    "RectNode",
    "RegularPolygonNode",
    "SphereNode",
];

for (const name of primitives) {
    registerMergeRule(name, {
        strategy: "node",
        properties: GEOMETRY_NODE_PROPERTIES,
        note: "A primitive: each parameter on its own (defaults).",
    });
}

// Operations on shapes captured when the command ran: the inputs are BREP copies (blobs), not
// references to the source nodes.
const operations = [
    "BooleanNode",
    "ExtrudeNode",
    "FaceNode",
    "FuseNode",
    "PipeNode",
    "RevolvedNode",
    "SweepedNode",
    "WireNode",
];

for (const name of operations) {
    registerMergeRule(name, {
        strategy: "node",
        properties: GEOMETRY_NODE_PROPERTIES,
        note: "An operation on captured shapes: numeric parameters on their own, the input shapes are opaque geometry (blob).",
    });
}
