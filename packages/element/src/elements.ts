// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandIcon, Localize } from "@spicy3d/core";
import { Collection, type CollectionProps } from "./collection";
import type { HTMLProps } from "./htmlProps";
import { setProperties } from "./utils";

export function createIcon(icon: CommandIcon): Element {
    if (typeof icon === "string") {
        return svg({ icon });
    }

    switch (icon.type) {
        case "svg":
            // Plugin-supplied markup is untrusted: rendered as an image, SVG cannot run scripts or event handlers.
            return img({ src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.value)}` });
        case "png": {
            const base64 = uint8ArrayToBase64(icon.value);
            const dataUrl = `data:image/png;base64,${base64}`;
            return img({ src: dataUrl });
        }
        case "url":
            return img({ src: icon.value });
        case "path":
            throw new Error("Plugin icon is not supported, please transform it to other icon type");
        default:
            return svg({ icon: "icon-spicy" });
    }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function createElement<K extends keyof HTMLElementTagNameMap>(tag: K) {
    return (
        props?: HTMLProps<HTMLElementTagNameMap[K]> | string | Node,
        ...children: (Node | string)[]
    ): HTMLElementTagNameMap[K] => {
        const e: HTMLElementTagNameMap[K] = document.createElement(tag);
        if (props) {
            if (typeof props === "string" || props instanceof Node) {
                e.append(props);
            } else {
                setProperties(e, props);
            }
        }
        children.forEach((c) => e.append(c));
        return e;
    };
}

export const div = createElement("div");
export const span = createElement("span");
export const input = createElement("input");
export const button = createElement("button");
export const label = createElement("label");
export const textarea = createElement("textarea");
export const select = createElement("select");
export const option = createElement("option");
export const a = createElement("a");
export const h1 = createElement("h1");
export const h2 = createElement("h2");
export const h3 = createElement("h3");
export const p = createElement("p");
export const ul = createElement("ul");
export const li = createElement("li");
export const img = createElement("img");
export const dialog = createElement("dialog");
export const canvas = createElement("canvas");
export const sup = createElement("sup");
export const form = createElement("form");
export const br = createElement("br");
export const hr = createElement("hr");

export function svg(props: HTMLProps<HTMLElement> & { icon: string }) {
    const ns = "http://www.w3.org/2000/svg";
    const child = document.createElementNS(ns, "use");
    child.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${props.icon}`);
    const svg = document.createElementNS(ns, "svg");
    svg.append(child);
    const className = String(props.className);
    delete props.className;
    setProperties(svg, props);
    // classList.add rejects tokens containing whitespace, so split multi-class names
    svg.classList.add(...className.split(" ").filter((x) => x !== ""));
    if (props.title) {
        addTitle(props, svg);
    }
    return svg;
}

export function setSVGIcon(svg: SVGSVGElement, newIcon: string) {
    const child = svg.firstChild as SVGUseElement;
    child?.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${newIcon}`);
}

function addTitle(props: HTMLProps<HTMLElement> & { icon: string }, svg: SVGSVGElement) {
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    if (props.title instanceof Localize) {
        props.title.set(title as any, "textContent");
    } else if (typeof props.title === "string") {
        title.textContent = props.title;
    } else {
        props.title?.setBinding(title, "textContent");
    }

    svg.appendChild(title);
}

export const collection = <T>(options: CollectionProps<T>) => new Collection(options);
