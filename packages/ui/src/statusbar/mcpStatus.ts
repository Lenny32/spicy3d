// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type McpConnectionStatus, mcpState, remoteMcpState } from "@spicy3d/ai";
import { I18n, type I18nKeys, PubSub } from "@spicy3d/core";
import { span } from "@spicy3d/element";
import style from "./mcpStatus.module.css";

const STATUS_KEYS: Record<McpConnectionStatus, I18nKeys> = {
    idle: "mcp.status.idle",
    connecting: "mcp.status.connecting",
    connected: "mcp.status.connected",
    offline: "mcp.status.offline",
};

/** The local bridge session's state, or else that of remote access through the server (CLOUD-14). */
export function combinedMcpStatus(): McpConnectionStatus {
    const bridge = mcpState.current.status;
    if (bridge !== "idle") return bridge;
    const remote = remoteMcpState.current.status;
    return remote === "unavailable" ? "idle" : remote;
}

/** Status-bar dot showing the MCP state; click toggles the MCP panel. */
export class McpStatusIndicator extends HTMLElement {
    private unsubscribe?: () => void;
    private unsubscribeRemote?: () => void;

    constructor() {
        super();
        this.className = style.indicator;
        this.append(span({ className: style.dot }), span({ textContent: "MCP" }));
        this.onclick = () => PubSub.default.pub("toggleChatPanel");
    }

    connectedCallback(): void {
        this.unsubscribe ??= mcpState.subscribe(this.render);
        this.unsubscribeRemote ??= remoteMcpState.subscribe(this.render);
    }

    disconnectedCallback(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.unsubscribeRemote?.();
        this.unsubscribeRemote = undefined;
    }

    private readonly render = () => {
        const status = combinedMcpStatus();
        this.dataset["status"] = status;
        this.title = I18n.translate(STATUS_KEYS[status]);
    };
}

customElements.define("spicy-mcp-status", McpStatusIndicator);
