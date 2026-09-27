// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, PubSub } from "@spicy3d/core";

@command({
    key: "edit.commandSearch",
    icon: "icon-search",
    isApplicationCommand: true,
})
export class CommandSearchCommand implements ICommand {
    async execute(_application: IApplication): Promise<void> {
        PubSub.default.pub("openCommandSearch");
    }
}
