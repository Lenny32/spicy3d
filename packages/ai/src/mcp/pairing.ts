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
export type PairingAsk = (agent: RemoteAgent, signal: AbortSignal) => Promise<PairingDecision>;

/** Per browser tab, so a reload in the middle of a session does not ask again. */
const STORAGE_KEY = "spicy3d.mcp.pairing";
const MAX_REMEMBERED = 50;

interface PairingStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function sessionStore(): PairingStorage | undefined {
    try {
        return globalThis.sessionStorage;
    } catch {
        return undefined; // blocked storage: decisions then last until the page closes
    }
}

/**
 * The decisions per MCP session id. Requests of a session waiting for the prompt share one
 * question; a denied session keeps failing until it ends, an allowed one is never asked again.
 */
export class PairingGate {
    private readonly decisions = new Map<string, PairingDecision>();
    private readonly pending = new Map<
        string,
        { answer: Promise<PairingDecision>; abort: AbortController }
    >();
    /** Told about every decision the user makes (the agent badge shows denied sessions). */
    onDecided?: (agentId: string, decision: PairingDecision) => void;

    constructor(
        private readonly ask: PairingAsk = askPairing,
        private readonly storage: PairingStorage | undefined = sessionStore(),
    ) {
        try {
            const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "[]") as [
                string,
                PairingDecision,
            ][];
            for (const [id, decision] of saved) this.decisions.set(id, decision);
        } catch {
            // A damaged entry only means asking again.
        }
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
        const answer = this.ask(agent, abort.signal)
            .catch((err) => {
                Logger.warn(`[mcp] pairing prompt failed: ${err}`);
                return "deny" as const;
            })
            .then((decision) => {
                this.pending.delete(agent.id);
                // A prompt dismissed because the session ended is not a decision to remember.
                if (!abort.signal.aborted) this.remember(agent.id, decision);
                return decision;
            });
        this.pending.set(agent.id, { answer, abort });
        return answer;
    }

    /** The session ended: close its prompt (its requests fail as denied) and forget it. */
    forget(agentId: string): void {
        this.pending.get(agentId)?.abort.abort();
        if (this.decisions.delete(agentId)) this.save();
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
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.decisions]));
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

/** The in-tab prompt: a modal dialog with Allow / Deny; Escape or an ended session count as Deny. */
export function askPairing(agent: RemoteAgent, signal: AbortSignal): Promise<PairingDecision> {
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = style.pairingDialog;
        const finish = (decision: PairingDecision) => {
            signal.removeEventListener("abort", onAbort);
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(decision);
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
        dialog.append(
            div(
                { className: style.pairingBody },
                div({ className: style.sectionTitle, textContent: I18n.translate("mcp.pairing.title") }),
                span({ textContent: I18n.translate("mcp.pairing.question{0}", describeAgent(agent)) }),
                div({ className: style.muted, textContent: I18n.translate("mcp.pairing.hint") }),
                div({ className: style.pairingActions }, deny, allow),
            ),
        );
        dialog.dataset["agentId"] = agent.id;
        document.body.append(dialog);
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
        if (signal.aborted) onAbort();
    });
}
