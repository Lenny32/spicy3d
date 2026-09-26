// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Serialized } from "../src/serialize";

export interface DocumentFixture {
    /** `v<N>/<file>` — for test names. */
    name: string;
    /** The format version the fixture's folder is named after. */
    version: number;
    data: Serialized;
}

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/documents");

/**
 * Every stored document of the fixture corpus (`packages/core/test/fixtures/documents/v<N>/*.json`),
 * one or more per format version. The corpus only grows: each file is parsed fresh on every call so a
 * test that mutates one cannot affect another.
 */
export function loadDocumentFixtures(): DocumentFixture[] {
    const fixtures: DocumentFixture[] = [];
    for (const folder of readdirSync(FIXTURE_ROOT)) {
        const match = /^v(\d+)$/.exec(folder);
        if (match === null) continue;
        for (const file of readdirSync(path.join(FIXTURE_ROOT, folder)).filter((f) => f.endsWith(".json"))) {
            const data = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, folder, file), "utf8"));
            fixtures.push({ name: `${folder}/${file}`, version: Number(match[1]), data });
        }
    }
    return fixtures.sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
}
