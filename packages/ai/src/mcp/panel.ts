// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, Localize } from "@spicy3d/core";
import { a, button, div, input, label, span, svg } from "@spicy3d/element";
import { describeAgent } from "./pairing";
import style from "./panel.module.css";
import {
    disconnectRemoteAgent,
    type RemoteMcpLink,
    type RemoteMcpSnapshot,
    type RemoteMcpStatus,
    remoteClaudeCodeCommand,
    remoteJsonConfig,
    remoteMcpState,
    remoteStdioConfig,
    setRemoteMcpEnabled,
} from "./remote";
import {
    BRIDGE_PLATFORMS,
    type BridgePlatform,
    type BridgeRunner,
    bridgeDownloadUrl,
    bridgeUrlFor,
    claudeCodeCommand,
    currentAppUrl,
    defaultBridgeCommand,
    executablePlaceholder,
    generateToken,
    isCommandComplete,
    isLoopbackPage,
    isValidPort,
    loadMcpSettings,
    type McpSettings,
    mcpJsonConfig,
    platformsForThisBrowser,
    saveMcpSettings,
} from "./settings";
import { type McpConnectionStatus, type McpStateSnapshot, mcpState } from "./state";

const STATUS_KEYS: Record<McpConnectionStatus, I18nKeys> = {
    idle: "mcp.status.idle",
    connecting: "mcp.status.connecting",
    connected: "mcp.status.connected",
    offline: "mcp.status.offline",
};

const REMOTE_STATUS_KEYS: Record<RemoteMcpStatus, I18nKeys> = {
    unavailable: "mcp.remote.status.unavailable",
    idle: "mcp.remote.status.idle",
    connecting: "mcp.remote.status.connecting",
    connected: "mcp.remote.status.connected",
    offline: "mcp.remote.status.offline",
};

type PanelMode = "remote" | "local";

/** The SDK half, loaded on the first Connect (see mcp/index.ts). */
const loadController = () => import("./index");

/**
 * The MCP side panel: connection status, the step-by-step setup (token, port, the config to paste
 * into the agent) and Connect/Disconnect. Every setting is saved as it changes, and the config
 * snippets are rebuilt from it, so what the user copies always matches what the page presents.
 */
export class McpPanel extends HTMLElement {
    readonly header: HTMLElement;
    onClose?: () => void;
    onDock?: () => void;

    private settings: McpSettings = loadMcpSettings();
    private readonly headerButtons: HTMLElement;
    private readonly closeButtonEl: HTMLButtonElement;
    private readonly dockButtonEl: HTMLButtonElement;
    private readonly statusCard: HTMLElement;
    private readonly statusText = span({});
    private readonly statusDetail = div({ className: style.muted });
    private readonly callList = div({ className: style.callList });
    private readonly connectButton: HTMLButtonElement;
    private readonly tokenRow: HTMLElement;
    private readonly tokenInput: HTMLInputElement;
    private readonly noTokenWarning: HTMLElement;
    private readonly claudeCodeSnippet = div({ className: style.code });
    private readonly jsonSnippet = div({ className: style.code });
    private readonly executableBlock = this.buildExecutableBlock();
    private readonly nodeBlock = this.buildNodeBlock();
    private readonly incompleteWarning = div({
        className: style.warning,
        textContent: new Localize("mcp.executableMissing"),
    });
    /** Remote MCP through the server (CLOUD-14); built once a link is there. */
    private readonly remoteRoot = div({ className: style.section });
    private readonly localRoot: HTMLElement;
    private readonly modeChoice: HTMLElement;
    private readonly modeButtons = new Map<PanelMode, HTMLButtonElement>();
    private mode?: PanelMode;
    private remoteLink?: RemoteMcpLink;
    private remoteView?: {
        statusCard: HTMLElement;
        statusText: HTMLElement;
        agents: HTMLElement;
        enabled: HTMLInputElement;
        stdio: HTMLElement;
    };
    private unsubscribe?: () => void;
    private unsubscribeRemote?: () => void;

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
                svg({ className: style.titleIcon, icon: "icon-spicy" }),
                span({ textContent: new Localize("mcp.title") }),
            ),
            this.headerButtons,
        );

        this.connectButton = button({
            className: style.primaryButton,
            onclick: () => this.toggleConnection(),
        });
        this.statusCard = div(
            { className: style.statusCard },
            div({ className: style.statusLine }, span({ className: style.dot }), this.statusText),
            this.statusDetail,
            this.callList,
            this.connectButton,
        );

        this.tokenInput = input({
            className: style.field,
            spellcheck: false,
            onchange: () => this.update({ token: this.tokenInput.value.trim() }),
        });
        this.tokenRow = div(
            { className: style.row },
            this.tokenInput,
            this.textButton("mcp.generate", () => this.update({ token: generateToken() })),
            this.copyButton(() => this.settings.token),
        );
        this.noTokenWarning = div({
            className: style.warning,
            textContent: new Localize("mcp.noTokenWarning"),
        });

        this.localRoot = div(
            { className: style.body },
            this.statusCard,
            div({ className: style.intro, textContent: new Localize("mcp.intro") }),
            this.tokenSection(),
            this.bridgeSection(),
            this.registerSection(),
            this.connectSection(),
        );
        this.localRoot.style.padding = "0";
        this.modeChoice = div(
            { className: style.modeChoice },
            this.modeButton("remote", "mcp.mode.remote"),
            this.modeButton("local", "mcp.mode.local"),
        );
        this.append(
            this.header,
            div({ className: style.body }, this.modeChoice, this.remoteRoot, this.localRoot),
        );
        this.render();
        this.renderRemote(remoteMcpState.current);
        if (!this.mode) this.setMode("local");
    }

    connectedCallback(): void {
        this.unsubscribe ??= mcpState.subscribe((state) => this.renderState(state));
        this.unsubscribeRemote ??= remoteMcpState.subscribe((state) => this.renderRemote(state));
    }

    disconnectedCallback(): void {
        // Detaching into a FloatPanel moves this node, which fires disconnect then connect; the
        // subscription is dropped here and taken again in connectedCallback.
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.unsubscribeRemote?.();
        this.unsubscribeRemote = undefined;
    }

    private modeButton(mode: PanelMode, title: I18nKeys): HTMLButtonElement {
        const b = button({
            className: style.modeButton,
            textContent: I18n.translate(title),
            onclick: () => this.setMode(mode),
        });
        b.dataset["mode"] = mode;
        this.modeButtons.set(mode, b);
        return b;
    }

    private setMode(mode: PanelMode) {
        this.mode = mode;
        const remote = mode === "remote" && this.remoteLink !== undefined;
        this.remoteRoot.style.display = remote ? "" : "none";
        this.localRoot.style.display = remote ? "none" : "";
        this.modeChoice.style.display = this.remoteLink ? "" : "none";
        for (const [m, b] of this.modeButtons) b.setAttribute("aria-pressed", String(m === mode));
    }

    /** The server mode: status, the bound agents, the token and the client configs. */
    private renderRemote(state: RemoteMcpSnapshot) {
        if (state.link !== this.remoteLink) {
            this.remoteLink = state.link;
            this.remoteView = undefined;
            this.remoteRoot.replaceChildren();
            if (state.link) this.buildRemote(state.link);
            // The server is the way in once it offers the relay; the bridge stays one click away.
            this.setMode(state.link ? (this.mode ?? "remote") : "local");
        }
        const view = this.remoteView;
        if (!view) return;
        view.statusCard.dataset["status"] = state.status === "unavailable" ? "idle" : state.status;
        view.statusText.textContent = I18n.translate(REMOTE_STATUS_KEYS[state.status]);
        view.enabled.checked = state.status !== "idle";
        view.agents.replaceChildren(
            ...state.agents.map((agent) =>
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
    }

    private buildRemote(link: RemoteMcpLink) {
        const statusText = span({});
        const statusCard = div(
            { className: style.statusCard },
            div({ className: style.statusLine }, span({ className: style.dot }), statusText),
            div({
                className: style.muted,
                textContent: I18n.translate("mcp.remote.signedInAs{0}", link.userName),
            }),
        );
        const agents = div({ className: style.agentList });
        const enabled = input({
            type: "checkbox",
            checked: loadMcpSettings().remoteEnabled,
            onchange: () => setRemoteMcpEnabled(enabled.checked),
        });
        statusCard.append(
            label(
                { className: style.checkbox },
                enabled,
                span({ textContent: new Localize("mcp.remote.enabled") }),
            ),
            agents,
        );
        const stdio = div({
            className: style.code,
            textContent: remoteStdioConfig(link.endpoint, this.settings, currentAppUrl()),
        });
        stdio.dataset["remote"] = "";
        this.remoteRoot.append(
            statusCard,
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
                this.remoteSnippet("mcp.remote.claudeCode", remoteClaudeCodeCommand(link.endpoint)),
                div({ className: style.muted, textContent: new Localize("mcp.remote.shellHistoryHint") }),
                this.remoteSnippet("mcp.remote.jsonConfig", remoteJsonConfig(link.endpoint)),
                this.snippet("mcp.remote.stdioConfig", stdio),
            ),
            div({ className: style.muted, textContent: new Localize("mcp.remote.pairingHint") }),
            div({ className: style.muted, textContent: new Localize("mcp.remote.tabInfoHint") }),
        );
        this.remoteView = { statusCard, statusText, agents, enabled, stdio };
    }

    private remoteSnippet(title: I18nKeys, text: string): HTMLElement {
        const code = div({ className: style.code, textContent: text });
        code.dataset["remote"] = "";
        return this.snippet(title, code);
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

    private tokenSection(): HTMLElement {
        return this.section(
            "mcp.step.token",
            this.checkbox("mcp.requireToken", this.settings.requireToken, (requireToken) =>
                this.update({
                    requireToken,
                    token: requireToken && !this.settings.token ? generateToken() : this.settings.token,
                }),
            ),
            this.tokenRow,
            this.noTokenWarning,
            div({ className: style.muted, textContent: new Localize("mcp.tokenHint") }),
        );
    }

    private bridgeSection(): HTMLElement {
        const portInput = input({
            className: style.field,
            type: "number",
            min: "1",
            max: "65535",
            value: String(this.settings.port),
            onchange: () => {
                const port = Number(portInput.value);
                if (isValidPort(port)) this.update({ port });
                else portInput.value = String(this.settings.port);
            },
        });
        const pageInput = input({ className: style.field, readOnly: true, value: currentAppUrl() });
        return this.section(
            "mcp.step.bridge",
            div({ className: style.muted, textContent: new Localize("mcp.bridgeHint") }),
            this.runnerChoice(),
            this.executableBlock,
            this.nodeBlock,
            this.field("mcp.appUrl", pageInput),
            this.field("mcp.port", portInput),
        );
    }

    private runnerChoice(): HTMLElement {
        const radio = (runner: BridgeRunner, title: I18nKeys) => {
            const box = input({
                type: "radio",
                name: "mcp-runner",
                checked: this.settings.runner === runner,
                onchange: () => box.checked && this.update({ runner }),
            });
            return label({ className: style.checkbox }, box, span({ textContent: new Localize(title) }));
        };
        return div(
            { className: style.section },
            radio("executable", "mcp.runner.executable"),
            radio("node", "mcp.runner.node"),
        );
    }

    /** Download links (this browser's OS first, then the rest) and where the file was saved. */
    private buildExecutableBlock(): HTMLElement {
        const mine = platformsForThisBrowser();
        const others = BRIDGE_PLATFORMS.filter((p) => !mine.includes(p));
        const link = (p: BridgePlatform, primary: boolean) =>
            a({
                className: primary ? style.downloadPrimary : style.download,
                href: bridgeDownloadUrl(p),
                textContent: p.label,
                target: "_blank",
                rel: "noopener",
            });
        const pathInput = input({
            className: style.field,
            spellcheck: false,
            placeholder: executablePlaceholder(),
            value: this.settings.executablePath,
            onchange: () => this.update({ executablePath: pathInput.value.trim().replace(/^"(.*)"$/, "$1") }),
        });
        return div(
            { className: style.section },
            div(
                { className: style.downloads },
                span({ className: style.muted, textContent: new Localize("mcp.download") }),
                ...mine.map((p) => link(p, true)),
                ...others.map((p) => link(p, false)),
            ),
            this.field("mcp.executablePath", pathInput),
            div({ className: style.muted, textContent: new Localize("mcp.executableHint") }),
        );
    }

    private buildNodeBlock(): HTMLElement {
        const commandInput = input({
            className: style.field,
            spellcheck: false,
            value: this.settings.bridgeCommand || defaultBridgeCommand(currentAppUrl()),
            onchange: () => {
                // Clearing the field, or typing the default back, returns to "follow this site".
                const typed = commandInput.value.trim();
                const bridgeCommand = typed === defaultBridgeCommand(currentAppUrl()) ? "" : typed;
                this.update({ bridgeCommand });
                commandInput.value = this.settings.bridgeCommand || defaultBridgeCommand(currentAppUrl());
            },
        });
        return div(
            { className: style.section },
            div({ className: style.muted, textContent: new Localize("mcp.nodeHint") }),
            this.field("mcp.bridgeCommand", commandInput),
        );
    }

    private registerSection(): HTMLElement {
        return this.section(
            "mcp.step.register",
            this.incompleteWarning,
            this.snippet("mcp.claudeCode", this.claudeCodeSnippet),
            this.snippet("mcp.jsonConfig", this.jsonSnippet),
        );
    }

    private connectSection(): HTMLElement {
        return this.section(
            "mcp.step.connect",
            div({ className: style.muted, textContent: new Localize("mcp.connectHint") }),
            ...(isLoopbackPage()
                ? []
                : [div({ className: style.muted, textContent: new Localize("mcp.remoteHint") })]),
            this.checkbox("mcp.autoConnect", this.settings.autoConnect, (autoConnect) =>
                this.update({ autoConnect }),
            ),
        );
    }

    private update(patch: Partial<McpSettings>) {
        const before = bridgeUrlFor(this.settings);
        this.settings = { ...this.settings, ...patch };
        saveMcpSettings(this.settings);
        this.render();
        // A live session keeps the address it started with; follow the new one.
        if (mcpState.current.status !== "idle" && bridgeUrlFor(this.settings) !== before) this.connect();
    }

    private render() {
        const appUrl = currentAppUrl();
        this.tokenInput.value = this.settings.token;
        this.tokenRow.style.display = this.settings.requireToken ? "" : "none";
        this.noTokenWarning.style.display = this.settings.requireToken ? "none" : "";
        this.executableBlock.style.display = this.settings.runner === "executable" ? "" : "none";
        this.nodeBlock.style.display = this.settings.runner === "node" ? "" : "none";
        this.incompleteWarning.style.display = isCommandComplete(this.settings) ? "none" : "";
        this.claudeCodeSnippet.textContent = claudeCodeCommand(this.settings, appUrl);
        this.jsonSnippet.textContent = mcpJsonConfig(this.settings, appUrl);
        // The stdio fallback starts the same bridge executable the local setup names.
        if (this.remoteView && this.remoteLink) {
            this.remoteView.stdio.textContent = remoteStdioConfig(
                this.remoteLink.endpoint,
                this.settings,
                appUrl,
            );
        }
    }

    private renderState(state: McpStateSnapshot) {
        this.statusCard.dataset["status"] = state.status;
        this.statusText.textContent = I18n.translate(STATUS_KEYS[state.status]);
        this.statusDetail.textContent =
            state.status === "offline"
                ? I18n.translate("mcp.offlineHint")
                : state.bridge
                  ? I18n.translate("mcp.bridgeAt", state.bridge)
                  : "";
        this.connectButton.textContent = I18n.translate(
            state.status === "idle" ? "mcp.connect" : "mcp.disconnect",
        );
        this.callList.replaceChildren(
            ...state.calls.map((call) =>
                div(
                    { className: call.isError ? `${style.call} ${style.callError}` : style.call },
                    span({ textContent: new Date(call.time).toLocaleTimeString() }),
                    span({ className: style.callName, textContent: call.name }),
                ),
            ),
        );
    }

    private toggleConnection() {
        if (mcpState.current.status === "idle") this.connect();
        else void loadController().then((c) => c.disconnectMcpBridge());
    }

    private connect() {
        const url = bridgeUrlFor(this.settings);
        void loadController().then((c) => c.connectMcpBridge(url));
    }

    private section(title: I18nKeys, ...children: HTMLElement[]): HTMLElement {
        return div(
            { className: style.section },
            div({ className: style.sectionTitle, textContent: new Localize(title) }),
            ...children,
        );
    }

    private field(title: I18nKeys, control: HTMLElement): HTMLElement {
        return label({ className: style.fieldLabel }, span({ textContent: new Localize(title) }), control);
    }

    private checkbox(title: I18nKeys, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
        const box = input({ type: "checkbox", checked, onchange: () => onChange(box.checked) });
        return label({ className: style.checkbox }, box, span({ textContent: new Localize(title) }));
    }

    private snippet(title: I18nKeys, code: HTMLElement): HTMLElement {
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
