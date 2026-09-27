// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free: the prompt an agent's `spicy3d_open_document` waits for when the document the user is
// looking at has unsaved changes (CLOUD-15).

import { I18n, type I18nKeys, Logger, redactSecrets } from "@spicy3d/core";
import { button, div, span } from "@spicy3d/element";
import style from "../mcp/panel.module.css";

/** `save`: save the current document, then open; `keep`: open, the current one stays unsaved. */
export type OpenChoice = "save" | "keep" | "cancel";

export interface OpenQuestion {
    /** The document with unsaved changes. */
    current: string;
    /** The document the agent wants to open. */
    target: string;
}

export type AskOpen = (question: OpenQuestion, signal: AbortSignal) => Promise<OpenChoice>;

/** What the agent's call learns: go on, the user said no, or no answer yet. */
export type OpenDecision = "proceed" | "declined" | "saveFailed" | "waiting";

/** An answer given after the call that asked stopped waiting is kept this long for its retry. */
export const OPEN_DECISION_TTL_MS = 5 * 60_000;
/**
 * How long one call waits for the user before answering "waiting for user": below the 60 s an MCP
 * client's request usually gets (and the relay's 120 s), so the call is answered, not timed out.
 */
export const OPEN_WAIT_MS = 45_000;

interface PendingQuestion {
    key: string;
    /** The MCP session that asked: its question ends with it. */
    caller?: string;
    abort: AbortController;
    answer: Promise<Exclude<OpenDecision, "waiting">>;
    decided?: { decision: Exclude<OpenDecision, "waiting">; at: number };
}

export interface OpenConsentOptions {
    ask?: AskOpen;
    now?: () => number;
}

/**
 * One question at a time, per page. The call that asked waits up to `waitMs`; unanswered, it
 * returns `waiting` and the question stays up, so the agent's retry (same document) waits for the
 * same answer instead of asking again. Asking about another document (or another session asking)
 * closes the first question; so does the asking session ending ({@link forgetCaller}) or signing out.
 */
export class OpenConsent {
    private pending?: PendingQuestion;
    private readonly ask: AskOpen;
    private readonly now: () => number;

    constructor(options: OpenConsentOptions = {}) {
        this.ask = options.ask ?? askOpenDocument;
        this.now = options.now ?? Date.now;
    }

    /** Whether a question is showing (or answered, waiting for its retry). */
    get asking(): boolean {
        return this.pending !== undefined;
    }

    /**
     * `saveFirst` runs as soon as the user picks "Save and open" (even when the call already
     * returned `waiting`); false = the save did not go through.
     */
    async request(
        key: string,
        question: OpenQuestion,
        saveFirst: () => Promise<boolean>,
        waitMs: number,
        signal?: AbortSignal,
        caller?: string,
    ): Promise<OpenDecision> {
        let pending = this.pending;
        if (pending && (pending.key !== key || pending.caller !== caller)) {
            this.cancel();
            pending = undefined;
        }
        if (pending?.decided && this.now() - pending.decided.at > OPEN_DECISION_TTL_MS) {
            this.pending = undefined;
            pending = undefined;
        }
        pending ??= this.start(key, caller, question, saveFirst);
        const decision = await waitFor(pending.answer, waitMs, signal);
        if (decision !== "waiting" && this.pending === pending) this.pending = undefined;
        return decision;
    }

    /** The session `caller` ended (disconnected, or the agent was disconnected): its question closes. */
    forgetCaller(caller: string): void {
        if (this.pending?.caller === caller) this.cancel();
    }

    /** Closes the question showing, as a cancel that nobody consumes. */
    cancel(): void {
        const pending = this.pending;
        this.pending = undefined;
        pending?.abort.abort();
    }

    private start(
        key: string,
        caller: string | undefined,
        question: OpenQuestion,
        saveFirst: () => Promise<boolean>,
    ): PendingQuestion {
        const abort = new AbortController();
        const pending: PendingQuestion = { key, caller, abort, answer: undefined as never };
        pending.answer = this.ask(question, abort.signal)
            .catch((err) => {
                Logger.warn(`[mcp] open prompt failed: ${redactSecrets(String(err))}`);
                return "cancel" as const;
            })
            .then(async (choice) => {
                let decision: Exclude<OpenDecision, "waiting"> = "proceed";
                if (abort.signal.aborted || choice === "cancel") decision = "declined";
                else if (choice === "save" && !(await saveFirst())) decision = "saveFailed";
                pending.decided = { decision, at: this.now() };
                return decision;
            });
        this.pending = pending;
        return pending;
    }
}

function waitFor<T>(answer: Promise<T>, waitMs: number, signal?: AbortSignal): Promise<T | "waiting"> {
    return new Promise((resolve) => {
        const done = (value: T | "waiting") => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
        };
        const onAbort = () => done("waiting");
        const timer = setTimeout(() => done("waiting"), waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        void answer.then(done);
    });
}

/**
 * The in-tab question: a modal with Save and open / Open, keep unsaved / Cancel. Escape cancels.
 * The current document stays open in its own view tab whatever the answer.
 */
export function askOpenDocument(question: OpenQuestion, signal: AbortSignal): Promise<OpenChoice> {
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = style.pairingDialog;
        dialog.dataset["prompt"] = "agentOpen";
        const finish = (choice: OpenChoice) => {
            signal.removeEventListener("abort", onAbort);
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(choice);
        };
        const onAbort = () => finish("cancel");
        signal.addEventListener("abort", onAbort);
        dialog.addEventListener("cancel", (e) => {
            e.preventDefault();
            finish("cancel");
        });
        const choice = (choice: OpenChoice, label: I18nKeys, className: string) => {
            const b = button({
                className,
                textContent: I18n.translate(label),
                onclick: () => finish(choice),
            });
            b.dataset["choice"] = choice;
            return b;
        };
        dialog.append(
            div(
                { className: style.pairingBody },
                div({ className: style.sectionTitle, textContent: I18n.translate("mcp.open.title") }),
                span({
                    textContent: I18n.translate("mcp.open.question{0}{1}", question.target, question.current),
                }),
                div({ className: style.muted, textContent: I18n.translate("mcp.open.hint") }),
                div(
                    { className: style.pairingActions },
                    choice("cancel", "common.cancel", style.textButton),
                    choice("keep", "mcp.open.keep", style.textButton),
                    choice("save", "mcp.open.save", style.primaryButton),
                ),
            ),
        );
        document.body.append(dialog);
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
        if (signal.aborted) onAbort();
    });
}
