// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Real app startup, installed default fresh-module recovery, and actual Recover button.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rspack } from "@rspack/core";
import { chromium, firefox } from "playwright";

const root = path.resolve(import.meta.dirname, "../../../..");
const output = await mkdtemp(path.join(tmpdir(), "spicy3d-recovery-"));
const config = (await import(pathToFileURL(path.join(root, "rspack.config.ts")))).default;
const aliases = Object.fromEntries(
    (await readdir(path.join(root, "packages"))).map((name) => [
        `@spicy3d/${name}`,
        path.join(root, "packages", name),
    ]),
);
const compiler = rspack({
    ...config,
    context: root,
    entry: { main: ["./packages/web/src/index.ts", "./packages/wasm/test/browser/kernelRecoveryProbe.ts"] },
    output: { ...config.output, path: output },
    resolve: { ...config.resolve, alias: { ...config.resolve?.alias, ...aliases } },
    plugins: config.plugins.filter((plugin) => plugin.constructor.name !== "TsCheckerRspackPlugin"),
});
const template = await readFile(path.join(root, "docker/default.conf.template"), "utf8");
const csp = /add_header Content-Security-Policy "([^"]+)"/
    .exec(template)[1]
    .replace(/\$\{SPICY3D_(?:PLUGIN|CONNECT)_ORIGINS\}/g, "");
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
        response.setHeader("Content-Security-Policy", csp);
        const pathname = new URL(request.url, "http://localhost").pathname;
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
    for (const browserType of [chromium, firefox]) {
        const browser = await browserType.launch({ headless: true });
        const deadline = setTimeout(() => browser.close(), 120_000);
        try {
            const context = await browser.newContext({ serviceWorkers: "block" });
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await context.route("**/*", (route) =>
                new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
            );
            await page.goto(origin);
            await page.waitForFunction(
                () => globalThis.Spicy3DCore?.KernelRecovery.current.available,
                undefined,
                { timeout: 60_000 },
            );
            const running = page.evaluate(() => globalThis.kernelRecoverySmoke());
            await Promise.race([
                running,
                page.waitForFunction(() => document.documentElement.dataset.recoveryReady === "true"),
            ]);
            await page.getByRole("button", { name: "Recover geometry", exact: true }).click();
            const report = await running;
            assert.deepEqual(errors, []);
            console.log(
                JSON.stringify({ browser: browserType.name(), version: browser.version(), ...report }),
            );
        } finally {
            clearTimeout(deadline);
            await browser.close();
        }
    }
} finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(output, { recursive: true, force: true });
}
