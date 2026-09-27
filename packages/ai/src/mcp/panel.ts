// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, Localize } from "@spicy3d/core";
import { a, button, div, input, label, span, svg } from "@spicy3d/element";
import style from "./panel.module.css";
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

        this.append(
            this.header,
            div(
                { className: style.body },
                this.statusCard,
                div({ className: style.intro, textContent: new Localize("mcp.intro") }),
                this.tokenSection(),
                this.bridgeSection(),
                this.registerSection(),
                this.connectSection(),
            ),
        );
        this.render();
    }

    connectedCallback(): void {
        this.unsubscribe ??= mcpState.subscribe((state) => this.renderState(state));
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
