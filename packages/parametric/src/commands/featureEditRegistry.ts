// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, type ICancelableCommand, isCancelableCommand } from "@spicy3d/core";
import type { ParametricBodyNode } from "../parametricBodyNode";

/**
 * Which feature kinds can be reopened in an interactive editing session, and how. Each
 * editing command registers itself by feature type when its module loads; the body node
 * only asks this registry, so it never imports the (interaction-heavy) command modules and
 * no import cycle forms between them.
 */

export type FeatureEditorFactory = (body: ParametricBodyNode, featureId: string) => ICancelableCommand;

const editors = new Map<string, FeatureEditorFactory>();

export function registerFeatureEditor(type: string, factory: FeatureEditorFactory): void {
    editors.set(type, factory);
}

export function hasFeatureEditor(type: string): boolean {
    return editors.has(type);
}

/** Starts the editing session of `featureId` on `body`; unknown features and kinds do nothing. */
export async function startFeatureEdit(body: ParametricBodyNode, featureId: string): Promise<void> {
    const feature = body.features.find((x) => x.id === featureId);
    const factory = feature === undefined ? undefined : editors.get(feature.type);
    if (factory === undefined) return;
    await startSessionCommand(body.document.application, () => factory(body, featureId));
}

/**
 * Runs a session command that needs constructor arguments (its body, its feature), so it
 * cannot come from the CommandStore's parameterless path: it is published as the
 * application's executing command instead. That registration is what makes CommandService
 * cancel it (awaiting its cleanup) when the user starts any other command mid-session.
 * Mirrors CommandService's guard: a running cancelable command is cancelled first, a
 * non-cancelable one refuses the start. `executingCommand` is cleared only when it still
 * holds this command — one started via CommandService in the meantime owns the slot.
 */
export async function startSessionCommand(
    app: IApplication,
    create: () => ICancelableCommand,
): Promise<void> {
    const running = app.executingCommand;
    if (running !== undefined) {
        if (!isCancelableCommand(running)) return;
        await running.cancel();
    }
    const command = create();
    app.executingCommand = command;
    try {
        await command.execute(app);
    } finally {
        if (app.executingCommand === command) app.executingCommand = undefined;
    }
}
