// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "./foundation/pubsub";
import { redactSecrets } from "./foundation/redact";

export type ErrorLogSource = "app" | "uncaught" | "promise";

export interface ErrorLogEntry {
    readonly id: number;
    /** Epoch milliseconds. */
    readonly time: number;
    readonly source: ErrorLogSource;
    readonly message: string;
    /** Stack trace or any further text; secrets and URL queries are already redacted. */
    readonly details?: string;
}

type ErrorLogListener = (entry: ErrorLogEntry | undefined) => void;

const MAX_ENTRIES = 200;

/**
 * Errors of this session, newest last. Never saved with the document: it lives in memory only.
 * Fed by `displayError` (the red toast) and by uncaught errors / rejected promises once
 * {@link ErrorLog.install} ran; the UI lists it and the MCP server hands it to agents.
 */
export class ErrorLog {
    private static _entries: ErrorLogEntry[] = [];
    private static _nextId = 1;
    private static readonly _listeners = new Set<ErrorLogListener>();
    private static _installed = false;

    static get entries(): readonly ErrorLogEntry[] {
        return ErrorLog._entries;
    }

    /** `listener(entry)` on every new entry, `listener(undefined)` after {@link clear}. Returns an unsubscriber. */
    static subscribe(listener: ErrorLogListener): () => void {
        ErrorLog._listeners.add(listener);
        return () => ErrorLog._listeners.delete(listener);
    }

    static report(message: string, options?: { source?: ErrorLogSource; details?: string }): ErrorLogEntry {
        const entry: ErrorLogEntry = {
            id: ErrorLog._nextId++,
            time: Date.now(),
            source: options?.source ?? "app",
            message: redactSecrets(message),
            details: options?.details ? redactSecrets(options.details) : undefined,
        };
        ErrorLog._entries = [...ErrorLog._entries, entry].slice(-MAX_ENTRIES);
        for (const listener of [...ErrorLog._listeners]) listener(entry);
        return entry;
    }

    static clear(): void {
        ErrorLog._entries = [];
        for (const listener of [...ErrorLog._listeners]) listener(undefined);
    }

    /** One text block for an agent or a bug report. */
    static format(entries: readonly ErrorLogEntry[] = ErrorLog._entries): string {
        return entries
            .map((e) => {
                const head = `[${new Date(e.time).toISOString()}] (${e.source}) ${e.message}`;
                return e.details ? `${head}\n${e.details}` : head;
            })
            .join("\n\n");
    }

    /** Idempotent: log `displayError` and uncaught errors. */
    static install(): void {
        if (ErrorLog._installed) return;
        ErrorLog._installed = true;
        PubSub.default.sub("displayError", (message) => void ErrorLog.report(message));
        if (typeof window === "undefined") return;
        window.addEventListener("error", (e) => {
            const error = e.error instanceof Error ? e.error : undefined;
            ErrorLog.report(error?.message || e.message || "Uncaught error", {
                source: "uncaught",
                details: error?.stack ?? (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined),
            });
        });
        window.addEventListener("unhandledrejection", (e) => {
            const reason: unknown = e.reason;
            ErrorLog.report(reason instanceof Error ? reason.message : String(reason), {
                source: "promise",
                details: reason instanceof Error ? reason.stack : undefined,
            });
        });
    }
}
