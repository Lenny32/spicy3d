// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Server timestamps are UTC strings: parsed with `parseUtc`, shown with `formatDateTime` / `formatRelative`
// & co. (core `dateTime.ts`, CLOUD-08). This fails when source code formats or parses dates by itself,
// so a server value can't be read as local time or shown in the UI language's format by accident.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HELPERS = "packages/core/src/foundation/utils/dateTime.ts";

const FORBIDDEN: [string, RegExp][] = [
    ["toLocaleString", /\.toLocaleString\(/g],
    ["toLocaleDateString", /\.toLocaleDateString\(/g],
    ["toLocaleTimeString", /\.toLocaleTimeString\(/g],
    // `new Date()` (now) is fine; `new Date(value)` parses or wraps a value — use parseUtc / the helpers.
    ["new Date(value)", /new Date\((?!\s*\))/g],
    ["Date.parse", /Date\.parse\(/g],
    ["Intl.DateTimeFormat", /Intl\.DateTimeFormat\b/g],
    ["Intl.RelativeTimeFormat", /Intl\.RelativeTimeFormat\b/g],
];

/** Known uses that aren't server timestamps: file → pattern → how many. Anything else fails. */
const ALLOWED: Record<string, Record<string, number>> = {
    // Chat history and MCP call log: this device's own `Date.now()` times, never from the server.
    "packages/ai/src/mcp/panel.ts": { toLocaleTimeString: 1, "new Date(value)": 1 },
    // `formatBytes`: a number, not a date.
    "packages/ui/src/home/home.ts": { toLocaleString: 1 },
    // `Retry-After` as an HTTP-date (RFC 9110, always GMT): not an ISO 8601 timestamp.
    "packages/cloud/src/client.ts": { "Date.parse": 1 },
};

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
    });
}

function findUses(): Record<string, Record<string, number>> {
    const found: Record<string, Record<string, number>> = {};
    const packages = path.join(repoRoot, "packages");
    for (const pkg of readdirSync(packages)) {
        let files: string[];
        try {
            files = sourceFiles(path.join(packages, pkg, "src"));
        } catch {
            continue;
        }
        for (const file of files) {
            const relative = path.relative(repoRoot, file).split(path.sep).join("/");
            if (relative === HELPERS || relative.endsWith(".generated.ts")) continue;
            const text = readFileSync(file, "utf8");
            for (const [name, pattern] of FORBIDDEN) {
                const count = text.match(pattern)?.length ?? 0;
                if (count === 0) continue;
                found[relative] = { ...found[relative], [name]: count };
            }
        }
    }
    return found;
}

describe("date and time guard", () => {
    test("dates are parsed and formatted only through core's dateTime helpers", () => {
        expect(findUses()).toEqual(ALLOWED);
    });

    test("the guard sees the helpers file's own uses (it scans the right tree)", () => {
        const text = readFileSync(path.join(repoRoot, HELPERS), "utf8");
        expect(text).toMatch(/Intl\.DateTimeFormat\b/);
        expect(sourceFiles(path.join(repoRoot, "packages/core/src")).length).toBeGreaterThan(10);
    });
});
