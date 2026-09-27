// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@spicy3d/core";

// A plugin's import map, without a <script type="importmap">: a Content-Security-Policy without
// 'unsafe-inline' (the web image's, docs/deployment.md) blocks inline import maps, and a nonce or
// hash is impossible for a static server and user-chosen plugins. Instead the plugin's modules are
// linked before they run: every import of a mapped specifier is rewritten to the blob: URL of that
// module (dependencies first), relative imports to absolute URLs next to the module's origin file.

/** One module's code, and where it came from (for its relative imports), if anywhere. */
export interface PluginModuleSource {
    code: string;
    url?: string;
}

export interface LinkedPluginModules {
    /** The blob: URL of the entry module, rewritten. */
    main: string;
    /** The blob: URLs of the mapped modules (revoked when the plugin is unloaded). */
    imports: string[];
}

// `from "x"` (static import / re-export), `import "x"` (side effect), `import("x")` (dynamic).
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n\r]+)\2/g;

/** The module specifiers `code` imports, in order (duplicates included). */
export function importSpecifiers(code: string): string[] {
    return [...code.matchAll(SPECIFIER)].map((match) => match[3]);
}

/**
 * `code` with each import specifier replaced by `resolve(specifier)`, where that answers a URL;
 * other imports are left as they are.
 */
export function rewriteImportSpecifiers(code: string, resolve: (specifier: string) => string | undefined) {
    return code.replace(SPECIFIER, (whole, prefix: string, quote: string, specifier: string) => {
        const target = resolve(specifier);
        return target === undefined ? whole : `${prefix}${quote}${target}${quote}`;
    });
}

function isRelative(specifier: string) {
    return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

/**
 * Links `main` and the modules of its import map (`imports`: specifier → source): each becomes a
 * blob: URL whose imports of mapped specifiers point at the others. Fails on an import cycle
 * between mapped modules (a blob's content, and so its URL, can't reference one made after it).
 */
export function linkPluginModules(
    main: PluginModuleSource,
    imports: Record<string, PluginModuleSource>,
    createUrl: (code: string) => string = (code) =>
        URL.createObjectURL(new Blob([code], { type: "text/javascript" })),
): Result<LinkedPluginModules, string> {
    const linked = new Map<string, string>();
    const visiting: string[] = [];

    const resolverFor = (source: PluginModuleSource) => (specifier: string) => {
        if (Object.hasOwn(imports, specifier)) return linked.get(specifier);
        if (source.url && isRelative(specifier)) return new URL(specifier, source.url).href;
        return undefined;
    };

    const link = (specifier: string): string | undefined => {
        const done = linked.get(specifier);
        if (done) return undefined;
        if (visiting.includes(specifier)) {
            return `import cycle: ${[...visiting.slice(visiting.indexOf(specifier)), specifier].join(" → ")}`;
        }
        visiting.push(specifier);
        const source = imports[specifier];
        for (const dependency of importSpecifiers(source.code)) {
            if (!Object.hasOwn(imports, dependency)) continue;
            const error = link(dependency);
            if (error) return error;
        }
        visiting.pop();
        linked.set(specifier, createUrl(rewriteImportSpecifiers(source.code, resolverFor(source))));
        return undefined;
    };

    for (const specifier of Object.keys(imports)) {
        const error = link(specifier);
        if (error) {
            // Nothing else holds these yet.
            for (const url of linked.values()) URL.revokeObjectURL(url);
            return Result.err(error);
        }
    }
    const code = rewriteImportSpecifiers(main.code, resolverFor(main));
    return Result.ok({ main: createUrl(code), imports: [...linked.values()] });
}
