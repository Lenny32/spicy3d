// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mergeDocuments, type Serialized } from "../../src";

// A big imported assembly: 10 000 siblings under one folder, edited on both sides. Node lookups are
// id maps and the sibling order is patience-sorted (O(n log n)), so the merge stays well under a
// second; the bound here is generous so a slow CI machine does not flake.

const COUNT = 10_000;

function assembly(): Serialized {
    const nodes: Record<string, unknown>[] = [
        { __cla$$__: "FolderNode", id: "root", name: "Assembly", visible: true },
    ];
    nodes.push({ __cla$$__: "FolderNode", id: "parts", name: "Parts", visible: true, parentId: "root" });
    for (let i = 0; i < COUNT; i++) {
        nodes.push({
            __cla$$__: "FolderNode",
            id: `n${i}`,
            name: `Part ${i}`,
            visible: true,
            parentId: "parts",
        });
    }
    nodes.push({ __cla$$__: "FolderNode", id: "spares", name: "Spares", visible: true, parentId: "root" });
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: {},
        id: "assembly",
        name: "Assembly",
        models: { nodes, materials: [], components: [] },
        variables: [],
        settings: {},
        acts: [],
        userData: {},
    } as unknown as Serialized;
}

type Node = { id: string; name: string; parentId?: string };

function edit(doc: Serialized, change: (nodes: Node[]) => Node[]): Serialized {
    const copy = structuredClone(doc);
    copy["models"].nodes = change(copy["models"].nodes);
    return copy;
}

test(`${COUNT} siblings edited on both sides merge fast`, () => {
    const base = assembly();
    const ours = edit(base, (nodes) => {
        for (let i = 0; i < 300; i++) nodes[2 + i * 30].name += " (checked)";
        const added = Array.from({ length: 100 }, (_, i) => ({
            id: `ours-${i}`,
            name: `New ${i}`,
            parentId: "parts",
        }));
        return [...nodes.slice(0, -1), ...added, nodes.at(-1)!];
    });
    const theirs = edit(base, (nodes) => {
        const gone = new Set(Array.from({ length: 200 }, (_, i) => `n${i * 50 + 7}`));
        const kept = nodes.filter((n) => !gone.has(n.id));
        // 100 parts moved to the front, 100 more into Spares
        const front = kept
            .filter((n) => /^n\d+$/.test(n.id) && Number(n.id.slice(1)) % 97 === 1)
            .slice(0, 100);
        const moved = kept
            .filter((n) => /^n\d+$/.test(n.id) && Number(n.id.slice(1)) % 89 === 3 && !front.includes(n))
            .slice(0, 100);
        const skip = new Set([...front, ...moved].map((n) => n.id));
        const rest = kept.filter((n) => !skip.has(n.id));
        const parts = rest.findIndex((n) => n.id === "parts");
        const spares = rest.findIndex((n) => n.id === "spares");
        return [
            ...rest.slice(0, parts + 1),
            ...front,
            ...rest.slice(parts + 1, spares + 1),
            ...moved.map((n) => ({ ...n, parentId: "spares" })),
            ...rest.slice(spares + 1),
        ];
    });

    const start = performance.now();
    const result = mergeDocuments(base, ours, theirs);
    const elapsed = performance.now() - start;

    expect(result.isOk).toBe(true);
    const nodes = result.value.merged["models"].nodes as Node[];
    expect(result.value.conflicts).toEqual([]);
    // 10 000 + 3 folders + 100 new - 200 deleted
    expect(nodes.length).toBe(COUNT + 3 + 100 - 200);
    expect(nodes.filter((n) => n.parentId === "spares")).toHaveLength(100);
    expect(nodes.filter((n) => n.name.endsWith("(checked)")).length).toBeGreaterThan(290);
    // theirs moved 100 parts to the front of Parts; ours appended 100 at the end
    expect(nodes[2].id).toBe(theirs["models"].nodes[2].id);
    expect(nodes.findLast((n) => n.parentId === "parts")?.id).toBe("ours-99");
    console.info(`merge of ${COUNT} siblings: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(5000);
});
