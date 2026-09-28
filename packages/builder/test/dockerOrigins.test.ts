// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
// The container's check, without the directory it creates for nginx.
const script = readFileSync(resolve(root, "docker/19-spicy3d-plugin-origins.sh"), "utf8")
    // The Linux image uses LF; Git's Windows checkout can use CRLF.
    .replace(/\r\n/g, "\n")
    .replace("mkdir -p /tmp/conf.d", "");

function run(env: Record<string, string>): number | null {
    const result = spawnSync("sh", ["-s"], {
        input: script,
        env: { PATH: process.env["PATH"] ?? "", ...env },
    });
    // Report a missing shell as infrastructure failure, rather than an origin-validation mismatch.
    if (result.error) throw result.error;
    return result.status;
}

/** SPICY3D_*_ORIGINS go verbatim into the CSP header (docker/default.conf.template). */
describe("docker/19-spicy3d-plugin-origins.sh", () => {
    test.each([
        [{}],
        [{ SPICY3D_PLUGIN_ORIGINS: "https://plugins.example.com http://p.example.com:8080" }],
        [{ SPICY3D_PLUGIN_ORIGINS: "https://*.example.com" }],
        [{ SPICY3D_CONNECT_ORIGINS: "https://api.example.com wss://*.example.com:8443" }],
    ])("accepts %j", (env) => {
        expect(run(env)).toBe(0);
    });

    test.each([
        [{ SPICY3D_PLUGIN_ORIGINS: "https://*.com" }],
        [{ SPICY3D_CONNECT_ORIGINS: "https://*.com:443" }],
        [{ SPICY3D_CONNECT_ORIGINS: "http://api.example.com" }],
        [{ SPICY3D_PLUGIN_ORIGINS: "https://a.example.com;script-src *" }],
        [{ SPICY3D_PLUGIN_ORIGINS: "https://a.example.com\thttps://b.example.com" }],
        [{ SPICY3D_PLUGIN_ORIGINS: "https://a.example.com\nadd_header X 1" }],
        [{ SPICY3D_PLUGIN_ORIGINS: "https://a.example.com  https://b.example.com" }],
        [{ SPICY3D_PLUGIN_ORIGINS: 'https://a.example.com"' }],
    ])("refuses %j", (env) => {
        expect(run(env)).toBe(1);
    });
});
