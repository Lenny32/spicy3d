// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
    browserFamily,
    ErrorLog,
    type ITelemetryExporter,
    Logger,
    ObjectStorage,
    Result,
    Telemetry,
    TelemetryController,
    type TelemetryLogRecord,
    type TelemetryModule,
    TelemetrySettings,
    type TelemetrySpanRecord,
    type TelemetryStartOptions,
    telemetryBaseUrl,
    telemetryMessage,
    telemetryStack,
    testTelemetryConnection,
} from "../src";

function storage() {
    return new ObjectStorage("spicy3d-test", `telemetry-${Math.random()}`);
}

class FakeExporter implements ITelemetryExporter {
    readonly logs: TelemetryLogRecord[] = [];
    readonly spans: TelemetrySpanRecord[] = [];
    flushes = 0;
    shutdowns = 0;
    log(record: TelemetryLogRecord) {
        this.logs.push(record);
    }
    span(record: TelemetrySpanRecord) {
        this.spans.push(record);
    }
    async flush() {
        this.flushes++;
    }
    async shutdown() {
        this.shutdowns++;
    }
}

/** A loader standing in for `import("@spicy3d/telemetry")`. */
function fakeModule() {
    const started: { options: TelemetryStartOptions; exporter: FakeExporter }[] = [];
    const module: TelemetryModule = {
        startOtelTelemetry: (options) => {
            const exporter = new FakeExporter();
            started.push({ options, exporter });
            return exporter;
        },
    };
    const load = rs.fn(async () => module);
    return { load, started };
}

describe("TelemetrySettings", () => {
    test("off with no URL and no key out of the box", () => {
        expect(new TelemetrySettings(storage()).config).toEqual({ enabled: false, url: "", key: "" });
    });

    test("kept next to the other settings (spicy3d.settings.telemetry) and trimmed", () => {
        const kept = new ObjectStorage("spicy3d", "settings");
        const previous = localStorage.getItem("spicy3d.settings.telemetry");
        try {
            new TelemetrySettings(kept).config = {
                enabled: true,
                url: " https://c.example.com/otlp ",
                key: " k ",
            };

            expect(JSON.parse(localStorage.getItem("spicy3d.settings.telemetry")!)).toEqual({
                enabled: true,
                url: "https://c.example.com/otlp",
                key: "k",
            });
            expect(new TelemetrySettings(kept).config.url).toBe("https://c.example.com/otlp");
        } finally {
            if (previous === null) localStorage.removeItem("spicy3d.settings.telemetry");
            else localStorage.setItem("spicy3d.settings.telemetry", previous);
        }
    });

    test.each([
        ["https://h.example.com/otlp/key/", "https://h.example.com/otlp/key"],
        ["http://localhost:4318", "http://localhost:4318"],
        ["", undefined],
        ["not a url", undefined],
        ["ftp://h.example.com", undefined],
        ["javascript:alert(1)", undefined],
    ])("base URL of %j is %j", (url, expected) => {
        expect(telemetryBaseUrl(url)).toBe(expected);
    });

    test("a long run of trailing slashes is trimmed in one linear pass (CodeQL js/polynomial-redos)", () => {
        expect(telemetryBaseUrl(`https://h.example.com/otlp${"/".repeat(100_000)}`)).toBe(
            "https://h.example.com/otlp",
        );
    });
});

describe("Telemetry", () => {
    test("without a sink, spans and logs go nowhere and read no clock", () => {
        const now = rs.spyOn(performance, "now");
        try {
            expect(Telemetry.active).toBe(false);
            Telemetry.start("body.rebuild").end();
            Telemetry.log({ level: "error", source: "app", message: "x" });
            expect(now).not.toHaveBeenCalled();
        } finally {
            now.mockRestore();
        }
    });

    test("trace records the operation once, failed when it throws or returns an error Result", async () => {
        const sink = new FakeExporter();
        const detach = Telemetry.attach(sink);
        try {
            await Telemetry.trace("file.import", async () => 1);
            await Telemetry.trace("document.save", async () => Result.err("no"));
            await expect(
                Telemetry.trace("file.export", async () => Promise.reject(new Error("x"))),
            ).rejects.toThrow("x");
            const span = Telemetry.start("body.rebuild");
            span.end();
            span.end(true);

            expect(sink.spans.map((x) => [x.name, x.failed])).toEqual([
                ["file.import", false],
                ["document.save", true],
                ["file.export", true],
                ["body.rebuild", false],
            ]);
            expect(sink.spans[0].end).toBeGreaterThanOrEqual(sink.spans[0].start);
        } finally {
            detach();
        }
        expect(Telemetry.active).toBe(false);
    });

    test("log redacts what it sends", () => {
        const sink = new FakeExporter();
        const detach = Telemetry.attach(sink);
        try {
            Telemetry.log({
                level: "warn",
                source: "logger",
                message: 'Cannot open "Secret plan" from https://h.example.com/a?token=abc',
                stack: "Error: bracket.step failed\n    at x (https://app.example.com/main.js?v=1:1:2)",
            });
        } finally {
            detach();
        }
        expect(sink.logs[0].message).toBe('Cannot open "•••" from https://h.example.com/a?•••');
        expect(sink.logs[0].stack).toBe("Error: ••• failed\n    at x (https://app.example.com/main.js?•••)");
    });
});

describe("telemetry privacy", () => {
    test.each([
        ["Import of C:\\Users\\ann\\part.step failed", "Import of ••• failed"],
        ["read /home/ann/models/x failed", "read ••• failed"],
        ["value 'hello' is invalid", "value '•••' is invalid"],
        ["Bearer abc.def", "Bearer •••"],
        ["shape is null", "shape is null"],
    ])("telemetryMessage(%j)", (input, expected) => {
        expect(telemetryMessage(input)).toBe(expected);
    });

    test("messages and stacks are capped", () => {
        expect(telemetryMessage("x".repeat(5000)).length).toBe(1001);
        expect(telemetryStack(`m\n${"    at f (a.js:1:1)\n".repeat(1000)}`).length).toBe(4001);
    });

    test("huge uncontrolled text is cut before the patterns run", () => {
        // Path-like text without an extension makes the file-name pattern backtrack from every start.
        const adversarial = "a.b/".repeat(250_000);
        const started = performance.now();
        expect(telemetryMessage(adversarial).length).toBe(1001);
        // One line: the whole "stack" is its first line, which is capped like a message.
        expect(telemetryStack(adversarial).length).toBe(1001);
        expect(telemetryStack(`Error: x\n${adversarial}`).length).toBe(4001);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test.each([
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
            { browser: "Chrome", os: "Windows" },
        ],
        [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            { browser: "Safari", os: "macOS" },
        ],
        [
            "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
            { browser: "Firefox", os: "Linux" },
        ],
        [
            "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
            { browser: "Edge", os: "Windows" },
        ],
        [
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36",
            { browser: "Chrome", os: "Linux" },
        ],
        ["curl/8", { browser: "Other", os: "Other" }],
    ])("browserFamily(%j)", (userAgent, expected) => {
        expect(browserFamily(userAgent)).toEqual(expected);
    });
});

describe("testTelemetryConnection", () => {
    function fetchAnswering(response: Response | Error) {
        return rs.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
            if (response instanceof Error) throw response;
            return response;
        });
    }

    test("posts one JSON log record to <url>/v1/logs with the key headers; 2xx is a success", async () => {
        const fetch = fetchAnswering(new Response(null, { status: 204 }));

        const result = await testTelemetryConnection(
            { url: "https://h.example.com/otlp/abc/", key: "k1" },
            "1.2.3",
            fetch,
        );

        expect(result.isOk).toBe(true);
        expect(result.value).toBe(204);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe("https://h.example.com/otlp/abc/v1/logs");
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("omit");
        expect(init?.headers).toEqual({
            "Content-Type": "application/json",
            Authorization: "Bearer k1",
            "x-api-key": "k1",
        });
        const body = JSON.parse(String(init?.body));
        expect(body.resourceLogs[0].resource.attributes).toContainEqual({
            key: "service.name",
            value: { stringValue: "spicy3d" },
        });
        expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
    });

    test("no key, no auth headers", async () => {
        const fetch = fetchAnswering(new Response(null, { status: 200 }));
        await testTelemetryConnection({ url: "https://h.example.com", key: "" }, "1", fetch);
        expect(fetch.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json" });
    });

    test("another status is a failure carrying it", async () => {
        const result = await testTelemetryConnection(
            { url: "https://h.example.com", key: "" },
            "1",
            fetchAnswering(new Response(null, { status: 401, statusText: "Unauthorized" })),
        );
        expect(result.isOk).toBe(false);
        expect(result.error).toEqual({ status: 401, message: "Unauthorized" });
    });

    test("a network error is a failure carrying its message", async () => {
        const result = await testTelemetryConnection(
            { url: "https://h.example.com", key: "" },
            "1",
            fetchAnswering(new TypeError("Failed to fetch")),
        );
        expect(result.error).toEqual({ message: "Failed to fetch" });
    });

    test("an invalid URL sends nothing", async () => {
        const fetch = fetchAnswering(new Response(null));
        const result = await testTelemetryConnection({ url: "nope", key: "" }, "1", fetch);
        expect(result.error).toEqual({ message: "invalid-url" });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("TelemetryController", () => {
    let controller: TelemetryController | undefined;
    afterEach(() => {
        controller?.dispose();
        controller = undefined;
        rs.unstubAllGlobals();
    });

    test("with the default settings nothing is loaded and no request is made", async () => {
        const fetch = rs.fn(async () => new Response(null));
        rs.stubGlobal("fetch", fetch);
        const { load } = fakeModule();
        controller = new TelemetryController(new TelemetrySettings(storage()), load, "1.0.0");

        controller.start();
        await controller.ready;
        Logger.error("an error");
        ErrorLog.report("a toast");

        expect(load).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(controller.isRunning).toBe(false);
        expect(Telemetry.active).toBe(false);
    });

    test("switched on without a URL, still nothing is loaded", async () => {
        const settings = new TelemetrySettings(storage());
        settings.config = { enabled: true, url: "", key: "" };
        const { load } = fakeModule();
        controller = new TelemetryController(settings, load, "1.0.0");

        controller.start();
        await controller.ready;

        expect(load).not.toHaveBeenCalled();
    });

    test("on with a URL: loaded once, fed with warnings, errors and spans; off stops it without a reload", async () => {
        const error = rs.spyOn(console, "error").mockImplementation(() => {});
        const warn = rs.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const settings = new TelemetrySettings(storage());
            const { load, started } = fakeModule();
            controller = new TelemetryController(settings, load, "9.9.9");
            controller.start();

            settings.config = { enabled: true, url: "https://h.example.com/otlp/", key: "k" };
            await controller.ready;

            expect(load).toHaveBeenCalledTimes(1);
            const { options, exporter } = started[0];
            expect(options).toMatchObject({
                baseUrl: "https://h.example.com/otlp",
                headers: { Authorization: "Bearer k", "x-api-key": "k" },
                serviceVersion: "9.9.9",
            });
            expect(options.instanceId).toMatch(/^[0-9a-f-]{36}$/);

            Logger.warn("careful");
            Logger.error("failed", new Error("boom"));
            ErrorLog.report("uncaught thing", {
                source: "uncaught",
                details: "Error: uncaught thing\n at f",
            });
            Telemetry.start("file.export").end();

            expect(exporter.logs.map((x) => [x.level, x.source, x.message])).toEqual([
                ["warn", "logger", "careful"],
                ["error", "logger", "failed"],
                ["error", "uncaught", "uncaught thing"],
            ]);
            expect(exporter.logs[1].stack).toContain("boom");
            expect(exporter.spans.map((x) => x.name)).toEqual(["file.export"]);

            settings.config = { enabled: false, url: "https://h.example.com/otlp/", key: "k" };

            expect(exporter.shutdowns).toBe(1);
            expect(controller.isRunning).toBe(false);
            expect(Telemetry.active).toBe(false);
            Logger.error("after");
            expect(exporter.logs).toHaveLength(3);
        } finally {
            error.mockRestore();
            warn.mockRestore();
        }
    });

    test("clearing the URL or changing the endpoint shuts the running providers down", async () => {
        const settings = new TelemetrySettings(storage());
        settings.config = { enabled: true, url: "https://a.example.com", key: "" };
        const { load, started } = fakeModule();
        controller = new TelemetryController(settings, load, "1");
        controller.start();
        await controller.ready;

        settings.config = { enabled: true, url: "https://b.example.com", key: "" };
        await controller.ready;
        expect(started[0].exporter.shutdowns).toBe(1);
        expect(started[1].options.baseUrl).toBe("https://b.example.com");
        expect(started[1].options.instanceId).toBe(started[0].options.instanceId);

        settings.config = { enabled: true, url: "", key: "" };
        expect(started[1].exporter.shutdowns).toBe(1);
        expect(controller.isRunning).toBe(false);
    });

    test("turned off while the chunk loads, it never starts", async () => {
        const settings = new TelemetrySettings(storage());
        const { load, started } = fakeModule();
        controller = new TelemetryController(settings, load, "1");
        controller.start();

        settings.config = { enabled: true, url: "https://a.example.com", key: "" };
        const loading = controller.ready;
        settings.config = { enabled: false, url: "https://a.example.com", key: "" };
        await loading;

        expect(started).toHaveLength(0);
        expect(Telemetry.active).toBe(false);
    });

    test("a chunk that fails to load leaves the app alone", async () => {
        const settings = new TelemetrySettings(storage());
        settings.config = { enabled: true, url: "https://a.example.com", key: "" };
        const load = rs.fn(async (): Promise<TelemetryModule> => {
            throw new Error("offline");
        });
        controller = new TelemetryController(settings, load, "1");

        controller.start();
        await controller.ready;

        expect(load).toHaveBeenCalledTimes(1);
        expect(controller.isRunning).toBe(false);
    });

    test("hiding the page flushes", async () => {
        const settings = new TelemetrySettings(storage());
        settings.config = { enabled: true, url: "https://a.example.com", key: "" };
        const { load, started } = fakeModule();
        controller = new TelemetryController(settings, load, "1");
        controller.start();
        await controller.ready;

        window.dispatchEvent(new Event("pagehide"));
        const visibility = rs.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        try {
            window.dispatchEvent(new Event("pagehide"));
            document.dispatchEvent(new Event("visibilitychange"));
        } finally {
            visibility.mockRestore();
        }

        expect(started[0].exporter.flushes).toBe(2);
    });
});

test("the shared settings read the stored value at startup", async () => {
    localStorage.setItem(
        "spicy3d.settings.telemetry",
        JSON.stringify({ enabled: true, url: "https://c.example.com", key: "" }),
    );
    try {
        rs.resetModules();
        const fresh = await import("../src/telemetry/telemetrySettings");
        expect(fresh.TelemetrySettings.current.config).toEqual({
            enabled: true,
            url: "https://c.example.com",
            key: "",
        });
    } finally {
        localStorage.removeItem("spicy3d.settings.telemetry");
    }
});
