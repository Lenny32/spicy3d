// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { importSpecifiers, linkPluginModules, rewriteImportSpecifiers } from "../src/pluginModules";

/** Fake blob: URLs that carry their code, so tests can read what each module became. */
function fakeUrls() {
    const codes = new Map<string, string>();
    const create = (code: string) => {
        const url = `blob:test/${codes.size}`;
        codes.set(url, code);
        return url;
    };
    return { codes, create };
}

describe("import specifiers", () => {
    const code = [
        'import { a } from "dep";',
        "import * as b from './b.js';",
        'import "side-effect";',
        'export { c } from "dep/c";',
        "export * from 'reexported';",
        'const lazy = await import("lazy");',
        "const text = 'from nowhere';",
    ].join("\n");

    test("finds static, side-effect, re-export and dynamic imports", () => {
        expect(importSpecifiers(code)).toEqual([
            "dep",
            "./b.js",
            "side-effect",
            "dep/c",
            "reexported",
            "lazy",
        ]);
    });

    test("rewrites only the ones resolved, keeping the quotes", () => {
        const rewritten = rewriteImportSpecifiers(code, (s) =>
            s === "dep" || s === "lazy" ? `blob:${s}` : undefined,
        );

        expect(rewritten).toContain('import { a } from "blob:dep";');
        expect(rewritten).toContain('await import("blob:lazy")');
        expect(rewritten).toContain("import * as b from './b.js';");
        expect(rewritten).toContain('export { c } from "dep/c";');
        expect(rewritten).toContain("const text = 'from nowhere';");
    });
});

describe("linkPluginModules", () => {
    test("points the entry and the mapped modules at each other's blob URLs, dependencies first", () => {
        const { codes, create } = fakeUrls();

        const result = linkPluginModules(
            { code: 'import { a } from "a";\nimport { b } from "./module2";\nexport default { a, b };' },
            {
                a: { code: 'import { b } from "./module2";\nexport const a = b + 1;' },
                "./module2": { code: "export const b = 1;" },
            },
            create,
        );

        expect(result.isOk).toBe(true);
        const { main, imports } = result.value;
        const [first, second] = imports;
        expect(codes.get(first)).toBe("export const b = 1;");
        expect(codes.get(second)).toBe(`import { b } from "${first}";\nexport const a = b + 1;`);
        expect(codes.get(main)).toBe(
            `import { a } from "${second}";\nimport { b } from "${first}";\nexport default { a, b };`,
        );
    });

    test("resolves a served module's relative imports next to where it came from", () => {
        const { codes, create } = fakeUrls();

        const result = linkPluginModules(
            {
                code: 'import "./chunk.js";\nimport "dep";',
                url: "https://cad.example.com/plugins/p/dist/main.js",
            },
            { dep: { code: 'import "../shared.js";', url: "https://cad.example.com/plugins/p/lib/dep.js" } },
            create,
        );

        expect(result.isOk).toBe(true);
        expect(codes.get(result.value.imports[0])).toBe(
            'import "https://cad.example.com/plugins/p/shared.js";',
        );
        expect(codes.get(result.value.main)).toBe(
            `import "https://cad.example.com/plugins/p/dist/chunk.js";\nimport "${result.value.imports[0]}";`,
        );
    });

    test("a cycle between mapped modules is an error, and nothing is left linked", () => {
        const { create } = fakeUrls();
        const revoke = rs.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        try {
            const result = linkPluginModules(
                { code: 'import "a";' },
                { a: { code: 'import "b";' }, b: { code: 'import "a";' }, c: { code: "" } },
                create,
            );

            expect(result.isOk).toBe(false);
            expect(result.error).toContain("import cycle: a → b → a");
        } finally {
            revoke.mockRestore();
        }
    });
});
