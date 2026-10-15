// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import {
    type TelemetryConfig,
    telemetryBaseUrl,
    telemetryEndpoint,
    telemetryHeaders,
} from "./telemetrySettings";

export const TELEMETRY_SERVICE_NAME = "spicy3d";
const TEST_TIMEOUT_MS = 10_000;

/** Why a connection test failed: the collector's HTTP status, or a network/URL error. */
export interface TelemetryTestFailure {
    readonly status?: number;
    readonly message: string;
}

function attribute(key: string, value: string) {
    return { key, value: { stringValue: value } };
}

/** One OTLP/HTTP JSON log record saying it is a connection test (no data about the user). */
export function telemetryTestPayload(serviceVersion: string, time = Date.now()): object {
    return {
        resourceLogs: [
            {
                resource: {
                    attributes: [
                        attribute("service.name", TELEMETRY_SERVICE_NAME),
                        attribute("service.version", serviceVersion),
                    ],
                },
                scopeLogs: [
                    {
                        scope: { name: TELEMETRY_SERVICE_NAME, version: serviceVersion },
                        logRecords: [
                            {
                                timeUnixNano: `${Math.floor(time)}000000`,
                                severityNumber: 9,
                                severityText: "INFO",
                                body: { stringValue: "Spicy3D telemetry connection test" },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

/**
 * Settings → Telemetry → Test connection: POSTs one small log record to `<url>/v1/logs` with the
 * configured key, whether telemetry is switched on or not (the user asked for it). Ok = a 2xx
 * status; otherwise the status, or the network error (CORS, DNS, a CSP refusal look alike).
 */
export async function testTelemetryConnection(
    config: Pick<TelemetryConfig, "url" | "key">,
    serviceVersion: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Result<number, TelemetryTestFailure>> {
    const base = telemetryBaseUrl(config.url);
    if (!base) return Result.err({ message: "invalid-url" });
    try {
        const response = await fetchImpl(telemetryEndpoint(base, "logs"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...telemetryHeaders(config.key) },
            body: JSON.stringify(telemetryTestPayload(serviceVersion)),
            signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
            credentials: "omit",
        });
        if (response.status >= 200 && response.status <= 299) return Result.ok(response.status);
        return Result.err({ status: response.status, message: response.statusText });
    } catch (error) {
        return Result.err({ message: error instanceof Error ? error.message : String(error) });
    }
}
