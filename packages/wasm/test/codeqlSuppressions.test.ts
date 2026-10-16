// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applySuppressions, SUPPRESSIONS } from "../../../scripts/codeql-suppressions.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const script = path.join(repoRoot, "scripts/codeql-suppressions.mjs");

interface SarifResult {
    ruleId: string;
    locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
}

const result = (ruleId: string, uri: string, startLine = 68): SarifResult => ({
    ruleId,
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }],
});

/** A CodeQL log: the driver, then the query pack holding the rules. */
const sarif = (results: SarifResult[], rules = ["js/http-to-file-access", "js/file-access-to-http"]) => ({
    version: "2.1.0",
    runs: [
        {
            tool: {
                driver: { name: "CodeQL", rules: [] },
                extensions: [{ name: "codeql/javascript-queries", rules: rules.map((id) => ({ id })) }],
            },
            results,
        },
    ],
});

const remaining = (log: ReturnType<typeof sarif>) =>
    log.runs[0].results.map((r) => `${r.ruleId} ${r.locations[0].physicalLocation.artifactLocation.uri}`);

describe("codeql-suppressions", () => {
    test("every entry names a rule, a file of the repository and a reason", () => {
        expect(SUPPRESSIONS.length).toBeGreaterThan(0);
        for (const entry of SUPPRESSIONS) {
            expect(entry.rule).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
            expect(readFileSync(path.join(repoRoot, entry.file), "utf8").length).toBeGreaterThan(0);
            expect(entry.reason.length).toBeGreaterThan(40);
        }
    });

    test("drops only the listed rule in the listed file", () => {
        const log = sarif([
            result("js/http-to-file-access", "scripts/fetch-wasm.mjs"),
            result("js/http-to-file-access", "scripts/generate-cloud-api.mjs"),
            result("js/file-access-to-http", "scripts/smoke-offline.mjs", 96),
            result("js/http-to-file-access", "scripts/fetch-wasm.mjs.bak"),
        ]);
        const dropped = applySuppressions(log);
        expect(remaining(log)).toEqual([
            "js/http-to-file-access scripts/generate-cloud-api.mjs",
            "js/file-access-to-http scripts/smoke-offline.mjs",
            "js/http-to-file-access scripts/fetch-wasm.mjs.bak",
        ]);
        expect(dropped).toHaveLength(SUPPRESSIONS.length);
        expect(dropped[0].results).toHaveLength(1);
        expect(dropped[0].ran).toBe(true);
    });

    test("an entry is only checked against runs that ran its rule", () => {
        const dropped = applySuppressions(sarif([], ["cpp/unused-local-variable"]));
        expect(dropped[0].ran).toBe(false);
        expect(dropped[0].results).toEqual([]);
    });

    describe("command line", () => {
        let dir: string;

        beforeEach(() => {
            dir = mkdtempSync(path.join(tmpdir(), "spicy3d-codeql-"));
        });

        afterEach(() => rmSync(dir, { recursive: true, force: true }));

        const run = (target: string) =>
            new Promise<{ code: number; out: string }>((resolve) => {
                execFile(process.execPath, [script, target], (error, stdout, stderr) =>
                    resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` }),
                );
            });

        test("rewrites every .sarif of a folder and prints each dropped result with its reason", async () => {
            const file = path.join(dir, "javascript.sarif");
            writeFileSync(
                file,
                JSON.stringify(
                    sarif([
                        result("js/http-to-file-access", "scripts/fetch-wasm.mjs", 68),
                        result("js/file-access-to-http", "scripts/fetch-wasm.mjs", 96),
                        result("js/unused-local-variable", "scripts/fetch-wasm.mjs", 12),
                    ]),
                ),
            );
            const { code, out } = await run(dir);
            expect(code).toBe(0);
            expect(out).toContain("suppressed js/http-to-file-access at scripts/fetch-wasm.mjs:68: ");
            expect(out).toContain("suppressed js/file-access-to-http at scripts/fetch-wasm.mjs:96: ");
            expect(out).toContain("sha256");
            expect(out).not.toContain("::warning::");
            expect(remaining(JSON.parse(readFileSync(file, "utf8")))).toEqual([
                "js/unused-local-variable scripts/fetch-wasm.mjs",
            ]);
        });

        test("warns about an entry that matched nothing although its rule ran", async () => {
            writeFileSync(path.join(dir, "javascript.sarif"), JSON.stringify(sarif([])));
            writeFileSync(path.join(dir, "cpp.sarif"), JSON.stringify(sarif([], ["cpp/x"])));
            const { code, out } = await run(dir);
            expect(code).toBe(0);
            expect(out).toContain(
                "::warning::CodeQL suppression of js/http-to-file-access in scripts/fetch-wasm.mjs matched nothing",
            );
        });

        test("stays quiet when no run ran the rule (C++ or Actions only)", async () => {
            writeFileSync(path.join(dir, "cpp.sarif"), JSON.stringify(sarif([], ["cpp/x"])));
            const { code, out } = await run(dir);
            expect(code).toBe(0);
            expect(out).not.toContain("::warning::");
        });
    });
});
