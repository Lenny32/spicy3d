// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free: the pairing prompt of remote MCP. The relay names the MCP session every request comes
// from (`_meta["spicy3d/agent"]`); the first request of a new session that would act on the tab
// waits for the user's Allow / Deny, and the answer is kept for that session.

import { I18n, Logger } from "@spicy3d/core";
import { button, div, span } from "@spicy3d/element";
import style from "./panel.module.css";
import type { RemoteAgent } from "./remoteState";

export type PairingDecision = "allow" | "deny";
/** What the user can answer: `denyToken` also refuses every later session of that token. */
export type PairingAnswer = PairingDecision | "denyToken";
export type PairingAsk = (agent: RemoteAgent, signal: AbortSignal) => Promise<PairingAnswer>;

/** Per browser tab, so a reload in the middle of a session does not ask again. */
const STORAGE_KEY = "spicy3d.mcp.pairing";
const INSTANCE_KEY = "spicy3d.mcp.tabInstance";
const INSTANCE_CHANNEL = "spicy3d.mcp.tabInstance";
const MAX_REMEMBERED = 50;
/** After a Deny, new sessions of the same token are refused without asking for this long. */
export const DENY_COOLDOWN_MS = 60_000;
/** How long a tab waits for another tab to claim its instance id (a duplicated tab). */
const CLAIM_TIMEOUT_MS = 250;

interface PairingStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** The part of BroadcastChannel the instance check uses. */
export interface InstanceChannel {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

interface SavedPairing {
    instance: string;
    decisions: [string, PairingDecision][];
    blockedTokens: string[];
}

function sessionStore(): PairingStorage | undefined {
    try {
        return globalThis.sessionStorage;
    } catch {
        return undefined; // blocked storage: decisions then last until the page closes
    }
}

function randomId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
}

/**
 * This tab's instance id, kept in sessionStorage so a reload keeps it. A duplicated tab gets a copy
 * of sessionStorage — and so of the Allows — too; it asks the other tabs over a BroadcastChannel
 * whether one of them still holds the id, and takes a new one if so (the Allows then don't apply).
 * The answer to other tabs' questions keeps running for the page's lifetime.
 */
export function claimTabInstance(
    storage: PairingStorage | undefined,
    channel: InstanceChannel | undefined,
    timeoutMs = CLAIM_TIMEOUT_MS,
): Promise<string> {
    const stored = storage?.getItem(INSTANCE_KEY) ?? undefined;
    let id = stored ?? randomId();
    const store = () => {
        try {
            storage?.setItem(INSTANCE_KEY, id);
        } catch {
            // Not persisted: a reload asks again.
        }
    };
    if (!channel) {
        store();
        return Promise.resolve(id);
    }
    let claimed = false;
    channel.addEventListener("message", (event) => {
        const data = event.data as { type?: string; id?: string } | undefined;
        if (!claimed || data?.id !== id) return;
        if (data.type === "who") channel.postMessage({ type: "mine", id });
    });
    if (!stored) {
        claimed = true;
        store();
        return Promise.resolve(id);
    }
    return new Promise((resolve) => {
        const onAnswer = (event: { data: unknown }) => {
            const data = event.data as { type?: string; id?: string } | undefined;
            if (data?.type === "mine" && data.id === stored) finish(true);
        };
        const finish = (taken: boolean) => {
            clearTimeout(timer);
            channel.removeEventListener("message", onAnswer);
            if (taken) id = randomId();
            claimed = true;
            store();
            resolve(id);
        };
        channel.addEventListener("message", onAnswer);
        const timer = setTimeout(() => finish(false), timeoutMs);
        channel.postMessage({ type: "who", id: stored });
    });
}

/**
 * Removes every remembered Allow / Deny of this tab (sign-out): sessions of the next sign-in ask
 * again. The tab's instance id stays.
 */
export function forgetPairingDecisions(storage?: Pick<Storage, "removeItem">): void {
    try {
        (storage ?? globalThis.sessionStorage)?.removeItem(STORAGE_KEY);
    } catch {
        // Blocked storage held nothing.
    }
}

let pageInstance: Promise<string> | undefined;

/** The instance id of this page, claimed once (see {@link claimTabInstance}). */
function thisTabInstance(storage: PairingStorage | undefined): Promise<string> {
    if (!pageInstance) {
        let channel: InstanceChannel | undefined;
        try {
            channel =
                typeof BroadcastChannel === "function" ? new BroadcastChannel(INSTANCE_CHANNEL) : undefined;
        } catch {
            channel = undefined;
        }
        pageInstance = claimTabInstance(storage, channel);
    }
    return pageInstance;
}

export interface PairingGateOptions {
    ask?: PairingAsk;
    storage?: PairingStorage;
    /** This tab's instance id; decisions saved by another instance are ignored. */
    instance?: Promise<string>;
    now?: () => number;
}

/** A token is known to the tab only by its name (the relay sends no token id). */
function tokenKey(agent: RemoteAgent): string {
    return agent.tokenName ?? "";
}

/**
 * The decisions per MCP session id. One prompt is shown at a time (others queue); requests of a
 * session waiting for its prompt share one question; a denied session keeps failing until it ends,
 * an allowed one is never asked again. A Deny also refuses the token's new sessions for a minute
 * (no prompt flood), "Deny all from this token" for as long as this tab lives.
 */
export class PairingGate {
    private readonly decisions = new Map<string, PairingDecision>();
    private readonly blockedTokens = new Set<string>();
    private readonly cooldowns = new Map<string, number>();
    private readonly pending = new Map<
        string,
        { answer: Promise<PairingDecision>; abort: AbortController }
    >();
    private promptTail: Promise<unknown> = Promise.resolve();
    private readonly ask: PairingAsk;
    private readonly storage: PairingStorage | undefined;
    private readonly now: () => number;
    private instance = "";
    /** Resolves once the decisions saved for this very tab are loaded. */
    readonly ready: Promise<void>;
    /** Told about every decision the user makes (the agent badge shows denied sessions). */
    onDecided?: (agentId: string, decision: PairingDecision) => void;

    constructor(options: PairingGateOptions = {}) {
        this.ask = options.ask ?? askPairing;
        this.storage = "storage" in options ? options.storage : sessionStore();
        this.now = options.now ?? Date.now;
        this.ready = (options.instance ?? thisTabInstance(this.storage)).then((instance) => {
            this.instance = instance;
            this.load();
        });
    }

    decisionOf(agentId: string): PairingDecision | undefined {
        return this.decisions.get(agentId);
    }

    decide(agent: RemoteAgent): Promise<PairingDecision> {
        const known = this.decisions.get(agent.id);
        if (known) return Promise.resolve(known);
        const waiting = this.pending.get(agent.id);
        if (waiting) return waiting.answer;
        const abort = new AbortController();
        const aborted = new Promise<"deny">((resolve) =>
            abort.signal.addEventListener("abort", () => resolve("deny"), { once: true }),
        );
        // Registered at once, so forget/abortPending reach it even before the saved decisions load.
        const turn = this.promptTail.then(async () => {
            await this.ready;
            return this.decisions.get(agent.id) ?? this.promptFor(agent, abort.signal);
        });
        this.promptTail = turn.catch(() => undefined);
        const answer = Promise.race([turn, aborted]).then((decision) => {
            if (this.pending.get(agent.id)?.abort === abort) this.pending.delete(agent.id);
            return decision;
        });
        this.pending.set(agent.id, { answer, abort });
        return answer;
    }

    /** The session ended: close its prompt (its requests fail as denied) and forget it. */
    forget(agentId: string): void {
        this.pending.get(agentId)?.abort.abort();
        this.pending.delete(agentId);
        if (this.decisions.delete(agentId)) this.save();
    }

    /** The connection went away: every open or queued prompt closes, nothing is remembered. */
    abortPending(): void {
        for (const { abort } of this.pending.values()) abort.abort();
        this.pending.clear();
    }

    private async promptFor(agent: RemoteAgent, signal: AbortSignal): Promise<PairingDecision> {
        if (signal.aborted) return "deny";
        const token = tokenKey(agent);
        if (this.blockedTokens.has(token)) {
            this.remember(agent.id, "deny");
            return "deny";
        }
        // Refused, but not remembered: after the cooldown the session may ask again.
        if ((this.cooldowns.get(token) ?? 0) > this.now()) return "deny";
        let answer: PairingAnswer;
        try {
            answer = await this.ask(agent, signal);
        } catch (err) {
            Logger.warn(`[mcp] pairing prompt failed: ${err}`);
            answer = "deny";
        }
        // A prompt dismissed because the session or the connection ended is not a decision.
        if (signal.aborted) return "deny";
        if (answer === "denyToken") this.blockedTokens.add(token);
        if (answer !== "allow") this.cooldowns.set(token, this.now() + DENY_COOLDOWN_MS);
        const decision: PairingDecision = answer === "allow" ? "allow" : "deny";
        this.remember(agent.id, decision);
        return decision;
    }

    private load() {
        try {
            const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "null") as SavedPairing | null;
            if (!saved || saved.instance !== this.instance) return; // another tab's (a duplicate's copy)
            for (const [id, decision] of saved.decisions) this.decisions.set(id, decision);
            for (const token of saved.blockedTokens) this.blockedTokens.add(token);
        } catch {
            // A damaged entry only means asking again.
        }
    }

    private remember(agentId: string, decision: PairingDecision) {
        this.decisions.set(agentId, decision);
        while (this.decisions.size > MAX_REMEMBERED) {
            this.decisions.delete(this.decisions.keys().next().value as string);
        }
        this.save();
        this.onDecided?.(agentId, decision);
    }

    private save() {
        const saved: SavedPairing = {
            instance: this.instance,
            decisions: [...this.decisions],
            blockedTokens: [...this.blockedTokens],
        };
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(saved));
        } catch {
            // Not persisted: asked again after a reload.
        }
    }
}

export function describeAgent(agent: RemoteAgent): string {
    return agent.tokenName
        ? I18n.translate("mcp.remote.agentWithToken{0}{1}", agent.clientName, agent.tokenName)
        : agent.clientName;
}

/**
 * The in-tab prompt: a modal dialog with Allow / Deny / Deny all from this token; Escape or an
 * ended session count as Deny. The token name is what the server vouches for; the client name is
 * whatever the client calls itself, and says so.
 */
export function askPairing(agent: RemoteAgent, signal: AbortSignal): Promise<PairingAnswer> {
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = style.pairingDialog;
        const finish = (answer: PairingAnswer) => {
            signal.removeEventListener("abort", onAbort);
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(answer);
        };
        const onAbort = () => finish("deny");
        signal.addEventListener("abort", onAbort);
        dialog.addEventListener("cancel", (e) => {
            e.preventDefault();
            finish("deny");
        });
        const allow = button({
            className: style.primaryButton,
            textContent: I18n.translate("mcp.pairing.allow"),
            onclick: () => finish("allow"),
        });
        const deny = button({
            className: style.textButton,
            textContent: I18n.translate("mcp.pairing.deny"),
            onclick: () => finish("deny"),
        });
        const denyToken = button({
            className: style.textButton,
            textContent: I18n.translate("mcp.pairing.denyToken"),
            onclick: () => finish("denyToken"),
        });
        denyToken.dataset["action"] = "denyToken";
        const token = agent.tokenName ?? I18n.translate("mcp.pairing.unnamedToken");
        dialog.append(
            div(
                { className: style.pairingBody },
                div({ className: style.sectionTitle, textContent: I18n.translate("mcp.pairing.title") }),
                span({ textContent: I18n.translate("mcp.pairing.question") }),
                div(
                    { className: style.pairingToken },
                    span({ textContent: I18n.translate("mcp.pairing.token") }),
                    span({ className: style.pairingTokenName, textContent: token }),
                ),
                div({
                    className: style.muted,
                    textContent: I18n.translate("mcp.pairing.client{0}", agent.clientName),
                }),
                div({ className: style.muted, textContent: I18n.translate("mcp.pairing.hint") }),
                div({ className: style.pairingActions }, denyToken, deny, allow),
            ),
        );
        dialog.dataset["agentId"] = agent.id;
        document.body.append(dialog);
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
        if (signal.aborted) onAbort();
    });
}
