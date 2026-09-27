// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createMockApplication } from "@spicy3d/core/test-utils";
import {
    type IPluginManager,
    type Locale,
    PLUGIN_FILE_EXTENSION,
    type Plugin,
    type PluginAuthor,
    type PluginManifest,
} from "../src";
import * as pluginModule from "../src/plugin";

describe("plugin module", () => {
    test("should be a type-only module with no runtime exports", () => {
        // manifest.ts / manager.ts / plugin.ts declare only types and interfaces,
        // which are erased at compile time. Nothing may leak into the runtime
        // module namespace — core keeps the plugin contract abstract.
        expect(Object.keys(pluginModule)).toEqual([]);
    });
});

describe("PLUGIN_FILE_EXTENSION", () => {
    test("should define the plugin archive extension", () => {
        expect(PLUGIN_FILE_EXTENSION).toBe(".spicyplugin");
    });
});

describe("PluginManifest", () => {
    test("should allow a minimal manifest with only required fields", () => {
        const manifest = {
            name: "demo",
            version: "1.0.0",
            main: "index.js",
        } satisfies PluginManifest;

        expect(Object.keys(manifest)).toEqual(["name", "version", "main"]);
    });

    test("should allow author as a string or as an object", () => {
        const stringAuthor = "Jane Doe" satisfies PluginAuthor;
        const objectAuthor = {
            name: "Jane Doe",
            email: "jane@example.com",
            url: "https://example.com",
        } satisfies PluginAuthor;

        const fromString = { name: "a", version: "1.0.0", main: "a.js", author: stringAuthor };
        const fromObject = { name: "b", version: "1.0.0", main: "b.js", author: objectAuthor };

        expect(fromString.author).toBe("Jane Doe");
        expect((fromObject.author as { name: string }).name).toBe("Jane Doe");
    });

    test("should allow css as a single path or a list of paths", () => {
        const single = {
            name: "a",
            version: "1.0.0",
            main: "a.js",
            css: "style.css",
        } satisfies PluginManifest;
        const multiple = {
            name: "b",
            version: "1.0.0",
            main: "b.js",
            css: ["a.css", "b.css"],
        } satisfies PluginManifest;

        expect(single.css).toBe("style.css");
        expect(multiple.css).toEqual(["a.css", "b.css"]);
    });

    test("should round-trip a full manifest through JSON without losing fields", () => {
        // Manifests are delivered as JSON (manifest.json in a zip or over HTTP),
        // so every declared field must survive a JSON round-trip unchanged.
        const manifest = {
            name: "full-plugin",
            version: "2.1.0-beta",
            main: "dist/index.js",
            author: { name: "Jane Doe", url: "https://example.com" },
            description: "A plugin with every field set",
            icon: "assets/icon.svg",
            engines: { spicy3d: ">=0.6.0" },
            dependencies: { "other-plugin": ">=1.0.0" },
            css: ["base.css", "theme.css"],
            importmap: "importmap.json",
        } satisfies PluginManifest;

        expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    });
});

describe("Plugin", () => {
    test("should carry the documented contribution points", () => {
        const service = { register: () => {}, start: () => {}, stop: () => {} };
        const plugin: Plugin = {
            commands: [],
            ribbons: [],
            i18nResources: [
                {
                    display: "English",
                    language: "en",
                    translation: { "key.hello": "Hello" } as unknown as Locale["translation"],
                },
            ],
            services: [service],
        };

        expect(plugin.i18nResources?.[0].language).toBe("en");
        expect(plugin.services).toHaveLength(1);
    });
});

describe("IPluginManager contract", () => {
    /**
     * Minimal in-memory implementation used to exercise the interface exactly as
     * `core/src/application.ts` consumes it (`IApplication.pluginManager`). The
     * concrete loader lives in @spicy3d/app (PluginManager); here we only pin
     * down the state-management semantics the interface promises.
     */
    class MemoryPluginManager implements IPluginManager {
        private readonly plugins = new Map<string, Plugin>();

        async loadFromFile(_pluginFile: File): Promise<void> {}
        async loadFromUrl(_pluginUrl: string): Promise<void> {}

        register(name: string, plugin: Plugin): void {
            this.plugins.set(name, plugin);
        }

        async unload(pluginName: string): Promise<void> {
            this.plugins.delete(pluginName);
        }

        unloadAll(): void {
            this.plugins.clear();
        }

        getPlugins(): Plugin[] {
            return Array.from(this.plugins.values());
        }

        get(pluginName: string): Plugin | undefined {
            return this.plugins.get(pluginName);
        }

        isLoaded(pluginName: string): boolean {
            return this.plugins.has(pluginName);
        }
    }

    function createManager(): { manager: IPluginManager; memory: MemoryPluginManager } {
        const memory = new MemoryPluginManager();
        return { manager: memory, memory };
    }

    test("should report an empty state before any plugin is loaded", () => {
        const { manager } = createManager();

        expect(manager.getPlugins()).toEqual([]);
        expect(manager.get("demo")).toBeUndefined();
        expect(manager.isLoaded("demo")).toBe(false);
    });

    test("should expose a registered plugin via get / getPlugins / isLoaded", () => {
        const { manager, memory } = createManager();
        const plugin: Plugin = {};
        memory.register("demo", plugin);

        expect(manager.isLoaded("demo")).toBe(true);
        expect(manager.get("demo")).toBe(plugin);
        expect(manager.getPlugins()).toEqual([plugin]);
    });

    test("unload should remove only the named plugin", async () => {
        const { manager, memory } = createManager();
        memory.register("a", {});
        memory.register("b", {});

        await manager.unload("a");

        expect(manager.isLoaded("a")).toBe(false);
        expect(manager.isLoaded("b")).toBe(true);
    });

    test("unloadAll should remove every loaded plugin", () => {
        const { manager, memory } = createManager();
        memory.register("a", {});
        memory.register("b", {});

        manager.unloadAll();

        expect(manager.getPlugins()).toEqual([]);
    });
});

describe("mock application plugin manager", () => {
    test("createMockApplication should default to an empty plugin manager", async () => {
        const app = createMockApplication();

        expect(app.pluginManager.getPlugins()).toEqual([]);
        expect(app.pluginManager.get("demo")).toBeUndefined();
        expect(app.pluginManager.isLoaded("demo")).toBe(false);
        await expect(app.pluginManager.unload("demo")).resolves.toBeUndefined();
    });

    test("createMockApplication should accept pluginManager overrides", () => {
        const plugin: Plugin = {};
        const app = createMockApplication({
            pluginManager: {
                getPlugins: () => [plugin],
                isLoaded: (name: string) => name === "demo",
            },
        });

        expect(app.pluginManager.getPlugins()).toEqual([plugin]);
        expect(app.pluginManager.isLoaded("demo")).toBe(true);
        expect(app.pluginManager.isLoaded("other")).toBe(false);
    });
});
