// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AppGuideStore,
    CommandStore,
    Config,
    type DialogButton,
    ExternalContentPolicy,
    I18n,
    type I18nKeys,
    type IApplication,
    type IconPath,
    type IPluginManager,
    Logger,
    type Plugin,
    type PluginManifest,
    PubSub,
    redactUrl,
} from "@spicy3d/core";
import { div, hr, p, toBase64Img } from "@spicy3d/element";
import type JSZip from "jszip";
import { linkPluginModules, type PluginModuleSource } from "./pluginModules";

/** Origins the user refused in this page. */
const untrustedOrigins = new Set<string>();
/** Origins the user trusted in this page (signed in, that trust is not saved). */
const trustedThisPage = new Set<string>();

function warning(kind: string, text: I18nKeys): HTMLElement {
    const element = p({ textContent: I18n.translate(text) });
    element.dataset["warning"] = kind;
    return element;
}

export class PluginManager implements IPluginManager {
    readonly plugins = new Map<string, Plugin>();
    readonly manifests = new Map<string, PluginManifest>();
    readonly shouldRevokes = new Map<string, string[]>();

    constructor(readonly app: IApplication) {}

    async loadFromFile(file: File) {
        const JSZip = await import("jszip");
        const zip = await JSZip.default.loadAsync(file);

        const manifest = await this.readManifestFromZip(zip);
        if (manifest) {
            await this.loadPluginFromZip(zip, manifest);
        }
    }

    private async loadFromRemoteFile(url: string) {
        if (url.endsWith(".spicyplugin")) {
            const response = await fetch(url);
            if (!response.ok) {
                alert(`Failed to fetch plugin from ${url}: ${response.statusText}`);
                return;
            }

            const arrayBuffer = await response.arrayBuffer();
            const blob = new Blob([arrayBuffer], { type: "application/zip" });
            const file = new File([blob], "plugin.spicyplugin");

            await this.loadFromFile(file);
        } else {
            if (!url.endsWith("/")) url += "/";
            const manifest = await this.readManifestFromUrl(`${url}manifest.json`);
            if (manifest) {
                await this.loadPluginFromUrl(manifest.name, url, manifest.main, manifest.importmap);
            }
        }
    }

    /**
     * Loads the plugin at `urlString` (a folder with a `manifest.json`, or a `.spicyplugin`). The
     * app's own origin and the deployment's allowlist load at once (`ExternalContentPolicy`);
     * anything else asks first, naming the origin — while a cloud session may exist every time the
     * page loads, since the plugin would run with that session; signed out, a trusted origin is
     * remembered (`Config.trustedDomains`).
     */
    async loadFromUrl(urlString: string) {
        const decision = ExternalContentPolicy.evaluate(urlString, "plugin", {
            trusted: Config.instance.trustedDomains,
        });
        if (decision.verdict === "refused") {
            Logger.warn(`[plugin] not loading ${redactUrl(urlString)}: ${decision.reason}`);
            PubSub.default.pub("showToast", "warning.plugin.refused{0}", decision.reason);
            return;
        }
        const { url } = decision;
        if (decision.verdict === "allowed" || trustedThisPage.has(url.origin)) {
            await this.loadFromRemoteFile(url.href);
            return;
        }
        if (untrustedOrigins.has(url.origin)) return;

        const signedIn = ExternalContentPolicy.hasSession;
        PubSub.default.pub(
            "showDialog",
            "common.warning",
            div(
                I18n.translate("warning.script.fromDomain"),
                hr(),
                div({ textContent: url.origin }),
                warning("origin", "warning.plugin.origin"),
                ...(signedIn ? [warning("signedIn", "warning.plugin.signedIn")] : []),
                ...(url.protocol === "http:" ? [warning("plainHttp", "warning.plugin.untrusted")] : []),
            ),
            this.buttons(url),
        );
    }

    private buttons(url: URL): DialogButton[] {
        return [
            {
                content: "common.dontTrust",
                onclick: () => {
                    untrustedOrigins.add(url.origin);
                },
            },
            {
                content: "common.trust",
                onclick: () => {
                    trustedThisPage.add(url.origin);
                    // Signed in, the trust lasts for this page only: the next load asks again.
                    if (
                        !ExternalContentPolicy.hasSession &&
                        !Config.instance.trustedDomains.includes(url.origin)
                    ) {
                        Config.instance.trustedDomains.push(url.origin);
                        Config.instance.saveToStorage();
                    }

                    this.loadFromRemoteFile(url.href);
                },
            },
        ];
    }

    private async readManifestFromZip(zip: JSZip) {
        const manifestFile = zip.file("manifest.json");
        if (!manifestFile) {
            alert("manifest.json not found in plugin archive");
            return undefined;
        }

        const content = await manifestFile.async("text");
        const manifest = JSON.parse(content) as PluginManifest;
        return this.validateManifest(manifest) ? manifest : undefined;
    }

    private async readManifestFromUrl(url: string) {
        const response = await fetch(url);
        if (!response.ok) {
            return undefined;
        }
        const manifest: PluginManifest = await response.json();
        return this.validateManifest(manifest) ? manifest : undefined;
    }

    private async loadPluginFromZip(zip: JSZip, manifest: PluginManifest) {
        const codeFile = zip.file(manifest.main);
        if (!codeFile) {
            alert(`${manifest.main} not found in plugin archive`);
            return;
        }

        const code = await codeFile.async("text");
        const blobUrl = await this.linkZipModules(zip, manifest, code);
        await Promise.try(async () => {
            const handlePluginIcon = async (plugin: Plugin) => {
                await this.transformZipCommandIcon(zip, plugin);
            };
            await this.loadMainCode(manifest.name, blobUrl, handlePluginIcon);
            await this.loadCssFromZip(zip, manifest);
        }).finally(() => {
            URL.revokeObjectURL(blobUrl);
        });
    }

    private async loadPluginFromUrl(name: string, baseUrl: string, codePath: string, importmapPath?: string) {
        if (codePath.startsWith("/")) codePath = codePath.substring(1);

        const fullUrl = baseUrl + codePath;
        const response = await fetch(fullUrl);
        if (!response.ok) {
            return undefined;
        }

        const handlePluginIcon = async (plugin: Plugin) => {
            await this.transformUrlCommandIcon(baseUrl, plugin);
        };

        if (importmapPath) {
            const linked = await this.linkUrlModules(name, baseUrl, importmapPath, {
                code: await response.text(),
                url: fullUrl,
            });
            if (linked) {
                await this.loadMainCode(name, linked, handlePluginIcon).finally(() =>
                    URL.revokeObjectURL(linked),
                );
                await this.loadCssFromUrl(baseUrl, name);
                return;
            }
            await this.loadImportmapFromUrl(baseUrl, importmapPath);
        }

        await this.loadMainCode(name, fullUrl, handlePluginIcon);
        await this.loadCssFromUrl(baseUrl, name);
    }

    /**
     * A served plugin with an import map: its entry and mapped modules fetched and linked into
     * blob: URLs (`linkPluginModules`) instead of an inline import map, which a strict CSP blocks.
     * The entry then runs from a blob: URL (its `import.meta.url` is not the served file). Undefined
     * (use the inline map) for a map with `scopes`, a module that can't be fetched, or a cycle.
     */
    private async linkUrlModules(
        name: string,
        baseUrl: string,
        importmapPath: string,
        main: PluginModuleSource,
    ): Promise<string | undefined> {
        const path = importmapPath.startsWith("/") ? importmapPath.substring(1) : importmapPath;
        const importmapUrl = baseUrl + path;
        try {
            const response = await fetch(importmapUrl);
            if (!response.ok) return undefined;
            const json = await response.json();
            if (json.scopes) {
                Logger.warn(`[plugin] ${name}: its import map has scopes; using an inline import map`);
                return undefined;
            }
            const sources: Record<string, PluginModuleSource> = {};
            for (const [specifier, target] of Object.entries<string>(json.imports ?? {})) {
                const url = new URL(target, importmapUrl).href;
                const module = await fetch(url);
                if (!module.ok) return undefined;
                sources[specifier] = { code: await module.text(), url };
            }
            const linked = linkPluginModules(main, sources);
            if (!linked.isOk) {
                Logger.warn(`[plugin] ${name}: ${linked.error}; using an inline import map`);
                return undefined;
            }
            this.shouldRevokes.set(name, linked.value.imports);
            return linked.value.main;
        } catch (error) {
            Logger.warn(
                `[plugin] ${name}: could not link its modules (${error}); using an inline import map`,
            );
            return undefined;
        }
    }

    private async loadImportmapFromUrl(baseUrl: string, importmapPath: string) {
        if (importmapPath.startsWith("/")) importmapPath = importmapPath.substring(1);
        const importmapUrl = baseUrl + importmapPath;
        const response = await fetch(importmapUrl);
        if (!response.ok) {
            return undefined;
        }

        const importmapObj = await response.json();
        const importmapBaseUrl = new URL(importmapPath, baseUrl).href;
        if (importmapObj.imports) {
            PluginManager.resolveSpecifiers(importmapObj.imports, importmapBaseUrl);
        }

        if (importmapObj.scopes) {
            for (const scope in importmapObj.scopes) {
                const scopeBaseUrl = new URL(scope, importmapBaseUrl).href;
                PluginManager.resolveSpecifiers(importmapObj.scopes[scope], scopeBaseUrl);
            }
        }

        this.injectImportmap(JSON.stringify(importmapObj));
    }

    /**
     * Rewrite the relative entries of a specifier map - the importmap's imports
     * or one of its scopes - as absolute URLs against baseUrl, since the browser
     * would otherwise resolve them against the document rather than the plugin.
     */
    private static resolveSpecifiers(specifiers: Record<string, string>, baseUrl: string) {
        for (const key in specifiers) {
            const value = specifiers[key];
            if (!value.startsWith("http://") && !value.startsWith("https://")) {
                specifiers[key] = new URL(value, baseUrl).href;
            }
        }
    }

    private async loadMainCode(
        name: string,
        url: string,
        handlePluginIcon: (plugin: Plugin) => Promise<void>,
    ) {
        await Promise.try(async () => {
            const module = await import(/*webpackIgnore: true*/ url);
            const plugin: Plugin = module.default;
            await handlePluginIcon(plugin);
            this.registerPlugin(plugin);
            this.plugins.set(name, plugin);

            Logger.info(`Plugin ${name} loaded successfully`);
        }).catch((err) => {
            console.log(err);

            alert(`Failed to load plugin ${name}: ${err}`);
        });
    }

    private async transformZipCommandIcon(zip: JSZip, plugin: Plugin) {
        for (const command of plugin.commands ?? []) {
            const data = CommandStore.getComandData(command);
            const iconData = data?.icon as IconPath;
            if (iconData?.type === "path") {
                const codeFile = zip.file(iconData?.value);
                if (!codeFile) {
                    alert(`${iconData.value} not found in plugin archive`);
                    continue;
                }
                const icon = await codeFile.async("base64");
                const base64: string = toBase64Img(iconData.value, icon);
                data!.icon = { type: "url", value: base64 };
            }
        }
    }

    private async transformUrlCommandIcon(baseUrl: string, plugin: Plugin) {
        for (const command of plugin.commands ?? []) {
            const data = CommandStore.getComandData(command);
            const iconData = data?.icon as IconPath;
            if (iconData?.type === "path") {
                data!.icon = { type: "url", value: baseUrl + iconData.value };
            }
        }
    }

    async unload(pluginName: string): Promise<void> {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            return;
        }

        await this.unregisterPlugin(pluginName, plugin);
        this.plugins.delete(pluginName);

        this.shouldRevokes.get(pluginName)?.forEach((value) => {
            URL.revokeObjectURL(value);
        });

        Logger.info(`Plugin ${pluginName} unloaded successfully`);
    }

    unloadAll(): void {
        for (const [pluginName] of this.plugins) {
            this.unload(pluginName).catch((err) => {
                Logger.error(`Failed to unload plugin ${pluginName}: ${err}`);
            });
        }
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

    private validateManifest(manifest: PluginManifest) {
        if (this.manifests.has(manifest.name)) {
            alert(`Plugin ${manifest.name} already loaded`);
            return false;
        }

        const errors: string[] = [];
        if (!manifest.name) errors.push("Missing required field: name");
        if (!manifest.version) errors.push("Missing required field: version");
        if (!manifest.main) errors.push("Missing required field: main");
        if (manifest.version && !this.isValidSemver(manifest.version)) {
            errors.push("Invalid version format (expected semver like 1.0.0)");
        }
        if (manifest.engines?.spicy3d) {
            const currentVersion = __APP_VERSION__;
            if (!this.satisfiesVersion(currentVersion, manifest.engines.spicy3d)) {
                errors.push(`Spicy3D version ${currentVersion} does not satisfy ${manifest.engines.spicy3d}`);
            }
        }

        if (errors.length > 0) {
            alert(
                "Load plugin " +
                    manifest.name +
                    " failed:\n" +
                    errors.map((x, i) => `${i + 1}. ${x}`).join("\n"),
            );
            return false;
        }

        this.manifests.set(manifest.name, manifest);
        return true;
    }

    private isValidSemver(version: string): boolean {
        // Basic semver validation: major.minor.patch
        const semverRegex = /^\d+\.\d+\.\d+/;
        return semverRegex.test(version);
    }

    private satisfiesVersion(current: string, required: string): boolean {
        // Simple version check: required format like ">=0.6.0"
        const match = required.match(/^>=?(.+)$/);
        if (!match) return true; // Unknown format, allow it

        const requiredVersion = match[1].trim();
        return this.compareVersions(current.replaceAll("-beta", ""), requiredVersion) >= 0;
    }

    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split(".").map(Number);
        const parts2 = v2.split(".").map(Number);

        for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 < p2) return -1;
            if (p1 > p2) return 1;
        }
        return 0;
    }

    private registerPlugin(plugin: Plugin) {
        if (plugin.i18nResources) {
            for (const locale of plugin.i18nResources) {
                const existingLocale = I18n.getLanguages().find((l) => l.language === locale.language);
                if (existingLocale) {
                    I18n.combineTranslation(locale.language, locale.translation);
                } else {
                    I18n.addLanguage(locale);
                }
            }
        }

        if (plugin.services) {
            for (const service of plugin.services) {
                service.register(this.app);
                service.start?.();
            }
        }

        if (plugin.ribbons && this.app?.mainWindow?.ribbon) {
            for (const ribbonContribution of plugin.ribbons) {
                this.app.mainWindow.ribbon.combineRibbonTab(ribbonContribution);
            }
        }

        if (plugin.guide) {
            for (const section of plugin.guide) {
                AppGuideStore.registerSection(section);
            }
        }
    }

    private async unregisterPlugin(pluginName: string, plugin: Plugin): Promise<void> {
        if (plugin.i18nResources) {
            for (const resource of plugin.i18nResources) {
                const keys = Object.keys(resource.translation);
                const keysToRemove = keys.reduce(
                    (acc, key) => {
                        acc[key] = "";
                        return acc;
                    },
                    {} as Record<string, string>,
                );
                I18n.removeTranslation(resource.language, keysToRemove);
            }
        }

        if (plugin.services) {
            for (const service of plugin.services) {
                service.stop?.();
            }
        }

        if (plugin.commands) {
            for (const commandKey of plugin.commands) {
                CommandStore.unregisterCommand(commandKey);
            }
        }

        if (plugin.guide) {
            for (const section of plugin.guide) {
                AppGuideStore.unregisterSection(section.name);
            }
        }

        if (pluginName) {
            this.removePluginCss(pluginName);
        }
    }

    private async loadCssFromZip(zip: JSZip, manifest: PluginManifest) {
        const cssFiles = manifest.css;
        if (!cssFiles) return;

        const files = Array.isArray(cssFiles) ? cssFiles : [cssFiles];
        for (const cssFile of files) {
            const file = zip.file(cssFile);
            if (!file) {
                alert(`${cssFile} not found in plugin archive`);
                continue;
            }
            const css = await file.async("text");
            this.injectCss(css, manifest.name);
        }
    }

    private async loadCssFromUrl(baseUrl: string, pluginName: string) {
        const manifest = this.manifests.get(pluginName);
        if (!manifest?.css) return;

        const files = Array.isArray(manifest.css) ? manifest.css : [manifest.css];
        for (const cssFile of files) {
            const fullUrl = baseUrl + cssFile;
            const response = await fetch(fullUrl);
            if (!response.ok) {
                alert(`Failed to load CSS from ${fullUrl}: ${response.statusText}`);
                continue;
            }
            const css = await response.text();
            this.injectCss(css, pluginName);
        }
    }

    /**
     * The blob: URL of an archive's entry module, its import map applied by `linkPluginModules`
     * (no inline import map, which a strict CSP blocks). A map with `scopes`, or modules importing
     * each other in a cycle, fall back to an injected <script type="importmap">.
     */
    private async linkZipModules(zip: JSZip, manifest: PluginManifest, code: string): Promise<string> {
        const importmap = await this.getImportmapFromZip(zip, manifest);
        if (!importmap) return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

        let reason = "its import map has scopes";
        if (!importmap.scopes) {
            const linked = linkPluginModules({ code }, importmap.sources);
            if (linked.isOk) {
                this.shouldRevokes.set(manifest.name, linked.value.imports);
                return linked.value.main;
            }
            reason = linked.error;
        }
        Logger.warn(
            `[plugin] ${manifest.name}: ${reason}; using an inline import map, which a ` +
                "Content-Security-Policy without 'unsafe-inline' blocks",
        );
        const imports: Record<string, string> = {};
        for (const [specifier, source] of Object.entries(importmap.sources)) {
            imports[specifier] = URL.createObjectURL(new Blob([source.code], { type: "text/javascript" }));
        }
        this.injectImportmap(JSON.stringify({ ...importmap.json, imports }));
        this.shouldRevokes.set(manifest.name, Object.values(imports));
        return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    }

    private async getImportmapFromZip(
        zip: JSZip,
        manifest: PluginManifest,
    ): Promise<
        | { json: Record<string, unknown>; sources: Record<string, PluginModuleSource>; scopes: boolean }
        | undefined
    > {
        if (!manifest.importmap) return undefined;

        const codeFile = zip.file(manifest.importmap);
        if (!codeFile) {
            alert(`${manifest.main} not found in plugin archive`);
            return undefined;
        }

        const importmap = await codeFile.async("text");
        const json = JSON.parse(importmap);
        const sources: Record<string, PluginModuleSource> = {};
        for (const key in json.imports) {
            const importFile = zip.file(json.imports[key]);
            if (!importFile) {
                alert(`${json.imports[key]} not found in plugin archive`);
                continue;
            }
            sources[key] = { code: await importFile.async("text") };
        }

        return { json, sources, scopes: json.scopes !== undefined };
    }

    private injectImportmap(importmapJson: string) {
        const script = document.createElement("script");
        script.type = "importmap";
        script.textContent = importmapJson;
        document.head.appendChild(script);
    }

    private injectCss(css: string, pluginName: string) {
        const styleId = `plugin-css-${pluginName}`;
        if (document.getElementById(styleId)) return;

        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = css;
        document.head.appendChild(style);
    }

    private removePluginCss(pluginName: string) {
        const styleId = `plugin-css-${pluginName}`;
        const style = document.getElementById(styleId);
        if (style) {
            style.remove();
        }
    }
}
