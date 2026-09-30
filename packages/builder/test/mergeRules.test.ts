// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    MERGE_RULES_BEGIN,
    MERGE_RULES_END,
    MergeRules,
    renderMergeRules,
    Serializer,
    UNKNOWN_CLASS_RULE,
} from "@spicy3d/core";
// Every package that registers serializable classes, for their `@serializable` and merge rules.
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// Every class the serializer can store must have a merge rule (docs/merge.md) — the explicit
// `atomic` fallback counts, but it has to be declared. This test sits in `builder` because that is
// the package depending on every module.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC = path.join(ROOT, "docs/merge.md");
/** Classes with a rule that the serializer does not register: the document envelope. */
const ENVELOPE_CLASSES = ["Document"];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full);
        return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [full] : [];
    });
}

/** Class names registered in the sources: `@serializable(...)` before a class, and `registerTypeArray(X)`. */
function declaredSerializableClasses(): string[] {
    const roots = ["packages", "plugins"]
        .map((folder) => path.join(ROOT, folder))
        .flatMap((folder) =>
            readdirSync(folder)
                .map((name) => path.join(folder, name, "src"))
                .filter((src) => statSync(src, { throwIfNoEntry: false })?.isDirectory() === true),
        );
    const names = new Set<string>();
    for (const file of roots.flatMap(sourceFiles)) {
        const text = readFileSync(file, "utf8");
        // the first class line after the decorator, exported or not (a lazy scan to the next *exported*
        // class would take a later class for an unexported one)
        const declared =
            /^@serializable\b[\s\S]*?^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
        for (const match of text.matchAll(declared)) {
            names.add(match[1]);
        }
        for (const match of text.matchAll(/^\s*registerTypeArray\((\w+)\);/gm)) names.add(match[1]);
    }
    return [...names].sort();
}

describe("merge rules", () => {
    test("every class the serializer registers has a merge rule", () => {
        const registered = Serializer.registeredClassNames();
        expect(registered.length).toBeGreaterThan(50);
        expect(MergeRules.uncovered(registered)).toEqual([]);
    });

    test("every serializable class declared in the sources has a merge rule, loaded or not", () => {
        // the static scan also covers classes no entry point imports (e.g. FuseNode today)
        const declared = declaredSerializableClasses();
        expect(declared).toEqual(
            expect.arrayContaining(["SketchNode", "ParametricBodyNode", "OccEdge", "BoxNode"]),
        );
        expect(MergeRules.uncovered(declared)).toEqual([]);
    });

    test("no rule is left for a class nothing declares", () => {
        const known = new Set([
            ...Serializer.registeredClassNames(),
            ...declaredSerializableClasses(),
            ...ENVELOPE_CLASSES,
        ]);
        expect(MergeRules.classNames().filter((name) => !known.has(name))).toEqual([]);
    });

    test("every payload a rule refers to is registered", () => {
        expect(MergeRules.missingPayloads()).toEqual([]);
        expect(MergeRules.payloadNames()).toEqual(
            expect.arrayContaining(["parametric.features", "sketch.data", "construction.definition"]),
        );
    });

    test("a class without a rule falls back to the declared atomic rule", () => {
        expect(MergeRules.ruleOf("SomePluginNode")).toBe(UNKNOWN_CLASS_RULE);
        expect(UNKNOWN_CLASS_RULE.strategy).toBe("atomic");
    });

    test("docs/merge.md lists the rules as registered (npm run merge:rules rewrites it)", () => {
        const doc = readFileSync(DOC, "utf8");
        const begin = doc.indexOf(MERGE_RULES_BEGIN);
        const end = doc.indexOf(MERGE_RULES_END);
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(begin);
        const generated = renderMergeRules(MergeRules);
        const current = doc.slice(begin, end + MERGE_RULES_END.length);
        if (process.env["SPICY3D_UPDATE_MERGE_RULES"] === "1" && current !== generated) {
            writeFileSync(DOC, doc.slice(0, begin) + generated + doc.slice(end + MERGE_RULES_END.length));
            return;
        }
        // Git may check this Markdown out with CRLF on Windows; compare the generated content.
        expect(current.replace(/\r\n/g, "\n")).toBe(generated);
    });
});
