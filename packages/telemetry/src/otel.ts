// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { SpanStatusCode } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
    type ITelemetryExporter,
    TELEMETRY_SERVICE_NAME,
    type TelemetryStartOptions,
    telemetryEndpoint,
} from "@spicy3d/core";

interface Exporter<T> {
    export(items: T[], resultCallback: (result: ExportResult) => void): void;
    shutdown(): Promise<void>;
    forceFlush?(): Promise<void>;
}

/** Whether the exporters may still send; closed on shutdown so what is queued is dropped. */
interface Gate {
    open: boolean;
}

/** `inner`, except that once `gate` is closed every batch is dropped (reported as exported). */
function gated<T>(inner: Exporter<T>, gate: Gate): Required<Exporter<T>> {
    return {
        export: (items, resultCallback) => {
            if (!gate.open) {
                resultCallback({ code: ExportResultCode.SUCCESS });
                return;
            }
            inner.export(items, resultCallback);
        },
        shutdown: () => inner.shutdown(),
        forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
    };
}

/**
 * The OpenTelemetry providers: OTLP/HTTP JSON exporters (no protobuf, no gzip) behind batch
 * processors, a resource with the service name/version, a random per-session instance id and the
 * browser/OS families. Export failures go to OTel's own (silent) error handler: never to the app.
 */
export function startOtelTelemetry(options: TelemetryStartOptions): ITelemetryExporter {
    const gate: Gate = { open: true };
    const resource = resourceFromAttributes({
        "service.name": TELEMETRY_SERVICE_NAME,
        "service.version": options.serviceVersion,
        "service.instance.id": options.instanceId,
        "browser.family": options.browser,
        "os.family": options.os,
    });
    const exporterOptions = (signal: "logs" | "traces") => ({
        url: telemetryEndpoint(options.baseUrl, signal),
        headers: options.headers,
    });
    const tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [
            new BatchSpanProcessor(gated(new OTLPTraceExporter(exporterOptions("traces")), gate)),
        ],
    });
    const loggerProvider = new LoggerProvider({
        resource,
        processors: [
            new BatchLogRecordProcessor({
                exporter: gated(new OTLPLogExporter(exporterOptions("logs")), gate),
            }),
        ],
    });
    const tracer = tracerProvider.getTracer(TELEMETRY_SERVICE_NAME, options.serviceVersion);
    const logger = loggerProvider.getLogger(TELEMETRY_SERVICE_NAME, options.serviceVersion);

    return {
        log(record) {
            if (!gate.open) return;
            logger.emit({
                timestamp: record.time,
                severityNumber: record.level === "error" ? SeverityNumber.ERROR : SeverityNumber.WARN,
                severityText: record.level.toUpperCase(),
                body: record.message,
                attributes: {
                    "log.source": record.source,
                    ...(record.stack && { "exception.stacktrace": record.stack }),
                },
            });
        },
        span(record) {
            if (!gate.open) return;
            const span = tracer.startSpan(record.name, { startTime: record.start });
            if (record.failed) span.setStatus({ code: SpanStatusCode.ERROR });
            span.end(record.end);
        },
        async flush() {
            if (!gate.open) return;
            await Promise.allSettled([tracerProvider.forceFlush(), loggerProvider.forceFlush()]);
        },
        async shutdown() {
            gate.open = false;
            await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown()]);
        },
    };
}
