// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free: the title-bar badge shown while an MCP session of the relay targets this tab.

import { I18n, PubSub, TitleBar } from "@spicy3d/core";
import { button, div, span } from "@spicy3d/element";
import { describeAgent } from "./pairing";
import style from "./panel.module.css";
import { type RemoteAgent, type RemoteMcpSnapshot, remoteMcpState } from "./remoteState";

/**
 * One chip per bound session: "● claude-code" (the token name in the tooltip) and "Disconnect
 * agent". Clicking the name opens the MCP panel. Hidden while no session targets this tab.
 */
export class AgentBadge extends HTMLElement {
    private unsubscribe?: () => void;

    constructor() {
        super();
        this.className = style.agentList;
        this.style.flexDirection = "row";
    }

    connectedCallback(): void {
        this.unsubscribe ??= remoteMcpState.subscribe(this.render);
    }

    disconnectedCallback(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private readonly render = (state: RemoteMcpSnapshot) => {
        const agents = state.status === "connected" ? state.agents : [];
        this.hidden = agents.length === 0;
        this.replaceChildren(...agents.map((agent) => this.chip(agent)));
    };

    private chip(agent: RemoteAgent): HTMLElement {
        const denied = agent.pairing === "deny";
        const chip = div(
            {
                className: style.agentBadge,
                title: `${describeAgent(agent)}: ${I18n.translate(denied ? "mcp.agent.deniedTitle" : "mcp.agent.title")}`,
            },
            span({ className: style.dot }),
            span({
                className: style.agentName,
                textContent: agent.clientName,
                onclick: () => PubSub.default.pub("toggleChatPanel"),
            }),
            button({
                className: style.agentBadgeButton,
                textContent: I18n.translate("mcp.agent.disconnect"),
                onclick: () => void import("./index").then((c) => c.disconnectRemoteAgent(agent.id)),
            }),
        );
        chip.dataset["agentId"] = agent.id;
        if (denied) chip.dataset["denied"] = "";
        return chip;
    }
}

customElements.define("spicy-mcp-agent-badge", AgentBadge);

let badge: AgentBadge | undefined;

/** Adds the badge to the title bar once (it hides itself while no agent is bound). */
export function ensureAgentBadge(): AgentBadge {
    if (!badge) {
        badge = new AgentBadge();
        TitleBar.items.push(badge);
    }
    return badge;
}
