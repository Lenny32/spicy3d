// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Binding, Config, command, type IApplication, type ICommand } from "@spicy3d/core";

@command({
    key: "workingPlane.toggleDynamic",
    toggle: new Binding(Config.instance, "dynamicWorkplane"),
    icon: "icon-dynamicPlane",
})
export class ToggleDynamicWorkplaneCommand implements ICommand {
    async execute(_app: IApplication): Promise<void> {
        Config.instance.dynamicWorkplane = !Config.instance.dynamicWorkplane;
    }
}
