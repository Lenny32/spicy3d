// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Icons are `<use href="#icon-…">` into the sprite of `public/iconfont.js`: a name missing there draws
// nothing, no error anywhere (a construction plane's timeline step and tree icon were blank that way).
// This fails when source code names an icon the sprite does not define.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SPRITE = "public/iconfont.js";

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
    });
}

function spriteIcons(): Set<string> {
    const text = readFileSync(path.join(repoRoot, SPRITE), "utf8");
    return new Set([...text.matchAll(/id="(icon-[\w-]+)"/g)].map((m) => m[1]));
}

/** Every quoted `"icon-…"` literal of the packages' sources: icon name → files naming it. */
function usedIcons(): Map<string, string[]> {
    const used = new Map<string, string[]>();
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
            for (const [, name] of readFileSync(file, "utf8").matchAll(/"(icon-[\w-]+)"/g)) {
                used.set(name, [...(used.get(name) ?? []), relative]);
            }
        }
    }
    return used;
}

describe("icon guard", () => {
    test("every icon named in the sources is defined by the sprite", () => {
        const defined = spriteIcons();
        const missing = [...usedIcons()].filter(([name]) => !defined.has(name));
        expect(Object.fromEntries(missing)).toEqual({});
    });

    test("the guard reads the sprite and scans the sources", () => {
        expect(spriteIcons().has("icon-box")).toBe(true);
        expect(usedIcons().get("icon-setWorkingPlane")).toContain("packages/core/src/construction/node.ts");
    });
});
