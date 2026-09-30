// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Builds the ACTUAL application entry + a probe in one module graph. Read-only Mouse Bottom test.
// node packages/wasm/test/browser/run-app-worker-smoke.mjs <model> <baseline.json.gz> <temp-parent> [main|hybrid|both] [all-sketches]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { rspack } from "@rspack/core";
import { firefox } from "playwright";

const root = path.resolve(import.meta.dirname, "../../../..");
const [modelPath, baselinePath, parent, requestedMode = "hybrid", allSketches] = process.argv.slice(2);
assert.ok(["main", "hybrid", "both"].includes(requestedMode), "unknown kernel mode");
assert.ok(modelPath && baselinePath && parent, "model, pristine baseline and temporary parent are required");
const model = await readFile(modelPath);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fingerprint(folder, include = () => true) {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .filter(include)
        .sort();
    const hashes = [];
    for (const file of files) hashes.push(`${file}:${hash(await readFile(path.join(folder, file)))}`);
    return hash(hashes.join("\n"));
}
const sourceFingerprint = () =>
    fingerprint(
        path.join(root, "packages"),
        (file) => file.includes("/src/") || file.includes("/test/browser/"),
    );
const sourceHash = await sourceFingerprint();
assert.equal(hash(model), "9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569");
const baselineBytes = await readFile(baselinePath);
const baseline = JSON.parse(baselinePath.endsWith(".gz") ? gunzipSync(baselineBytes) : baselineBytes).before;
const output = await mkdtemp(path.join(parent, "spicy3d-worker-app-"));
const config = (await import(pathToFileURL(path.join(root, "rspack.config.ts")))).default;
const compiler = rspack({
    ...config,
    context: root,
    entry: {
        main: ["./packages/web/src/index.ts", "./packages/wasm/test/browser/workerAppProbe.ts"],
    },
    output: { ...config.output, path: output },
});
const template = await readFile(path.join(root, "docker/default.conf.template"), "utf8");
const csp = /add_header Content-Security-Policy "([^"]+)"/
    .exec(template)[1]
    .replace(/\$\{SPICY3D_(?:PLUGIN|CONNECT)_ORIGINS\}/g, "");
let server;
let browser;
let timeout;
let mode = "main";
const reports = [];
const evidencePath = path.join(parent, `worker-performance-${randomUUID()}.json`);
try {
    await new Promise((resolve, reject) =>
        compiler.run((error, stats) => {
            if (error || stats.hasErrors())
                reject(error ?? new Error(stats.toString({ all: false, errors: true })));
            else resolve();
        }),
    );
    server = createServer(async (request, response) => {
        response.setHeader("Content-Security-Policy", csp);
        if (request.method !== "GET") return response.writeHead(405).end();
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (pathname === "/worker-test-model") return response.end(model);
        if (pathname === "/deployment.json") {
            response.setHeader("Content-Type", "application/json");
            return response.end(
                JSON.stringify(mode === "hybrid" ? { performance: { geometryWorker: true } } : {}),
            );
        }
        const file = path.resolve(
            output,
            `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`,
        );
        if (
            !file.startsWith(`${output}${path.sep}`) ||
            !(await stat(file).catch(() => undefined))?.isFile()
        ) {
            response.writeHead(404).end();
            return;
        }
        const types = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".wasm": "application/wasm",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
        };
        response.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await firefox.launch({ headless: true });
    const buildHash = await fingerprint(output);
    for (mode of requestedMode === "both" ? ["main", "hybrid"] : [requestedMode]) {
        timeout = setTimeout(() => browser.close(), 300_000);
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
        await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin && route.request().method() === "GET"
                ? route.continue()
                : route.abort(),
        );
        await context.addInitScript(() => {
            globalThis.workerTestMemories = [];
            for (const method of ["instantiate", "instantiateStreaming"]) {
                const original = WebAssembly[method];
                WebAssembly[method] = async function (...args) {
                    const result = await original.apply(this, args);
                    for (const value of Object.values((result.instance ?? result).exports)) {
                        if (
                            value instanceof WebAssembly.Memory &&
                            !globalThis.workerTestMemories.includes(value)
                        )
                            globalThis.workerTestMemories.push(value);
                    }
                    return result;
                };
            }
            const refuse = () => {
                throw new Error("Application smoke blocked persistent write");
            };
            globalThis.showSaveFilePicker = refuse;
            if (globalThis.FileSystemFileHandle) FileSystemFileHandle.prototype.createWritable = refuse;
            HTMLAnchorElement.prototype.click = refuse;
            for (const method of ["add", "put", "delete", "clear"]) IDBObjectStore.prototype[method] = refuse;
            Storage.prototype.setItem = () => {};
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(
            () => {
                try {
                    return !!globalThis.Spicy3DCore?.getCurrentApplication();
                } catch {
                    return false;
                }
            },
            undefined,
            { timeout: 60_000 },
        );
        const running = page.evaluate((options) => globalThis.workerApplicationSmoke(options), {
            baseline,
            mode,
            allSketches: allSketches === "all-sketches",
        });
        if (mode === "hybrid") {
            await Promise.race([
                running,
                page.waitForFunction(
                    () => globalThis.Spicy3DWorkerProfile?.snapshot().pendingNative > 0,
                    undefined,
                    {
                        timeout: 60_000,
                    },
                ),
            ]);
            await page.locator("#worker-input-probe").click();
        }
        const report = await running;
        assert.deepEqual(errors, []);
        assert.equal(hash(await readFile(modelPath)), hash(model));
        assert.equal(await sourceFingerprint(), sourceHash, "Source changed during the isolated build/run");
        if (reports.length)
            assert.equal(report.trackedIdsHash, reports[0].trackedIdsHash, "Stable ids differ between modes");
        reports.push(report);
        console.log(
            JSON.stringify({
                browser: "firefox",
                version: browser.version(),
                modelHashUnchanged: true,
                sourceHash,
                buildHash,
                ...report,
            }),
        );
        clearTimeout(timeout);
        await context.close();
    }
    await writeFile(
        evidencePath,
        JSON.stringify(
            {
                sourceHash,
                buildHash,
                baselineHash: hash(baselineBytes),
                modelHash: hash(model),
                browser: browser.version(),
                reports,
            },
            null,
            2,
        ),
        { flag: "wx" },
    );
    console.log(`Evidence: ${evidencePath}`);
} finally {
    clearTimeout(timeout);
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => compiler.close(resolve));
    await rm(output, { recursive: true, force: true });
}
