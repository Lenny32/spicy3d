// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, PubSub } from "@spicy3d/core";
import { a, svg } from "@spicy3d/element";
import type { ProjectView } from "./projectView";
import style from "./toolBar.module.css";

export class ToolBar extends HTMLElement {
    constructor(readonly projectView: ProjectView) {
        super();
        this.className = style.panel;
        this.render();
    }

    private render() {
        const buttons = [
            { icon: "icon-folder-plus", tip: "browser.newComponent", command: this.newGroup },
            { icon: "icon-unexpand", tip: "items.tool.unexpandAll", command: this.unExpandAll },
            { icon: "icon-expand", tip: "items.tool.expandAll", command: this.expandAll },
        ];
        buttons.forEach(({ icon, tip, command }) => this.button(icon, tip as I18nKeys, command));
    }

    private button(icon: string, tip: I18nKeys, command: () => void) {
        this.append(
            a(
                { title: I18n.translate(tip) },
                svg({
                    icon,
                    className: style.svg,
                    onclick: command,
                }),
            ),
        );
    }

    private readonly newGroup = () => {
        if (!this.projectView.activeTree()?.actions.editable) return;
        PubSub.default.pub("executeCommand", "create.folder");
    };

    private readonly expandAll = () => {
        this.setExpand(true);
    };

    private readonly unExpandAll = () => {
        this.setExpand(false);
    };

    private setExpand(expand: boolean) {
        const tree = this.projectView.activeTree();
        if (!tree) return;
        tree.setExpanded(expand);
    }
}

customElements.define("spicy-toolbar", ToolBar);
