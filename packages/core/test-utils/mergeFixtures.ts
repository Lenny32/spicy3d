// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDocument } from "../src/documentFormat";
import type { MergeConflict } from "../src/merge";
import type { Serialized } from "../src/serialize";

export const MERGE_FIXTURE_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../test/fixtures/merge",
);

/** The files of one merge case folder. */
export const MERGE_FIXTURE_DOCUMENTS = ["base", "ours", "theirs", "expected"] as const;

export interface MergeFixture {
    /** The case folder's name. */
    name: string;
    description: string;
    base: Serialized;
    ours: Serialized;
    theirs: Serialized;
    /** The merged document the spec (docs/merge.md) requires, conflicting locations holding their first choice. */
    expected: Serialized;
    /** The conflicts the merge must report, in order; a side absent at the path is a missing key. */
    conflicts: MergeConflict[];
}

/**
 * Every merge case of `packages/core/test/fixtures/merge/<case>/` ({base,ours,theirs,expected}.json
 * + conflicts.json `{ description, conflicts }`), sorted by name and parsed fresh on every call.
 * The merge engine (CLOUD-12) must turn base/ours/theirs into expected + conflicts.
 *
 * Every document comes back in the running build's format (`migrateDocument`) — what two devices on
 * this build would hold; the stored files keep the module versions they were written with.
 */
export function loadMergeFixtures(): MergeFixture[] {
    return readdirSync(MERGE_FIXTURE_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .map((name) => {
            const read = (file: string) =>
                JSON.parse(readFileSync(path.join(MERGE_FIXTURE_ROOT, name, `${file}.json`), "utf8"));
            const { description, conflicts } = read("conflicts") as {
                description: string;
                conflicts: MergeConflict[];
            };
            return {
                name,
                description,
                base: current(read("base")),
                ours: current(read("ours")),
                theirs: current(read("theirs")),
                expected: current(read("expected")),
                conflicts,
            };
        });
}

/** `doc` in the running build's format (unchanged when it does not migrate). */
function current(doc: Serialized): Serialized {
    const migrated = migrateDocument(doc);
    return migrated.isOk ? migrated.value : doc;
}
