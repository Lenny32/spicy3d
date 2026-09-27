// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * License texts shipped with the bundled MCP bridge (the npx tarball, scripts/pack-mcp-bridge.mjs,
 * and the standalone executables, scripts/build-mcp-bridge-binaries.mjs): the bridge's own AGPL-3.0
 * LICENSE, and the notices of every third-party package esbuild put into the bundle (read from its
 * metafile, so a new dependency is covered without editing a list).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The package folders (…/node_modules/<name> or …/node_modules/@scope/<name>) of the bundle's inputs. */
function bundledPackages(metafile) {
    const folders = new Set();
    for (const input of Object.keys(metafile.inputs)) {
        const parts = input.split(/[\\/]/);
        const at = parts.lastIndexOf("node_modules");
        if (at < 0) continue;
        const length = parts[at + 1]?.startsWith("@") ? 3 : 2;
        folders.add(path.resolve(rootDir, ...parts.slice(0, at + length)));
    }
    return [...folders].sort();
}

function licenseText(folder) {
    const file = readdirSync(folder).find((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
    return file ? readFileSync(path.join(folder, file), "utf8").trim() : undefined;
}

/** `LICENSE` (the bridge's, AGPL-3.0) and `THIRD-PARTY-NOTICES` for an esbuild metafile. */
export function bridgeNotices(metafile) {
    const sections = bundledPackages(metafile).map((folder) => {
        const pkg = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
        const text = licenseText(folder);
        if (!text) throw new Error(`${pkg.name}: no license file to ship with the bundled bridge`);
        return `${pkg.name}@${pkg.version} (${pkg.license ?? "see below"})\n${"-".repeat(40)}\n${text}`;
    });
    const notices = [
        "spicy3d-mcp-bridge bundles the following third-party packages.",
        "",
        ...sections.map((s) => `${s}\n`),
    ].join("\n");
    const license = path.join(rootDir, "LICENSE");
    if (!existsSync(license)) throw new Error("LICENSE is missing at the repository root");
    return { license: readFileSync(license, "utf8"), notices };
}
