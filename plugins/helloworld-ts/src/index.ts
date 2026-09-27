// Demo Plugin for Spicy3D
// This plugin demonstrates the plugin system capabilities

import type { CommandKeys, Plugin } from "@spicy3d/core";

import { HelloWorldCommand } from "./commands/hello";

const DemoPlugin: Plugin = {
    commands: [HelloWorldCommand],
    ribbons: [
        {
            tabName: "ribbon.tab.utilities",
            groups: [
                {
                    groupName: "ribbon.group.other",
                    items: ["demo.hello" as CommandKeys],
                },
            ],
        },
    ],
    // Appended to the manual the AI assistant reads, so it can tell the user what this
    // button does instead of guessing from the name.
    guide: [
        {
            name: "TS Plugin",
            content:
                "The “TS Plugin” button in the Manager tab shows a hello message. It is a demo plugin, not a modeling command.",
        },
    ],
    i18nResources: [
        {
            language: "en",
            display: "English",
            translation: {
                "command.demo.hello": "TS Plugin",
                "demo.hello.message": "Hello, This is a demo plugin!",
            },
        } as any,
    ],
};

export default DemoPlugin;
