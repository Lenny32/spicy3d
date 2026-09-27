// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type RemoteMcpSnapshot, remoteMcpState, remoteStatusKey } from "@spicy3d/ai";
import { I18n, PubSub } from "@spicy3d/core";
import { span } from "@spicy3d/element";
import style from "./mcpStatus.module.css";

/** Status-bar dot showing remote MCP through the server (CLOUD-14); click toggles the MCP panel. */
export class McpStatusIndicator extends HTMLElement {
    private unsubscribe?: () => void;

    constructor() {
        super();
        this.className = style.indicator;
        this.append(span({ className: style.dot }), span({ textContent: "MCP" }));
        this.onclick = () => PubSub.default.pub("toggleChatPanel");
    }

    connectedCallback(): void {
        this.unsubscribe ??= remoteMcpState.subscribe(this.render);
    }

    disconnectedCallback(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private readonly render = (state: RemoteMcpSnapshot) => {
        this.dataset["status"] = state.status === "unavailable" ? "idle" : state.status;
        this.title = I18n.translate(remoteStatusKey(state));
    };
}

customElements.define("spicy-mcp-status", McpStatusIndicator);
