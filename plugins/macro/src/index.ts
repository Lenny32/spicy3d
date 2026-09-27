// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys, Plugin, RibbonGroupKeys, RibbonTabKeys } from "@spicy3d/core";
import { MacroCommand } from "./commands/macro";

const MacroPlugin: Plugin = {
    commands: [MacroCommand],
    ribbons: [
        {
            tabName: "ribbon.tab.plugin" as RibbonTabKeys,
            groups: [
                {
                    groupName: "ribbon.group.plugin" as RibbonGroupKeys,
                    items: ["macro.open" as CommandKeys],
                },
            ],
        },
    ],
    i18nResources: [
        {
            language: "en",
            display: "English",
            translation: {
                "command.macro.open": "Macro",
                "macro.description": "Open macro manager",
                "macro.manager.title": "Macro Manager",
                "macro.manager.new": "New",
                "macro.manager.edit": "Edit",
                "macro.manager.run": "Run",
                "macro.manager.delete": "Delete",
                "macro.manager.empty": "No macros yet. Click New to create one.",
                "macro.manager.executed": "Macro executed successfully",
                "macro.manager.error": "Macro execution error: ",
                "macro.editor.titleNew": "New Macro",
                "macro.editor.titleEdit": "Edit Macro",
                "macro.editor.name": "Name:",
                "macro.editor.namePlaceholder": "Enter macro name",
                "macro.editor.code": "Code:",
                "macro.editor.codePlaceholder": "Enter your macro code here...",
                "macro.editor.run": "Run",
                "macro.editor.nameRequired": "Macro name is required",
                "macro.editor.emptyCode": "Macro code is empty",
                "macro.editor.executed": "Macro executed successfully",
                "macro.editor.error": "Execution error: ",
            },
        } as any,
    ],
};

export default MacroPlugin;
