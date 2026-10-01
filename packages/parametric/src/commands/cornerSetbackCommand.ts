// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, CancelableCommand, command, I18n, Id, PubSub, ShapeTypes } from "@spicy3d/core";
import type { FilletFeatureData } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { showCornerSetbackEditor } from "./cornerSetbackEditor";
import { captureBodyEdgeRef } from "./reselectSession";

@command({ key: "feature.cornerSetback", icon: "icon-fillet" })
export class CornerSetbackCommand extends CancelableCommand {
    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }
    protected override isPropertyCached(): boolean {
        return false;
    }
    protected override async executeAsync(): Promise<void> {
        let body = this.body;
        let feature: FilletFeatureData | undefined;
        if (body && this.featureId) {
            const found = body.features.find((item) => item.id === this.featureId);
            if (found?.type === "fillet") feature = found;
        } else {
            const picked = this.document.selection.getSelectedShapes();
            const owner = picked[0]?.owner.node;
            if (
                owner instanceof ParametricBodyNode &&
                picked.length === 3 &&
                picked.every((edge) => edge.owner.node === owner && edge.shape.shapeType === ShapeTypes.edge)
            ) {
                body = owner;
                feature = {
                    id: Id.generate(),
                    type: "fillet",
                    radius: 2,
                    edges: picked.map((edge) => captureBodyEdgeRef(owner, edge)),
                };
            }
        }
        if (!body || !feature || feature.edges.length !== 3 || feature.radiusLaw !== undefined) {
            PubSub.default.pub("showFloatTip", { level: "warn", msg: I18n.translate("fillet.cornerPick") });
            return;
        }
        this.controller = new AsyncController();
        const cancellation = new AbortController();
        this.controller.onCancelled(() => cancellation.abort());
        await showCornerSetbackEditor(body, feature, cancellation.signal);
    }
}
