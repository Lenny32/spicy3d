import { module1_function1 } from "module1";

const { CommandStore, PubSub } = Spicy3DCore;

class HelloWorldJSCommand {
    async execute(app) {
        PubSub.default.pub("showToast", "demo.hello.message");
        module1_function1();

        const module2 = await import("./module2.js");
        module2.module2_function1();

        return Promise.resolve();
    }
}

CommandStore.registerCommand(HelloWorldJSCommand, {
    key: "jsdemo.hello",
    icon: {
        type: "path",
        value: "icons/hello.svg",
    },
});

const DemoPlugin = {
    commands: [HelloWorldJSCommand],
    ribbons: [
        {
            tabName: "ribbon.tab.utilities",
            groups: [
                {
                    groupName: "ribbon.group.other",
                    items: ["jsdemo.hello"],
                },
            ],
        },
    ],
    i18nResources: [
        {
            language: "en",
            display: "English",
            translation: {
                "command.jsdemo.hello": "JS Plugin",
                "demo.hello.message": "Hello, This is a demo plugin!",
            },
        },
    ],
};

export default DemoPlugin;
