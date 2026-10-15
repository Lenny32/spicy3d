// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectStorage, Observable } from "../foundation";

/** What the user configured in Settings → Telemetry. */
export interface TelemetryConfig {
    readonly enabled: boolean;
    /** The collector's OTLP/HTTP base URL; `/v1/logs` and `/v1/traces` are appended. */
    readonly url: string;
    /** Optional, sent as `Authorization: Bearer <key>` and `x-api-key: <key>`. */
    readonly key: string;
}

/** Out of the box: off, no endpoint. Nothing ships with a built-in collector. */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = { enabled: false, url: "", key: "" };

/**
 * The collector's base URL without trailing slashes, or `undefined` when `url` is not an absolute
 * http(s) URL (then nothing is ever sent).
 */
export function telemetryBaseUrl(url: string): string | undefined {
    const trimmed = url.trim();
    if (trimmed === "") return undefined;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    } catch {
        return undefined;
    }
    return trimmed.replace(/\/+$/, "");
}

/** `base` + `/v1/logs` or `/v1/traces`. */
export function telemetryEndpoint(base: string, signal: "logs" | "traces"): string {
    return `${base}/v1/${signal}`;
}

/** The request headers carrying `key`, if any. */
export function telemetryHeaders(key: string): Record<string, string> {
    const trimmed = key.trim();
    return trimmed === "" ? {} : { Authorization: `Bearer ${trimmed}`, "x-api-key": trimmed };
}

/** Whether `config` lets anything be sent: switched on and a valid URL. */
export function isTelemetryActive(config: TelemetryConfig): boolean {
    return config.enabled && telemetryBaseUrl(config.url) !== undefined;
}

/**
 * The telemetry setting of this browser (`localStorage` `spicy3d.settings.telemetry`, next to the
 * other settings). Device-level: not synced with an account and kept on sign-out. Observable
 * (`config`, replaced as a whole).
 */
export class TelemetrySettings extends Observable {
    static readonly STORAGE_KEY = "telemetry";
    // After STORAGE_KEY: static initializers run in order, and this one reads the stored value.
    static readonly current: TelemetrySettings = new TelemetrySettings();

    constructor(private readonly storage: ObjectStorage = new ObjectStorage("spicy3d", "settings")) {
        super();
        this.setPrivateValue("config", this.read());
    }

    get config(): TelemetryConfig {
        return this.getPrivateValue("config", DEFAULT_TELEMETRY_CONFIG);
    }
    set config(value: TelemetryConfig) {
        const next: TelemetryConfig = {
            enabled: value.enabled === true,
            url: String(value.url ?? "").trim(),
            key: String(value.key ?? "").trim(),
        };
        const current = this.config;
        if (current.enabled === next.enabled && current.url === next.url && current.key === next.key) return;
        try {
            this.storage.setValue(TelemetrySettings.STORAGE_KEY, next);
        } catch {
            // Storage full or blocked: the setting still applies for this session.
        }
        this.setProperty("config", next);
    }

    private read(): TelemetryConfig {
        try {
            const stored = this.storage.value<Partial<TelemetryConfig>>(
                TelemetrySettings.STORAGE_KEY,
                undefined,
            );
            return {
                enabled: stored?.enabled === true,
                url: typeof stored?.url === "string" ? stored.url : "",
                key: typeof stored?.key === "string" ? stored.key : "",
            };
        } catch {
            return DEFAULT_TELEMETRY_CONFIG;
        }
    }
}
