// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export * from "./autoConstraints";
export * from "./editor/sketchEditor";
export * from "./externalRef";
export * from "./mergeReveal";
export * from "./planegcs";
export * from "./ribbon";
export * from "./sketchIds";
export * from "./sketchModel";
export * from "./sketchNode";
export * from "./solver";
import "./commands";

import { MergePathRevealers, PubSub } from "@spicy3d/core";
import { SketchEditor } from "./editor/sketchEditor";
import { sketchMergeRevealer } from "./mergeReveal";
import { SketchNode } from "./sketchNode";

// A conflict about a sketch entity, selected in the conflict panel, selects that entity.
MergePathRevealers.register(sketchMergeRevealer);

// Double-clicking a sketch node in the project tree enters its editing session.
PubSub.default.sub("nodeDoubleClicked", (node) => {
    if (node instanceof SketchNode && SketchEditor.getActive()?.node !== node) {
        void SketchEditor.enterAsync(node).catch((error) =>
            PubSub.default.pub("displayError", String(error)),
        );
    }
});

export * from "./sketchText";
export * from "./textGeometry";

import "./commands/sketchTextEdit";
