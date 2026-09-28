// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, CancelableCommand, command } from "@spicy3d/core";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { startSessionCommand } from "./featureEditRegistry";

/**
 * Runs a feature-row reselect pick (see `ParametricBodyNode.reselectSession`) as a
 * proper command. The session needs its target body and feature, so it is not
 * constructed through the CommandStore's parameterless path — `start` publishes it
 * as the application's executing command instead. That registration is what makes
 * CommandService cancel the pick (awaiting its cleanup — the rollback preview and
 * the disabled history are always restored before the new command runs) when the
 * user starts any other command mid-pick, instead of stomping the viewport event
 * handler and writing model changes into the pick's disabled history.
 */
@command({ key: "feature.reselect", icon: "icon-sync-alt" })
export class ReselectFeatureCommand extends CancelableCommand {
    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }

    protected override async executeAsync(): Promise<void> {
        // A parameterless construction (e.g. a stray `executeCommand` publish) has
        // nothing to re-pick — the store registration exists so the command
        // context panel can resolve this command's icon and title.
        if (this.body === undefined || this.featureId === undefined) return;
        this.controller = new AsyncController();
        await this.body.reselectSession(this.featureId, this.controller);
    }

    /** Launches the session outside the CommandStore (see `startSessionCommand`). */
    static async start(body: ParametricBodyNode, featureId: string): Promise<void> {
        await startSessionCommand(
            body.document.application,
            () => new ReselectFeatureCommand(body, featureId),
        );
    }
}
