// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "@rstest/core";
import type { TelemetryStartOptions } from "@spicy3d/core";
import { startOtelTelemetry } from "../src";

interface Sent {
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: any;
}

/**
 * A local OTLP/HTTP collector. Under test the exporters' Node build runs (http module); the
 * browser build differs only in its transport (fetch), the requests are the same.
 */
async function collector(status = 200) {
    const sent: Sent[] = [];
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            sent.push({
                path: request.url ?? "",
                headers: request.headers,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
            response.writeHead(status).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const options: TelemetryStartOptions = {
        baseUrl: `http://127.0.0.1:${port}/otlp/abc`,
        headers: { Authorization: "Bearer k", "x-api-key": "k" },
        serviceVersion: "1.2.3",
        instanceId: "11111111-2222-4333-8444-555555555555",
        browser: "Firefox",
        os: "Linux",
    };
    return { sent, options };
}

const servers: Server[] = [];

function attributes(list: { key: string; value: Record<string, unknown> }[]) {
    return Object.fromEntries(list.map((x) => [x.key, Object.values(x.value)[0]]));
}

describe("startOtelTelemetry", () => {
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((x) => new Promise((resolve) => x.close(resolve))));
    });

    test("logs and spans go as OTLP/HTTP JSON to <url>/v1/logs and /v1/traces with the key headers", async () => {
        const { sent, options } = await collector();
        const telemetry = startOtelTelemetry(options);

        telemetry.log({
            level: "error",
            source: "uncaught",
            message: "boom",
            stack: "Error: boom\n    at f (main.js:1:1)",
            time: Date.now(),
        });
        const start = Date.now();
        telemetry.span({ name: "file.import", start, end: start + 250, failed: true });
        await telemetry.flush();

        const logs = sent.find((x) => x.path === "/otlp/abc/v1/logs");
        const traces = sent.find((x) => x.path === "/otlp/abc/v1/traces");
        expect(logs).toBeTruthy();
        expect(traces).toBeTruthy();
        for (const request of [logs!, traces!]) {
            expect(request.headers["content-type"]).toBe("application/json");
            expect(request.headers["content-encoding"]).toBeUndefined();
            expect(request.headers["authorization"]).toBe("Bearer k");
            expect(request.headers["x-api-key"]).toBe("k");
        }

        const resourceLogs = logs!.body.resourceLogs[0];
        expect(attributes(resourceLogs.resource.attributes)).toMatchObject({
            "service.name": "spicy3d",
            "service.version": "1.2.3",
            "service.instance.id": options.instanceId,
            "browser.family": "Firefox",
            "os.family": "Linux",
        });
        const record = resourceLogs.scopeLogs[0].logRecords[0];
        expect(record.body.stringValue).toBe("boom");
        expect(record.severityText).toBe("ERROR");
        expect(attributes(record.attributes)).toEqual({
            "log.source": "uncaught",
            "exception.stacktrace": "Error: boom\n    at f (main.js:1:1)",
        });

        const span = traces!.body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.name).toBe("file.import");
        expect(span.status.code).toBe(2);
        const durationNs = BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano);
        expect(durationNs).toBe(250_000_000n);

        await telemetry.shutdown();
    });

    test("shutdown drops what is queued and nothing is sent afterwards", async () => {
        const { sent, options } = await collector();
        const telemetry = startOtelTelemetry(options);

        telemetry.log({ level: "warn", source: "logger", message: "queued", time: Date.now() });
        telemetry.span({ name: "body.rebuild", start: Date.now(), end: Date.now() + 1, failed: false });
        await telemetry.shutdown();
        telemetry.log({ level: "warn", source: "logger", message: "late", time: Date.now() });
        await telemetry.flush();

        expect(sent).toEqual([]);
    });

    test("a collector that refuses never throws into the app", async () => {
        const { sent, options } = await collector(400);
        const telemetry = startOtelTelemetry(options);

        telemetry.log({ level: "error", source: "app", message: "x", time: Date.now() });
        await expect(telemetry.flush()).resolves.toBeUndefined();
        await expect(telemetry.shutdown()).resolves.toBeUndefined();
        expect(sent).toHaveLength(1);
    });
});
