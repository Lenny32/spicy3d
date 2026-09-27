// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

function dependencies(packageJson: string): Record<string, string> {
    const json = JSON.parse(readFileSync(resolve(root, packageJson), "utf8"));
    return { ...json.dependencies, ...json.devDependencies };
}

/**
 * The dependencies that handle credentials or agent traffic are pinned to an exact version and
 * updated one reviewed pull request at a time (docs/security.md, .github/dependabot.yml).
 */
describe("security-sensitive dependencies are pinned", () => {
    test.each([
        ["packages/ai/package.json", "@modelcontextprotocol/sdk"],
        ["packages/cloud/package.json", "openapi-fetch"],
        ["package.json", "openapi-typescript"],
    ])("%s: %s", (file, name) => {
        const version = dependencies(file)[name];
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        const dependabot = readFileSync(resolve(root, ".github/dependabot.yml"), "utf8");
        expect(dependabot).toContain(`"${name}"`);
    });
});
