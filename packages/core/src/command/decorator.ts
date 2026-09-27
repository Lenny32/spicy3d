// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandData } from "./commandData";
import { type CommandConstructor, CommandStore } from "./commandStore";

export function command<T extends CommandConstructor>(metadata: CommandData) {
    return (ctor: T) => {
        CommandStore.registerCommand(ctor, metadata);
    };
}
