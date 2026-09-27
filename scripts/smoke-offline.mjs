// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Offline smoke test of the production build (CLOUD-16): serves dist/ like the web image (SPA
 * routes, docker/default.conf.template's Content-Security-Policy), opens it in headless Chromium with every
 * request to another origin blocked, and checks that
 *
 *   1. the app starts and the OCCT WebAssembly kernel works (a box is built),
 *   2. a document saved to the browser's storage opens again with its content,
 *   3. nothing ever asked for another origin (a LAN without internet access sees no failed request),
 *   4. over plain HTTP on a non-loopback host the insecure-context banner shows, and not on localhost,
 *   5. a `.spicyplugin` whose entry uses its import map loads (blob: module, no inline import map).
 *
 * With --url it checks a running deployment instead (the dev server proxying a SpicySrv, or the
 * server's compose stack; certificate errors of an internal CA are ignored): 1–3, the banner
 * matching that URL, and with --expect-server that a Spicy3D server was found (account button).
 *
 *   npm run build && npx playwright install chromium-headless-shell && npm run smoke
 *   node scripts/smoke-offline.mjs [--dist <folder>] [--no-csp] [--headed]
 *   node scripts/smoke-offline.mjs --url https://spicy.lan/ [--expect-server] [--map-host <name>]
 *
 * --map-host resolves that name to 127.0.0.1 in the browser (e.g. a Caddy on this machine
 * serving https://spicy.lan).
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import JSZip from "jszip";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
    options: {
        dist: { type: "string", default: path.join(rootDir, "dist") },
        url: { type: "string" },
        "expect-server": { type: "boolean", default: false },
        "map-host": { type: "string" },
        "no-csp": { type: "boolean", default: false },
        headed: { type: "boolean", default: false },
    },
});
const distDir = path.resolve(args.dist);
if (!args.url && !existsSync(path.join(distDir, "index.html"))) {
    console.error(`no build in ${distDir}: run \`npm run build\` first`);
    process.exit(2);
}

// The policy the web image sends (docker/default.conf.template), so a directive the app outgrows fails here.
// SPICY3D_PLUGIN_ORIGINS and SPICY3D_CONNECT_ORIGINS as the image's defaults: empty.
const nginxConf = readFileSync(path.join(rootDir, "docker/default.conf.template"), "utf8");
const CSP = /add_header Content-Security-Policy "([^"]+)"/
    .exec(nginxConf)?.[1]
    .replaceAll("${SPICY3D_PLUGIN_ORIGINS}", "")
    .replaceAll("${SPICY3D_CONNECT_ORIGINS}", "")
    .replace(/ {2,}/g, " ")
    .replace(/ +;/g, ";");
if (!CSP) {
    console.error("docker/default.conf.template sends no Content-Security-Policy");
    process.exit(2);
}
// A name that is not loopback: plain HTTP there is not a secure context (resolved to 127.0.0.1 below).
const LAN_HOST = "spicy.lan";
const STARTUP_TIMEOUT_MS = 120_000;
const BANNER = '[data-banner-id="app.insecureContext"]';

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".cur": "image/x-icon",
    ".tgz": "application/gzip",
};
const APP_ROUTES = /^\/(verify-email|reset-password|confirm-email-change)\/?$/;

/**
 * A `.spicyplugin` archive whose entry imports a module through its import map, as the example
 * plugins do: it loads from a blob: URL and needs the map applied without an inline import map.
 */
async function smokePlugin() {
    const zip = new JSZip();
    zip.file(
        "manifest.json",
        JSON.stringify({ name: "smoke", version: "1.0.0", main: "main.js", importmap: "importmap.json" }),
    );
    zip.file("importmap.json", JSON.stringify({ imports: { "smoke-dep": "dep.js" } }));
    zip.file("dep.js", 'export const answer = "linked";');
    zip.file(
        "main.js",
        'import { answer } from "smoke-dep";\nglobalThis.__spicy3dSmokePlugin = answer;\nexport default {};',
    );
    return zip.generateAsync({ type: "nodebuffer" });
}
// Under the app's plugins/ folder: the only same-origin place plugins load from without asking (CLOUD-17).
const PLUGIN_PATH = "/plugins/smoke/smoke.spicyplugin";
const pluginArchive = args.url ? undefined : await smokePlugin();

/** dist/ as docker/default.conf.template serves it, plus the smoke plugin. */
function serve() {
    const server = createServer((request, response) => {
        const { pathname } = new URL(request.url ?? "/", "http://localhost");
        if (pathname === PLUGIN_PATH) {
            response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(pluginArchive);
            return;
        }
        let file = path.join(
            distDir,
            decodeURIComponent(APP_ROUTES.test(pathname) ? "/index.html" : pathname),
        );
        if (!file.startsWith(distDir)) {
            response.writeHead(403).end();
            return;
        }
        if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
        if (!existsSync(file)) {
            response.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
            return;
        }
        response.writeHead(200, {
            "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
            ...(args["no-csp"] ? {} : { "Content-Security-Policy": CSP }),
        });
        createReadStream(file).pipe(response);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const failures = [];
function check(condition, message) {
    console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
    if (!condition) failures.push(message);
}

/** Plain HTTP on anything but this machine: the browser's insecure context. */
function expectsInsecure(url) {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && !/^(localhost|.*\.localhost|127(\.\d+){3}|\[::1\])$/.test(hostname);
}

/** Opens `url` with every other origin blocked; returns the page and what it tried or broke. */
async function open(browser, url) {
    const origin = new URL(url).origin;
    const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true });
    const external = [];
    const problems = [];
    await context.route("**/*", (route) => {
        const target = route.request().url();
        if (new URL(target).origin === origin) return route.continue();
        external.push(target);
        return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
        const text = message.text();
        // Answers with an error status are listed with their URL below.
        if (text.startsWith("Failed to load resource: the server responded")) return;
        // CSP violations are reported on the console only.
        if (message.type() === "error" || /Content Security Policy/i.test(text)) problems.push(text);
    });
    page.on("response", (response) => {
        const target = new URL(response.url());
        // Signed out, the server answers "who am I?" with 401: expected.
        if (response.status() === 401 && target.pathname === "/api/me") return;
        if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`);
    });
    page.on("requestfailed", (request) => {
        const target = request.url();
        if (new URL(target).origin === origin)
            problems.push(`failed: ${target} (${request.failure()?.errorText})`);
    });
    await page.goto(url);
    try {
        await page.waitForFunction(
            () => {
                try {
                    return globalThis.Spicy3DCore?.getCurrentApplication() !== undefined;
                } catch {
                    return false;
                }
            },
            undefined,
            { timeout: STARTUP_TIMEOUT_MS },
        );
    } catch (error) {
        const seen = [...problems, ...external.map((u) => `blocked: ${u}`)];
        throw new Error(`${url}: the app did not start (${error.message})\n  ${seen.join("\n  ")}`);
    }
    return { context, page, external, problems };
}

/** 1–3 and the banner on one URL. */
async function checkApp(browser, url, { expectServer = false, withPlugin = false } = {}) {
    console.log(`\n${url}`);
    const run = await open(browser, url);
    const result = await run.page.evaluate(async () => {
        const core = globalThis.Spicy3DCore;
        const app = core.getCurrentApplication();
        const box = app.shapeProvider.factory.box(core.Plane.XY, 10, 20, 30);
        if (!box.isOk) return { error: `box: ${box.error}` };
        const volume = box.value.volume();

        const document = await app.newDocument("smoke");
        document.modelManager.addNode(
            new core.EditableShapeNode({ document, name: "box", shape: box.value }),
        );
        // Signed out, a new document belongs to the browser's storage (repositories.local).
        const saved = await document.save();
        if (!saved.isOk) return { error: `save: ${saved.error}` };
        const id = document.id;
        await document.close({ discardChanges: true });

        const reopened = await app.openDocument(id, app.repositories.local);
        const shape = reopened?.modelManager.findNode((n) => n.name === "box")?.shape;
        const reopenedVolume = shape?.isOk ? shape.value.volume() : undefined;
        await reopened?.close({ discardChanges: true });
        await app.repositories.local.delete(id);
        return { volume, reopened: reopened !== undefined, reopenedVolume };
    });
    check(
        result.error === undefined,
        `kernel and browser storage work${result.error ? ` (${result.error})` : ""}`,
    );
    check(
        Math.abs((result.volume ?? 0) - 6000) < 1e-6,
        `the WebAssembly kernel built a box (volume ${result.volume})`,
    );
    check(result.reopened, "a document saved to browser storage opens again");
    check(Math.abs((result.reopenedVolume ?? 0) - 6000) < 1e-6, "the reopened document has its box");

    const insecure = expectsInsecure(url);
    if (insecure)
        await run.page
            .locator(BANNER)
            .waitFor({ timeout: 10_000 })
            .catch(() => {});
    const banners = await run.page.locator(BANNER).count();
    check(
        banners === (insecure ? 1 : 0),
        insecure ? "insecure-context banner shown" : "no insecure-context banner",
    );
    if (expectServer) {
        const found = await run.page
            .locator("spicy-account-button")
            .waitFor({ timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
        check(found, "a Spicy3D server answered /api/config (account button shown)");
    }
    if (withPlugin) {
        const plugin = await run.page.evaluate(async (pluginUrl) => {
            const app = globalThis.Spicy3DCore.getCurrentApplication();
            await app.pluginManager.loadFromUrl(new URL(pluginUrl, location.href).href);
            return { loaded: app.pluginManager.isLoaded("smoke"), answer: globalThis.__spicy3dSmokePlugin };
        }, PLUGIN_PATH);
        check(
            plugin.loaded && plugin.answer === "linked",
            `a .spicyplugin with an import map loads under the CSP (${JSON.stringify(plugin)})`,
        );
    }
    check(
        run.external.length === 0,
        `no request to another origin${run.external.length ? `: ${run.external.join(", ")}` : ""}`,
    );
    check(
        run.problems.length === 0,
        `no errors or failed requests${run.problems.length ? `:\n  ${run.problems.join("\n  ")}` : ""}`,
    );
    await run.context.close();
}

const server = args.url ? undefined : await serve();
const browser = await chromium.launch({
    headless: !args.headed,
    args: [`--host-resolver-rules=MAP ${args["map-host"] ?? LAN_HOST} 127.0.0.1`],
});
try {
    if (args.url) {
        await checkApp(browser, args.url, { expectServer: args["expect-server"] });
    } else {
        const { port } = server.address();
        // localhost: a secure context over plain HTTP. spicy.lan: plain HTTP on a LAN name.
        await checkApp(browser, `http://localhost:${port}/`, { withPlugin: true });
        await checkApp(browser, `http://${LAN_HOST}:${port}/`);
    }
} finally {
    await browser.close();
    server?.close();
}

if (failures.length > 0) {
    console.error(`\n${failures.length} smoke check(s) failed`);
    process.exit(1);
}
console.log("\nsmoke test passed");
