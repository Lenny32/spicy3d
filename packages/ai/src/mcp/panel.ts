// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, Localize } from "@spicy3d/core";
import { button, div, input, label, span, svg } from "@spicy3d/element";
import { describeAgent } from "./pairing";
import style from "./panel.module.css";
import {
    disconnectRemoteAgent,
    type RemoteMcpLink,
    type RemoteMcpSnapshot,
    remoteClaudeCodeCommand,
    remoteJsonConfig,
    remoteMcpState,
    remoteStatusKey,
    setRemoteMcpEnabled,
} from "./remote";
import { loadMcpSettings } from "./settings";

/**
 * The MCP side panel (CLOUD-14): the user's MCP clients reach this tab through the server's relay.
 * Signed in: the status, the switch, the bound agents, recent calls, the access token and the
 * client configs. Signed out: the way to sign in. Without a server offering MCP: why there is
 * nothing to set up.
 */
export class McpPanel extends HTMLElement {
    readonly header: HTMLElement;
    onClose?: () => void;
    onDock?: () => void;

    private readonly headerButtons: HTMLElement;
    private readonly closeButtonEl: HTMLButtonElement;
    private readonly dockButtonEl: HTMLButtonElement;
    private readonly statusCard: HTMLElement;
    private readonly statusText = span({});
    private readonly statusDetail = div({ className: style.muted });
    private readonly enabledRow: HTMLElement;
    private readonly enabledInput: HTMLInputElement;
    private readonly agents = div({ className: style.agentList });
    private readonly callList = div({ className: style.callList });
    /** What follows the status card: setup once signed in, else the sign-in or the explanation. */
    private readonly content = div({ className: style.section });
    private shown?: { link?: RemoteMcpLink; signIn?: () => void };
    private unsubscribe?: () => void;

    constructor() {
        super();
        this.className = style.root;

        this.closeButtonEl = this.iconButton("icon-times", () => this.onClose?.());
        this.dockButtonEl = this.iconButton("icon-compress-alt", () => this.onDock?.());
        this.dockButtonEl.style.display = "none";
        this.headerButtons = div({ className: style.headerButtons }, this.dockButtonEl, this.closeButtonEl);
        this.header = div(
            { className: style.header },
            div(
                { className: style.title },
                svg({ className: style.titleIcon, icon: "icon-mcp" }),
                span({ textContent: new Localize("mcp.title") }),
            ),
            this.headerButtons,
        );

        this.enabledInput = input({
            type: "checkbox",
            checked: loadMcpSettings().remoteEnabled,
            onchange: () => setRemoteMcpEnabled(this.enabledInput.checked),
        });
        this.enabledRow = label(
            { className: style.checkbox },
            this.enabledInput,
            span({ textContent: new Localize("mcp.remote.enabled") }),
        );
        this.statusCard = div(
            { className: style.statusCard },
            div({ className: style.statusLine }, span({ className: style.dot }), this.statusText),
            this.statusDetail,
            this.enabledRow,
            this.agents,
            this.callList,
        );

        this.append(this.header, div({ className: style.body }, this.statusCard, this.content));
        this.render(remoteMcpState.current);
    }

    connectedCallback(): void {
        this.unsubscribe ??= remoteMcpState.subscribe((state) => this.render(state));
    }

    disconnectedCallback(): void {
        // Detaching into a FloatPanel moves this node, which fires disconnect then connect; the
        // subscription is dropped here and taken again in connectedCallback.
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    setFloating(floating: boolean) {
        this.header.style.display = floating ? "none" : "";
        this.dockButtonEl.style.display = floating ? "" : "none";
        if (!floating) this.headerButtons.append(this.dockButtonEl, this.closeButtonEl);
    }

    /** Buttons hosted by the FloatPanel title bar while floating. */
    floatingActions(): HTMLElement[] {
        return [this.dockButtonEl];
    }

    private render(state: RemoteMcpSnapshot) {
        const { link, signIn } = state;
        if (!this.shown || this.shown.link !== link || this.shown.signIn !== signIn) {
            this.shown = { link, signIn };
            this.content.replaceChildren(
                ...(link ? this.setup(link) : signIn ? this.signInPrompt(signIn) : this.noServer()),
            );
        }

        this.statusCard.dataset["status"] = state.status === "unavailable" ? "idle" : state.status;
        this.statusText.textContent = I18n.translate(remoteStatusKey(state));
        this.statusDetail.textContent = link ? I18n.translate("mcp.remote.signedInAs{0}", link.userName) : "";
        this.enabledRow.style.display = link ? "" : "none";
        this.enabledInput.checked = state.status !== "idle";
        const agents = link && state.status === "connected" ? state.agents : [];
        this.agents.replaceChildren(
            ...agents.map((agent) =>
                div(
                    { className: style.agentRow },
                    span({
                        textContent:
                            agent.pairing === "deny"
                                ? I18n.translate("mcp.agent.denied{0}", describeAgent(agent))
                                : describeAgent(agent),
                    }),
                    this.textButton("mcp.agent.disconnect", () => disconnectRemoteAgent(agent.id)),
                ),
            ),
        );
        this.callList.replaceChildren(
            ...(link ? state.calls : []).map((call) =>
                div(
                    { className: call.isError ? `${style.call} ${style.callError}` : style.call },
                    span({ textContent: new Date(call.time).toLocaleTimeString() }),
                    span({ className: style.callName, textContent: call.name }),
                ),
            ),
        );
    }

    /** Signed in to a server with the relay: the token and the configs to paste into the client. */
    private setup(link: RemoteMcpLink): HTMLElement[] {
        return [
            div({ className: style.intro, textContent: new Localize("mcp.remote.intro") }),
            this.section(
                "mcp.remote.step.token",
                div({ className: style.muted, textContent: new Localize("mcp.remote.tokenHint") }),
                div(
                    { className: style.row },
                    this.textButton("mcp.remote.createToken", () => link.createToken()),
                ),
            ),
            this.section(
                "mcp.remote.step.register",
                div({ className: style.muted, textContent: new Localize("mcp.remote.registerHint") }),
                this.snippet("mcp.remote.claudeCode", remoteClaudeCodeCommand(link.endpoint)),
                div({ className: style.muted, textContent: new Localize("mcp.remote.shellHistoryHint") }),
                this.snippet("mcp.remote.jsonConfig", remoteJsonConfig(link.endpoint)),
            ),
            div({ className: style.muted, textContent: new Localize("mcp.remote.pairingHint") }),
            div({ className: style.muted, textContent: new Localize("mcp.remote.tabInfoHint") }),
        ];
    }

    private signInPrompt(signIn: () => void): HTMLElement[] {
        const signInButton = button({
            className: style.primaryButton,
            textContent: I18n.translate("mcp.remote.signIn"),
            onclick: () => signIn(),
        });
        signInButton.dataset["signIn"] = "";
        return [
            div({ className: style.intro, textContent: new Localize("mcp.remote.intro") }),
            div({ className: style.muted, textContent: new Localize("mcp.remote.signInHint") }),
            signInButton,
        ];
    }

    private noServer(): HTMLElement[] {
        return [div({ className: style.intro, textContent: new Localize("mcp.remote.noServer") })];
    }

    private section(title: I18nKeys, ...children: HTMLElement[]): HTMLElement {
        return div(
            { className: style.section },
            div({ className: style.sectionTitle, textContent: new Localize(title) }),
            ...children,
        );
    }

    private snippet(title: I18nKeys, text: string): HTMLElement {
        const code = div({ className: style.code, textContent: text });
        code.dataset["remote"] = "";
        return div(
            { className: style.snippet },
            div(
                { className: style.snippetHeader },
                span({ textContent: new Localize(title) }),
                this.copyButton(() => code.textContent ?? ""),
            ),
            code,
        );
    }

    private copyButton(text: () => string): HTMLButtonElement {
        const copy: HTMLButtonElement = this.textButton("mcp.copy", () => {
            void navigator.clipboard?.writeText(text()).then(() => {
                copy.textContent = I18n.translate("mcp.copied");
                setTimeout(() => {
                    copy.textContent = I18n.translate("mcp.copy");
                }, 1500);
            });
        });
        return copy;
    }

    private textButton(title: I18nKeys, onclick: () => void): HTMLButtonElement {
        return button({ className: style.textButton, textContent: I18n.translate(title), onclick });
    }

    private iconButton(icon: string, onclick: () => void): HTMLButtonElement {
        return button({ className: style.iconButton, onclick }, svg({ className: style.buttonIcon, icon }));
    }
}

customElements.define("spicy-mcp-panel", McpPanel);

export function createMcpPanel(): McpPanel {
    return new McpPanel();
}
