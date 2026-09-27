// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerMergeRule } from "@spicy3d/core";

// Merge rules of the kernel shapes (docs/merge.md): a serialized shape is its BREP text (a blob in
// cloud manifests), compared by content — never merged inside.

for (const name of [
    "OccShape",
    "OccVertex",
    "OccEdge",
    "OccWire",
    "OccFace",
    "OccShell",
    "OccSolid",
    "OccCompSolid",
    "OccCompound",
]) {
    registerMergeRule(name, {
        strategy: "blob",
        note: "A kernel shape: its BREP is opaque geometry.",
    });
}
