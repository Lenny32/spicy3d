// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Fails on any absolute URL (http, https, ws, wss, or protocol-relative `//host/…` in a string or
 * CSS `url(…)`) in what the browser gets that is not on the allowlist below (CLOUD-16): the app
 * must run on a LAN without internet access, so nothing may be fetched from elsewhere (a CDN
 * script, a web font, a hard-wired server). Scans the app's sources and public/, and the build
 * output (dist/) when present, which also covers the bundled dependencies.
 *
 * A new URL either goes (make it relative, or a setting in deployment.json) or joins the allowlist
 * with the reason it is never fetched on its own.
 *
 *   node scripts/check-external-urls.mjs            # sources, public/ and dist/ if built
 *   node scripts/check-external-urls.mjs --no-dist  # without dist/
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * [URL pattern, why it is harmless, and optionally the only files (path from the repository root)
 * it may appear in].
 */
const ALLOWED = [
    // Placeholders in examples and comments: RFC 2606 names, "host" and "…".
    [/^(https?|wss?):\/\/(host|…|([\w-]+\.)*example\.(com|org|net))([:/]|$)/, "placeholder"],
    // Loopback, only where it is meant: the base URL when there is no page.
    [/^http:\/\/localhost\/$/, "base URL without a page", /^(packages\/(cloud|core)\/src\/|dist\/)/],
    // Identifiers, never requested.
    [/^http:\/\/www\.w3\.org\//, "XML namespace"],
    [/^https?:\/\/json-schema\.org\//, "JSON Schema $schema id (ajv, MCP SDK)"],
    [/^https:\/\/raw\.githubusercontent\.com\/ajv-validator\/ajv\//, "JSON Schema $id (ajv)"],
    [/^https?:\/\/www\.eclipse\.org\/(emf|elk)\//, "EMF / ELK namespace (visual-programming's elkjs)"],
    [/^http:\/\/vectornator\.io\/?$/, "SVG editor namespace (favicon)"],
    // Built at runtime from parts (`http://[${host}]`) or without a host (`http:///org/…`): no fixed target.
    [/^(https?|wss?):\/\/(\/|\[?\$\{)/, "URL template, not a fixed target"],
    // Links the user may open; nothing loads them.
    [/^https:\/\/github\.com\/Lenny32\/spicy3d(\/|$)/, "repository link"],
    [/^https:\/\/github\.com\/xiangechen\/chili3d(\/|$)/, "upstream repository link"],
    // LLM endpoints the user picks in the assistant's settings (deployment.json can offer others or hide them).
    [/^https:\/\/api\.anthropic\.com(\/|$)/, "LLM preset, used only when chosen"],
    [/^https:\/\/api\.openai\.com\/v1(\/|$)/, "LLM preset, used only when chosen"],
    // References in comments, licenses and error messages of the app and its dependencies.
    [
        /^https:\/\/github\.com\/(ai\/nanoid|ajaxorg\/ace|babel\/babel|facebook\/regenerator)\//,
        "source reference",
    ],
    [/^https?:\/\/www\.apache\.org\/licenses\//, "license text"],
    [/^https?:\/\/www\.eclipse\.org\/legal\//, "license text"],
    [/^https:\/\/developer\.mozilla\.org\//, "documentation link"],
    [/^https:\/\/stuk\.github\.io\/jszip\//, "documentation link (jszip error message)"],
    [/^https:\/\/rtsys\.informatik\.uni-kiel\.de\/elklive\//, "documentation link (elk)"],
    [/^https:\/\/jcgt\.org\/published\//, "paper reference (three.js)"],
];

const TEXT = new Set([".ts", ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".svg"]);
const URL_PATTERN =
    /\b(?:https?|wss?):\/\/[^\s"'`<>()\\]+|(?<=["'`(])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`<>()\\]*/gi;

const fromRoot = (file) => path.relative(rootDir, file).split(path.sep).join("/");

function* files(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry !== "node_modules") yield* files(full);
        } else if (TEXT.has(path.extname(entry))) {
            yield full;
        }
    }
}

const roots = [
    ...readdirSync(path.join(rootDir, "packages")).map((p) => path.join(rootDir, "packages", p, "src")),
    ...readdirSync(path.join(rootDir, "plugins"))
        .map((p) => path.join(rootDir, "plugins", p, "src"))
        .filter((p) => existsSync(p)),
    path.join(rootDir, "public"),
];
const withDist = !process.argv.includes("--no-dist") && existsSync(path.join(rootDir, "dist"));
if (withDist) roots.push(path.join(rootDir, "dist"));

const found = new Map();
let scanned = 0;
for (const root of roots) {
    for (const file of files(root)) {
        // The server's API types: its spec's links, never requested.
        if (file.endsWith("schema.generated.ts")) continue;
        scanned++;
        const relative = fromRoot(file);
        for (const [url] of readFileSync(file, "utf8").matchAll(URL_PATTERN)) {
            const clean = url.replace(/[.,;:]+$/, "");
            const allowed = ALLOWED.some(
                ([pattern, , where]) => pattern.test(clean) && (!where || where.test(relative)),
            );
            if (allowed) continue;
            const where = found.get(clean) ?? [];
            where.push(relative);
            found.set(clean, where);
        }
    }
}

if (found.size > 0) {
    console.error(`${found.size} external URL(s) not on the allowlist in scripts/check-external-urls.mjs:`);
    for (const [url, where] of found) console.error(`  ${url}\n    ${[...new Set(where)].join("\n    ")}`);
    process.exit(1);
}
console.log(`no unexpected external URLs (${scanned} files${withDist ? ", dist/ included" : ""})`);
