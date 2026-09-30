// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// node packages/wasm/test/browser/run-worker-smoke.mjs [temporary-parent]
// Builds the actual bundler-owned Worker, serves under deployment CSP, no DOM or WASM mocks.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { rspack } from "@rspack/core";
import { chromium, firefox } from "playwright";

const root = path.resolve(import.meta.dirname, "../../../..");
const output = await mkdtemp(path.join(process.argv[2] ?? tmpdir(), "spicy3d-worker-"));
const template = await readFile(path.join(root, "docker/default.conf.template"), "utf8");
const csp = /add_header Content-Security-Policy "([^"]+)"/
    .exec(template)[1]
    .replace(/\$\{SPICY3D_(?:PLUGIN|CONNECT)_ORIGINS\}/g, "");
const compiler = rspack({
    mode: "production",
    context: root,
    entry: path.join(import.meta.dirname, "workerSmoke.ts"),
    output: { path: output, filename: "main.js", clean: true },
    resolve: { extensions: [".ts", ".js"] },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: "builtin:swc-loader",
                options: {
                    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
                },
            },
            { test: /\.wasm$/, type: "asset/resource" },
        ],
    },
});
let server;
try {
    await new Promise((resolve, reject) =>
        compiler.run((error, stats) => {
            if (error || stats.hasErrors())
                reject(error ?? new Error(stats.toString({ all: false, errors: true })));
            else resolve();
        }),
    );
    await new Promise((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    server = createServer(async (request, response) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        response.setHeader("Content-Security-Policy", csp);
        if (pathname === "/") {
            response.setHeader("Content-Type", "text/html");
            response.end(
                '<!doctype html><title>Worker kernel smoke</title><button id="input-probe">Input</button><script src="/main.js"></script>',
            );
            return;
        }
        const file = path.resolve(output, `.${decodeURIComponent(pathname)}`);
        if (
            !file.startsWith(`${output}${path.sep}`) ||
            !(await stat(file).catch(() => undefined))?.isFile()
        ) {
            response.writeHead(404).end();
            return;
        }
        response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const browserType of [chromium, firefox]) {
        const browser = await browserType.launch({ headless: true });
        const timeout = setTimeout(() => browser.close(), 120_000);
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const errors = [];
            const foreign = [];
            page.on("pageerror", (error) => errors.push(error.message));
            context.on("request", (request) => {
                if (new URL(request.url()).origin !== origin) foreign.push(request.url());
            });
            await context.route("**/*", (route) =>
                new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
            );
            await page.goto(origin);
            const running = page.evaluate(() => globalThis.workerSmoke());
            // If setup fails before busy=true, surface that error instead of waiting for the input timeout.
            await Promise.race([
                running,
                page.waitForFunction(() => document.documentElement.dataset.workerBusy === "true"),
            ]);
            await page.locator("#input-probe").click();
            const report = await running;
            assert.deepEqual(errors, []);
            assert.deepEqual(foreign, []);
            console.log(
                JSON.stringify({ browser: browserType.name(), version: browser.version(), ...report }),
            );
        } finally {
            clearTimeout(timeout);
            await browser.close();
        }
    }
} finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(output, { recursive: true, force: true });
}
