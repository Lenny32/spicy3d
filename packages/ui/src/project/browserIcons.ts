// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { BrowserEntry, BrowserModel } from "@spicy3d/core";

const TYPE_ICONS: Readonly<Record<string, string>> = {
    document: "icon-browser-document",
    settings: "icon-browser-settings",
    units: "icon-browser-units",
    views: "icon-browser-views",
    origin: "icon-browser-origin",
    ucs: "icon-browser-origin",
    solid: "icon-browser-solid",
    surface: "icon-browser-surface",
    mesh: "icon-browser-mesh",
    sketch: "icon-browser-sketch",
    instance: "icon-browser-component",
};
const ORIGIN_ICONS = [
    "icon-browser-point",
    "icon-browser-axis-x",
    "icon-browser-axis-y",
    "icon-browser-axis-z",
    "icon-browser-plane-xy",
    "icon-browser-plane-xz",
    "icon-browser-plane-yz",
];
const VIEW_ICONS = {
    front: "icon-browser-view-front",
    top: "icon-browser-view-top",
    right: "icon-browser-view-right",
    home: "icon-browser-view-home",
};

/** CAD artwork belongs to this tree; providers with other types retain their supplied icon. */
export function browserIcon(entry: BrowserEntry, model: BrowserModel, expanded: boolean): string {
    if (entry.originMember !== undefined) return ORIGIN_ICONS[entry.originMember] ?? entry.icon;
    if (entry.type === "component") {
        const assembly = entry.children.some((key) => {
            const type = model.entries.get(key)?.type;
            return type === "component" || type === "instance";
        });
        return assembly ? "icon-browser-assembly" : "icon-browser-component";
    }
    if (entry.type === "category") return expanded ? "icon-browser-folder-open" : "icon-browser-folder";
    if (entry.type === "view") return entry.preset ? VIEW_ICONS[entry.preset] : "icon-browser-camera";
    if (entry.description?.category === "construction") {
        if (entry.type.startsWith("plane-")) return "icon-browser-plane";
        if (entry.type.startsWith("axis-")) return "icon-browser-axis";
        if (entry.type.startsWith("point-")) return "icon-browser-point";
    }
    return Object.hasOwn(TYPE_ICONS, entry.type) ? TYPE_ICONS[entry.type] : entry.icon;
}
