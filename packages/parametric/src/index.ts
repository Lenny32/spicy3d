// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export * from "./features";
export * from "./migrations";
export * from "./parametricBodyNode";
export * from "./program";
export * from "./sketch";
import "./commands";
import "./mergeRules";

import { KernelRecoveryValidation } from "@spicy3d/core";
import { ParametricBodyNode } from "./parametricBodyNode";

KernelRecoveryValidation.register(
    (document, action) => ParametricBodyNode.withSynchronousEvaluation(document, action),
    (document) => {
        for (const node of document.modelManager.findNodes()) {
            if (node instanceof ParametricBodyNode) node.cancelForKernelRecovery();
        }
    },
    (node) => {
        if (node instanceof ParametricBodyNode) {
            const failure = node.featureItems().find((item) => item.error);
            if (failure) throw new Error(`Recovery feature rebuild failed for ${node.id}: ${failure.error}`);
        }
    },
);
