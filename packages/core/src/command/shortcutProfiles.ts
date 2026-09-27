// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "../config";
import type { Navigation3DType } from "../navigation";
import type { CommandKeys } from "./commandKeys";

export type ShortcutMap = Partial<Record<CommandKeys, string | string[]>>;

/** Shortcut layers of a context: `sketch` is active while a sketch is being edited. */
export type ShortcutContext = "sketch";

/** A profile's global map plus optional context maps that take priority while their context is active. */
export type ShortcutProfile = { global: ShortcutMap } & Partial<Record<ShortcutContext, ShortcutMap>>;

const MODIFIER_KEYS = new Set(["ctrl", "shift", "alt"]);

/** Keys whose name is spelled out on screen rather than uppercased. */
const NAMED_KEYS = new Map([
    ["delete", "Delete"],
    ["backspace", "Backspace"],
    ["enter", "Enter"],
    ["escape", "Escape"],
    ["tab", "Tab"],
    ["space", "Space"],
]);

function displayKey(key: string): string {
    if (key === " ") return "Space";
    const named = NAMED_KEYS.get(key.toLowerCase());
    if (named !== undefined) return named;
    return key.length > 1 ? key : key.toUpperCase();
}

/**
 * Display form of one shortcut spec. A spec is leading modifiers plus a sequence of keys —
 * "ctrl+s" is Ctrl with S, while "m+v" is M then V (Revit's move), and modifiers apply to the
 * last key of a sequence.
 */
export function formatShortcutKey(key: string): string {
    const segments = key.split("+");
    const modifiers: string[] = [];
    while (segments.length > 1 && MODIFIER_KEYS.has(segments[0].toLowerCase())) {
        const modifier = segments.shift() ?? "";
        modifiers.push(modifier[0].toUpperCase() + modifier.slice(1));
    }

    const keys = segments.map(displayKey);
    const last = keys.pop() ?? "";
    keys.push([...modifiers, last].join("+"));
    return keys.join(" then ");
}

export const Spicy3DShortcuts: ShortcutMap = {
    // System
    "doc.save": "ctrl+s",
    "doc.open": "ctrl+o",
    "edit.undo": "ctrl+z",
    "edit.redo": ["ctrl+y", "ctrl+shift+z"],
    "modify.deleteNode": ["Delete", "Backspace"],
    "special.last": [" ", "Enter"],

    // Sketching
    "create.line": "l",
    "create.rect": "r",
    "create.circle": "c",
    "measure.length": "d",

    // Primitives
    "create.box": "b",
    "create.sphere": "s",
    "create.cylinder": "y",
    "create.cone": "n",
    "create.pipe": "shift+p",

    // Modify
    "modify.trim": "t",
    "create.offset": "o",
    "modify.rotate": "shift+r",
    "create.extrude": "p",
    "modify.move": "m",
    "modify.array": "shift+a",
    "boolean.common": "shift+i",
    "modify.explode": "x",
    "modify.chamfer": "shift+c",
    "modify.fillet": "shift+f",
};

export const DefaultShortcuts: ShortcutMap = Spicy3DShortcuts;

export const RevitShortcuts: ShortcutMap = {
    ...Spicy3DShortcuts,
    "modify.move": "m+v", // MV
    "modify.rotate": "r+o", // RO
    "modify.trim": "t+r", // TR
    "create.line": "l+i", // LI
    // Add more as needed
};

export const BlenderShortcuts: ShortcutMap = {
    ...DefaultShortcuts,
    "modify.move": "g",
    "modify.rotate": "r",
    "create.extrude": "e",
    // "delete": "x" // if key exists
};

export const SolidworksShortcuts: ShortcutMap = {
    ...DefaultShortcuts,
    "create.line": "l",
    // Often heavily mouse/gesture based or S-key menu
};

export const CreoShortcuts: ShortcutMap = {
    ...DefaultShortcuts,
};

export const Fusion360Shortcuts: ShortcutMap = {
    "doc.save": "ctrl+s",
    "doc.open": "ctrl+o",
    "edit.undo": "ctrl+z",
    "edit.redo": ["ctrl+y", "ctrl+shift+z"],
    "modify.deleteNode": ["Delete", "Backspace"],
    "special.last": [" ", "Enter"],
    "edit.commandSearch": "s",
    "feature.extrude": ["e", "q"], // Q is Fusion's press pull; the same command covers it
    "feature.fillet": "f",
    "modify.move": "m",
    "measure.length": ["i", "d"],
    "create.offset": "o",
    "modify.trim": "t",
    "modify.paintBucket": "a",
    "create.line": "l",
    "create.rect": "r",
    "create.circle": "c",
};

export const Fusion360SketchShortcuts: ShortcutMap = {
    "sketch.line": "l",
    "sketch.rectangle": "r",
    "sketch.circle": "c",
    "dimension.distance": "d",
    "sketch.projectEdges": "p",
    "sketch.toggleExternal": "x",
};

export const ShortcutProfiles: Record<Navigation3DType, ShortcutProfile> = {
    Spicy3D: { global: Spicy3DShortcuts },
    Revit: { global: RevitShortcuts },
    Blender: { global: BlenderShortcuts },
    Creo: { global: CreoShortcuts },
    Solidworks: { global: SolidworksShortcuts },
    Fusion360: { global: Fusion360Shortcuts, sketch: Fusion360SketchShortcuts },
};

/** Every map of a profile, context maps first so a context binding wins on lookup. */
export function shortcutMaps(profile: ShortcutProfile): ShortcutMap[] {
    const { global, ...contexts } = profile;
    return [...Object.values(contexts), global];
}

/**
 * Raw shortcut specs of a command in the given profile (the active one by default), merging
 * the global and context maps — a command is bound in at most one of them.
 */
export function getShortcutKeys(
    command: CommandKeys,
    profile: Navigation3DType = Config.instance.navigation3D,
): string[] {
    const entry = ShortcutProfiles[profile];
    if (entry === undefined) return [];
    for (const map of shortcutMaps(entry)) {
        const keys = map[command];
        if (keys !== undefined) return Array.isArray(keys) ? keys : [keys];
    }
    return [];
}

/** Display form of a command's shortcuts ("Ctrl+Y / Ctrl+Shift+Z"), empty when it has none. */
export function getShortcutText(
    command: CommandKeys,
    profile: Navigation3DType = Config.instance.navigation3D,
): string {
    return getShortcutKeys(command, profile).map(formatShortcutKey).join(" / ");
}
