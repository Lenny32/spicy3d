// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
        return /\.(ts|mjs|js)$/.test(path) && !path.endsWith(".d.ts") ? [path] : [];
    });
}

/**
 * The default bundle stays free of OpenTelemetry: outside `packages/telemetry`, the SDK half is only
 * ever reached through a dynamic `import()` (TelemetryController's loader), so its chunk is fetched
 * only once the user switched telemetry on with a URL.
 */
test("OpenTelemetry is only loaded through a dynamic import", () => {
    const references: Record<string, string[]> = {};
    for (const file of sources(resolve(root, "packages"))) {
        const path = relative(root, file).replaceAll("\\", "/");
        if (path.startsWith("packages/telemetry/") || !path.includes("/src/")) continue;
        const text = readFileSync(file, "utf8");
        const found = [...text.matchAll(/^.*["'](@spicy3d\/telemetry|@opentelemetry\/[\w-]+)["'].*$/gm)].map(
            (m) => m[0].trim(),
        );
        if (found.length > 0) references[path] = found;
    }

    expect(references).toEqual({
        "packages/builder/src/appBuilder.ts": ['() => import("@spicy3d/telemetry"),'],
    });
});
