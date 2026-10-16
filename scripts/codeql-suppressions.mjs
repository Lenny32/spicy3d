// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Reviewed CodeQL false positives, kept in the repository instead of dismissed by hand (a dismissed
 * alert comes back as a new one whenever the code around it changes). The CodeQL job of quality.yml writes its SARIF, this script
 * drops the results matching an entry below (same rule *and* same file), then the rest is uploaded.
 * Every dropped result is printed with its reason; an entry matching nothing in a run that ran its
 * rule is a warning, so a stale one gets noticed. Add an entry only with a reason a reviewer can check
 * against the code.
 *
 *   node scripts/codeql-suppressions.mjs <folder or .sarif file>...
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPRESSIONS = [
    {
        rule: "js/http-to-file-access",
        file: "scripts/fetch-wasm.mjs",
        reason:
            "Writing the downloaded kernel is the script's purpose. The bytes are written only after their " +
            "sha256 equals the one pinned in the committed packages/wasm/wasm.lock.json, to names that are " +
            "constants or validated hex hashes (readLock); the query models no such check.",
    },
    {
        rule: "js/file-access-to-http",
        file: "scripts/fetch-wasm.mjs",
        reason:
            "The only file data in the request is the release tag of the committed lock, validated as " +
            "wasm-<16 hex digits> by readLock and sent to this repository's public release URL (or the " +
            "https mirror of SPICY3D_WASM_BASE_URL); nothing else read from disk is sent.",
    },
];

const fileOf = (result) =>
    result.locations?.[0]?.physicalLocation?.artifactLocation?.uri?.replace(/^\.\//, "");

/** CodeQL lists a query pack's rules under `tool.extensions`, other tools under `tool.driver`. */
const ranRule = (run, rule) =>
    [run.tool?.driver, ...(run.tool?.extensions ?? [])].some((component) =>
        (component?.rules ?? []).some((descriptor) => descriptor.id === rule),
    );

/**
 * Removes the suppressed results from a SARIF log in place; returns, per entry, what was removed and
 * whether a run of the log ran its rule at all.
 */
export function applySuppressions(sarif, suppressions = SUPPRESSIONS) {
    const dropped = suppressions.map((entry) => ({
        entry,
        results: [],
        ran: (sarif.runs ?? []).some((run) => ranRule(run, entry.rule)),
    }));
    for (const run of sarif.runs ?? []) {
        run.results = (run.results ?? []).filter((result) => {
            const match = dropped.find(
                ({ entry }) => entry.rule === result.ruleId && entry.file === fileOf(result),
            );
            if (!match) return true;
            match.results.push(result);
            return false;
        });
    }
    return dropped;
}

function sarifFiles(target) {
    if (!statSync(target).isDirectory()) return [target];
    return readdirSync(target)
        .filter((name) => name.endsWith(".sarif"))
        .map((name) => path.join(target, name));
}

function main(targets) {
    if (targets.length === 0) {
        console.error("usage: node scripts/codeql-suppressions.mjs <folder or .sarif file>...");
        return 2;
    }
    const matched = new Set();
    const ran = new Set();
    for (const file of targets.flatMap(sarifFiles)) {
        const sarif = JSON.parse(readFileSync(file, "utf8"));
        for (const { entry, results, ran: ranHere } of applySuppressions(sarif)) {
            if (ranHere) ran.add(entry);
            if (results.length > 0) matched.add(entry);
            for (const result of results) {
                const line = result.locations[0].physicalLocation.region?.startLine;
                console.log(`suppressed ${entry.rule} at ${entry.file}:${line}: ${entry.reason}`);
            }
        }
        writeFileSync(file, JSON.stringify(sarif));
    }
    for (const entry of SUPPRESSIONS.filter((entry) => ran.has(entry) && !matched.has(entry))) {
        console.log(`::warning::CodeQL suppression of ${entry.rule} in ${entry.file} matched nothing`);
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
