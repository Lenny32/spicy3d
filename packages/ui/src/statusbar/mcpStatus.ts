// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type McpConnectionStatus, type McpStateSnapshot, mcpState } from "@spicy3d/ai";
import { I18n, type I18nKeys, PubSub } from "@spicy3d/core";
import { span } from "@spicy3d/element";
import style from "./mcpStatus.module.css";

const STATUS_KEYS: Record<McpConnectionStatus, I18nKeys> = {
    idle: "mcp.status.idle",
    connecting: "mcp.status.connecting",
    connected: "mcp.status.connected",
    offline: "mcp.status.offline",
};

/** Status-bar dot showing the MCP bridge session state; click toggles the MCP panel. */
export class McpStatusIndicator extends HTMLElement {
    private unsubscribe?: () => void;

    constructor() {
        super();
        this.className = style.indicator;
        this.append(span({ className: style.dot }), span({ textContent: "MCP" }));
        this.onclick = () => PubSub.default.pub("toggleChatPanel");
    }

    connectedCallback(): void {
        this.unsubscribe ??= mcpState.subscribe(this.render);
    }

    disconnectedCallback(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private readonly render = (state: McpStateSnapshot) => {
        this.dataset["status"] = state.status;
        this.title = I18n.translate(STATUS_KEYS[state.status]);
    };
}

customElements.define("spicy-mcp-status", McpStatusIndicator);
