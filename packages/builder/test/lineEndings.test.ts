// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

function eolAttribute(path: string): string {
    const result = spawnSync("git", ["check-attr", "eol", "--", path], { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    return result.stdout.trim();
}

/** A CR in a container script breaks `set -eu` and the container restarts in a loop (#186). */
describe("container files keep LF line endings", () => {
    test.each([
        "docker/19-spicy3d-plugin-origins.sh",
        "docker/default.conf.template",
        "docker/a-future-script.sh",
        "Dockerfile",
        "scripts/any-script.sh",
    ])("%s is checked out with LF", (path) => {
        expect(eolAttribute(path)).toBe(`${path}: eol: lf`);
    });
});
