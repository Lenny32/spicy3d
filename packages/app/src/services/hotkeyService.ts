// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    Config,
    type IApplication,
    type IDisposable,
    type IService,
    Logger,
    PubSub,
    type ShortcutContext,
    type ShortcutMap,
    ShortcutProfiles,
} from "@spicy3d/core";

export interface Keys {
    key: string;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
}

export interface HotkeyMap {
    [key: string]: CommandKeys;
}

const MODIFIER_ORDER = ["alt", "ctrl", "shift"];

/**
 * Canonical form of a shortcut spec: lowercase, with leading modifiers sorted alt, ctrl, shift
 * so "ctrl+shift+z" and "shift+ctrl+z" name the same binding.
 */
export function normalizeShortcut(spec: string): string {
    const segments = spec.toLowerCase().split("+");
    const modifiers: string[] = [];
    while (segments.length > 1 && MODIFIER_ORDER.includes(segments[0])) {
        modifiers.push(segments.shift()!);
    }
    modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    return [...modifiers, ...segments].join("+");
}

export class HotkeyService implements IService {
    protected keys: string[] = [];
    private app?: IApplication;
    private readonly _keyMap = new Map<string, CommandKeys>();
    private readonly _contextMaps = new Map<ShortcutContext, Map<string, CommandKeys>>();
    private readonly _contexts: ShortcutContext[] = [];

    constructor() {
        this.loadProfile();
    }

    private loadProfile() {
        const profile = Config.instance.navigation3D;
        const { global, ...contexts } = ShortcutProfiles[profile];

        this._keyMap.clear();
        this.fillMap(this._keyMap, global);
        this._contextMaps.clear();
        for (const [context, shortcuts] of Object.entries(contexts)) {
            const map = new Map<string, CommandKeys>();
            this.fillMap(map, shortcuts);
            this._contextMaps.set(context as ShortcutContext, map);
        }
        Logger.info(`Loaded shortcuts profile: ${profile}`);
    }

    private fillMap(map: Map<string, CommandKeys>, shortcuts: ShortcutMap) {
        for (const [command, keyOrKeys] of Object.entries(shortcuts)) {
            const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            for (const key of keys) {
                if (typeof key === "string") map.set(normalizeShortcut(key), command as CommandKeys);
            }
        }
    }

    /**
     * Activates a context layer whose bindings win over the global map until the returned
     * handle is disposed. Layers stack; the most recent one is consulted first.
     */
    pushContext(context: ShortcutContext): IDisposable {
        this._contexts.push(context);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.removeContext(context);
            },
        };
    }

    private removeContext(context: ShortcutContext) {
        const index = this._contexts.lastIndexOf(context);
        if (index >= 0) this._contexts.splice(index, 1);
    }

    get activeContext(): ShortcutContext | undefined {
        return this._contexts.at(-1);
    }

    register(app: IApplication): void {
        this.app = app;
        Logger.info(`${HotkeyService.name} registed`);
    }

    start(): void {
        PubSub.default.sub("executeCommand", this.executeCommand);
        PubSub.default.sub("pushShortcutContext", this.onPushContext);
        PubSub.default.sub("popShortcutContext", this.onPopContext);
        window.addEventListener("keydown", this.eventHandlerKeyDown);
        window.addEventListener("keydown", this.commandKeyDown);
        Config.instance.onPropertyChanged(this.handleConfigChanged);
        Logger.info(`${HotkeyService.name} started`);
    }

    stop(): void {
        PubSub.default.remove("executeCommand", this.executeCommand);
        PubSub.default.remove("pushShortcutContext", this.onPushContext);
        PubSub.default.remove("popShortcutContext", this.onPopContext);
        window.removeEventListener("keydown", this.eventHandlerKeyDown);
        window.removeEventListener("keydown", this.commandKeyDown);
        Config.instance.removePropertyChanged(this.handleConfigChanged);
        Logger.info(`${HotkeyService.name} stoped`);
    }

    private readonly executeCommand = (_commandName: CommandKeys) => {
        this.keys = [];
    };

    private readonly onPushContext = (context: ShortcutContext) => {
        this._contexts.push(context);
    };

    private readonly onPopContext = (context: ShortcutContext) => {
        this.removeContext(context);
    };

    private readonly handleConfigChanged = (prop: keyof Config) => {
        if (prop === "navigation3D") {
            this.loadProfile();
        }
    };

    protected canHandleKey(e: KeyboardEvent): boolean {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
            return false;
        }
        return true;
    }

    private readonly eventHandlerKeyDown = (e: KeyboardEvent) => {
        if (!this.canHandleKey(e)) return;

        const visual = this.app?.activeView?.document?.visual;
        const view = this.app?.activeView;
        if (view && visual) {
            if (visual.eventHandler.isEnabled) visual.eventHandler.keyDown(view, e);
            if (visual.viewHandler.isEnabled) visual.viewHandler.keyDown(view, e);
        }
    };

    private readonly commandKeyDown = (e: KeyboardEvent) => {
        if (!this.canHandleKey(e)) return;

        const keys: Keys = {
            key: e.key.toLowerCase(),
            ctrlKey: e.ctrlKey || e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
        };

        const command = this.getCommand(keys);
        if (command !== undefined) {
            e.preventDefault();
            e.stopImmediatePropagation();
            PubSub.default.pub("executeCommand", command);
        }
    };

    getCommand(keys: Keys): CommandKeys | undefined {
        const maxKeyLength = 20;
        const totleLength = this.keys.length + keys.key.length;
        if (totleLength > maxKeyLength) {
            this.keys = this.keys.slice(totleLength - maxKeyLength);
        }
        this.keys.push(keys.key);

        const modifiers: string[] = [];
        if (keys.altKey) modifiers.push("alt");
        if (keys.ctrlKey) modifiers.push("ctrl");
        if (keys.shiftKey) modifiers.push("shift");

        const contextMap = this.activeContext && this._contextMaps.get(this.activeContext);
        const maps = contextMap ? [contextMap, this._keyMap] : [this._keyMap];
        for (let i = 0; i < this.keys.length; i++) {
            const key = [...modifiers, ...this.keys.slice(i)].join("+");
            for (const map of maps) {
                const command = map.get(key);
                if (command !== undefined) return command;
            }
        }
        return undefined;
    }

    addMap(map: HotkeyMap) {
        const keys = Object.keys(map);
        keys.forEach((key) => {
            this._keyMap.set(normalizeShortcut(key), map[key]);
        });
    }
}
