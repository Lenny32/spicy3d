// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generatedPath = path.join(repoRoot, "packages/cloud/src/api/schema.generated.ts");
const script = "scripts/generate-cloud-api.mjs";

/**
 * The client's types are generated from the committed server spec (packages/cloud/openapi.json).
 * An edit to either side alone would compile against a contract the server doesn't have; the check
 * (`npm run cloud:api:check`, ~1s) runs with the suite so CI catches it.
 */
describe("generated API types", () => {
    test("schema.generated.ts is what the generator produces from openapi.json", () => {
        const result = spawnSync("node", [script, "--check"], { cwd: repoRoot, encoding: "utf8" });
        if (result.status !== 0) {
            throw new Error(
                `${result.stderr || result.stdout} (regenerate with npm run cloud:api, then commit)`,
            );
        }
        expect(result.stdout).toContain("is up to date");
    });

    test("the check fails on a stale copy", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "spicy3d-cloud-api-"));
        try {
            const stale = path.join(dir, "schema.generated.ts");
            writeFileSync(
                stale,
                readFileSync(generatedPath, "utf8").replace("apiVersion: number;", "apiVersion: string;"),
            );

            const result = spawnSync("node", [script, "--check", "--out", stale], {
                cwd: repoRoot,
                encoding: "utf8",
            });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain("is stale");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("integers the spec types as integer|string (SpicySrv#8) are numbers", () => {
        const generated = readFileSync(generatedPath, "utf8");
        expect(generated).toContain("maxUploadBytes: number;");
        expect(generated).toMatch(/quotaBytes: (number \| null|null \| number);/);
        expect(generated).not.toMatch(/: number \| string;/);
    });
});
