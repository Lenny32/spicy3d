// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

/** The policy the web image sends, with its origin variables at their default (empty). */
function policy(): Map<string, string[]> {
    const conf = readFileSync(resolve(root, "docker/default.conf.template"), "utf8");
    const header = /add_header Content-Security-Policy "([^"]+)"/.exec(conf)?.[1];
    expect(header).not.toBeUndefined();
    const directives = new Map<string, string[]>();
    for (const part of header!.replace(/\$\{SPICY3D_[A-Z_]+\}/g, "").split(";")) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) directives.set(name, values);
    }
    return directives;
}

/** CLOUD-17: what the image's CSP must keep; docs/security.md explains each remaining relaxation. */
describe("the web image's Content-Security-Policy", () => {
    test("frames, objects, base and form targets are locked down", () => {
        const csp = policy();
        expect(csp.get("default-src")).toEqual(["'self'"]);
        expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
        expect(csp.get("object-src")).toEqual(["'none'"]);
        expect(csp.get("base-uri")).toEqual(["'self'"]);
        expect(csp.get("form-action")).toEqual(["'self'"]);
    });

    test("no inline scripts, no script host wildcards", () => {
        const script = policy().get("script-src") ?? [];
        expect(script).toContain("'self'");
        expect(script).not.toContain("'unsafe-inline'");
        expect(script.some((x) => x === "*" || x === "https:" || x === "http:" || x === "data:")).toBe(false);
    });

    test("connect-src: the app's origin only, no https: wildcard", () => {
        expect(policy().get("connect-src")).toEqual(["'self'"]);
    });

    test("index.html carries no inline script", () => {
        const html = readFileSync(resolve(root, "public/index.html"), "utf8");
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });
});
