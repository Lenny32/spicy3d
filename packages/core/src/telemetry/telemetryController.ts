// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ErrorLog, type ErrorLogEntry } from "../errorLog";
import { Logger } from "../foundation/logger";
import { type ITelemetrySink, Telemetry } from "./telemetry";
import { browserFamily } from "./telemetryPrivacy";
import {
    isTelemetryActive,
    type TelemetrySettings,
    telemetryBaseUrl,
    telemetryHeaders,
} from "./telemetrySettings";

/** What the OTel half gets to start its providers. */
export interface TelemetryStartOptions {
    /** The collector's base URL (`/v1/logs`, `/v1/traces` are appended). */
    readonly baseUrl: string;
    readonly headers: Record<string, string>;
    readonly serviceVersion: string;
    /** Random per session (never persisted). */
    readonly instanceId: string;
    readonly browser: string;
    readonly os: string;
}

/** The running OTel providers (`@spicy3d/telemetry`). */
export interface ITelemetryExporter extends ITelemetrySink {
    /** Sends what is queued now (the page is being hidden). Never rejects. */
    flush(): Promise<void>;
    /** Stops at once: what is still queued is dropped, not sent. Never rejects. */
    shutdown(): Promise<void>;
}

export interface TelemetryModule {
    startOtelTelemetry(options: TelemetryStartOptions): ITelemetryExporter;
}

/** Loads the OTel half; a dynamic `import()`, so the SDK is fetched only once telemetry is on. */
export type TelemetryLoader = () => Promise<TelemetryModule>;

interface Running {
    readonly exporter: ITelemetryExporter;
    readonly stop: () => void;
}

/**
 * Applies `TelemetrySettings` live: telemetry on with a valid URL → the OTel half is loaded and
 * fed (the app's warnings and errors, uncaught errors, rejected promises, `Telemetry` spans);
 * anything else → nothing is loaded and nothing sent. Turning it off, clearing the URL or changing
 * the endpoint shuts the providers down at once and drops what was queued.
 */
export class TelemetryController {
    /** The configuration running (or loading): `url\nkey`, undefined while off. */
    private activeKey: string | undefined;
    private generation = 0;
    private running: Running | undefined;
    private started = false;
    private readonly instanceId = randomInstanceId();

    constructor(
        private readonly settings: TelemetrySettings,
        private readonly load: TelemetryLoader,
        private readonly serviceVersion: string,
    ) {}

    /** Whether the OTel providers are running. */
    get isRunning(): boolean {
        return this.running !== undefined;
    }

    /** Resolves once the current configuration is applied (for tests and the settings UI). */
    ready: Promise<void> = Promise.resolve();

    start(): void {
        if (this.started) return;
        this.started = true;
        this.settings.onPropertyChanged(this.onSettingsChanged);
        this.apply();
    }

    dispose(): void {
        if (!this.started) return;
        this.started = false;
        this.settings.removePropertyChanged(this.onSettingsChanged);
        this.stop();
    }

    private readonly onSettingsChanged = () => this.apply();

    private apply(): void {
        const config = this.settings.config;
        const base = telemetryBaseUrl(config.url);
        const key = isTelemetryActive(config) && base ? `${base}\n${config.key}` : undefined;
        if (key === this.activeKey) return;
        this.stop();
        if (key === undefined || base === undefined) return;
        this.activeKey = key;
        const generation = this.generation;
        const headers = telemetryHeaders(config.key);
        this.ready = this.load().then(
            (module) => {
                if (generation !== this.generation) return;
                this.run(module, { baseUrl: base, headers });
            },
            () => {
                // The chunk could not be loaded (offline, CSP): no telemetry, quietly.
            },
        );
    }

    private run(module: TelemetryModule, endpoint: Pick<TelemetryStartOptions, "baseUrl" | "headers">) {
        const family = browserFamily(typeof navigator === "undefined" ? "" : navigator.userAgent);
        let exporter: ITelemetryExporter;
        try {
            exporter = module.startOtelTelemetry({
                ...endpoint,
                serviceVersion: this.serviceVersion,
                instanceId: this.instanceId,
                browser: family.browser,
                os: family.os,
            });
        } catch {
            return;
        }
        const stops = [
            Telemetry.attach(exporter),
            Logger.addListener(onLogged),
            ErrorLog.subscribe(onErrorLogged),
            listen(this.flushOnHide(exporter)),
        ];
        ErrorLog.install();
        this.running = { exporter, stop: () => stops.forEach((stop) => stop()) };
    }

    private flushOnHide(exporter: ITelemetryExporter) {
        return () => {
            if (document.visibilityState === "hidden") void exporter.flush();
        };
    }

    private stop(): void {
        this.generation++;
        this.activeKey = undefined;
        const running = this.running;
        this.running = undefined;
        if (!running) return;
        running.stop();
        void running.exporter.shutdown();
    }
}

/**
 * A random UUID (v4 form) for `service.instance.id`. Not `crypto.randomUUID()`: that only exists in
 * secure contexts, and the app also runs over plain HTTP on a LAN, where this is created at startup.
 */
export function randomInstanceId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function listen(onHide: () => void): () => void {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
        document.removeEventListener("visibilitychange", onHide);
        window.removeEventListener("pagehide", onHide);
    };
}

function onLogged(level: "warn" | "error", message: unknown, params: readonly unknown[]) {
    const error = [message, ...params].find((value): value is Error => value instanceof Error);
    const text =
        typeof message === "string" ? message : message instanceof Error ? message.message : "(no message)";
    Telemetry.log({ level, source: "logger", message: text, stack: error?.stack });
}

function onErrorLogged(entry: ErrorLogEntry | undefined) {
    if (!entry) return;
    Telemetry.log({ level: "error", source: entry.source, message: entry.message, stack: entry.details });
}
