// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AutosaveHolds,
    type DocumentSource,
    EditSessions,
    type IDocument,
    type INode,
    Logger,
    Result,
    type Serialized,
    SidePanels,
} from "@spicy3d/core";
import type { ConflictPanel } from "../src/conflicts/conflictPanel";
import { MergePreviewRepository, mergePreviewOf } from "../src/conflicts/mergePreview";
import { MERGE_REPORT_FORMAT } from "../src/conflicts/mergeReport";
import { FakeDocumentServer } from "./_helpers/fakeDocumentServer";
import { FakeServer, TestRequest } from "./_helpers/fakeServer";
import {
    Device,
    documentData,
    FakeEventsServer,
    FlakyNetwork,
    SyncDoc,
    until,
    valuesOf,
} from "./_helpers/syncHarness";

// The conflict resolution UI (CLOUD-13) over the real sync engine and a fake server: the panel
// opened from the conflict, choices by path, the live preview in a separate document, finishing
// (validated) into a `merge` version, a newer head during resolution, save as a copy, and the
// clean merge's "Undo merge".

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

let devices: Device[];
let server: FakeServer;
let docs: FakeDocumentServer;
let events: FakeEventsServer;

beforeEach(() => {
    devices = [];
    server = new FakeServer();
    docs = new FakeDocumentServer(server);
    events = new FakeEventsServer(docs);
    rs.spyOn(Logger, "info").mockImplementation(() => {});
    rs.spyOn(Logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
    for (const device of devices) device.dispose();
    for (const panel of [...SidePanels.items]) SidePanels.items.remove(panel);
    rs.restoreAllMocks();
    for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
});

async function device(options?: Parameters<typeof Device.start>[3]) {
    const started = await Device.start(server, events, new FlakyNetwork(server), {
        deviceName: "Desktop",
        ...options,
    });
    devices.push(started);
    return started;
}

const head = (id = "doc-1") => docs.head(id)!;
const headValues = (id = "doc-1") => valuesOf(docs.content(head(id)));

/**
 * Device `a` with `doc-1` in conflict: this device changed the variables to `ours` (a pending
 * save), the tablet to `theirs` meanwhile.
 */
async function conflictOn(
    a: Device,
    base: Record<string, string>,
    ours: Record<string, string>,
    theirs: Record<string, string>,
    nodes: Serialized[] = [],
    oursNodes = nodes,
    theirsNodes = nodes,
) {
    const doc = await a.create("doc-1", base, nodes);
    a.network.down = true;
    doc.replaceContent(documentData("doc-1", ours, "Bracket", oursNodes), "edit");
    await doc.save("auto");
    const other = await docs.saveContentElsewhere(
        "doc-1",
        documentData("doc-1", theirs, "Bracket", theirsNodes),
        "Tablet",
    );
    a.network.down = false;
    a.engine.refreshAll();
    await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");
    return { doc, other };
}

function openPanel(a: Device, doc: SyncDoc): ConflictPanel {
    const panel = a.documents.openConflicts(doc as unknown as IDocument);
    expect(panel).not.toBeUndefined();
    return panel!;
}

function rowOf(panel: ConflictPanel, path: string): HTMLElement {
    const row = [...panel.querySelectorAll<HTMLElement>("[data-path]")].find(
        (r) => r.dataset["path"] === path,
    );
    expect(row).not.toBeUndefined();
    return row!;
}

function choose(panel: ConflictPanel, path: string, choice: string) {
    const button = rowOf(panel, path).querySelector<HTMLButtonElement>(`[data-choice="${choice}"]`);
    expect(button).not.toBeNull();
    button!.click();
}

const W = "variable/w/expression";
const H = "variable/h/expression";

describe("the conflict panel", () => {
    test("opens from the conflict pill, labels the sides, holds the sync and autosave while open", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        await a.documents.resolveConflict(doc as unknown as IDocument);
        const panel = a.documents.conflicts!;

        expect([...SidePanels.items]).toContain(panel);
        expect(document.querySelector("dialog[open]")).toBeNull();
        expect(AutosaveHolds.isHeld).toBe(true);
        const sides = panel.textContent ?? "";
        expect(sides).toContain("Desktop");
        expect(sides).toContain("Tablet");
        const row = rowOf(panel, W);
        expect(row.dataset["kind"]).toBe("property");
        expect(row.querySelector("[data-values]")?.textContent).toContain("20");
        expect(row.querySelector("[data-values]")?.textContent).toContain("30");
        expect(row.querySelector("[data-values]")?.getAttribute("title")).toContain("10");
        expect(
            [...row.querySelectorAll<HTMLElement>("[data-choice]")].map((b) => b.dataset["choice"]),
        ).toEqual(["ours", "theirs"]);

        a.documents.closeConflicts();
        expect([...SidePanels.items]).not.toContain(panel);
        // Still in conflict: the pill opens it again.
        expect(a.repository.stateOf("doc-1")).toBe("conflict");
    });

    test("finishing pushes the merge of the choices as a two-parent merge version", async () => {
        const a = await device();
        const { doc, other } = await conflictOn(
            a,
            { w: "10", h: "5" },
            { w: "20", h: "6" },
            { w: "30", h: "7" },
        );
        const base = (await a.store.get("doc-1"))!.baseVersion!.id;
        const panel = openPanel(a, doc);

        choose(panel, W, "theirs");
        expect(rowOf(panel, W).hasAttribute("data-resolved")).toBe(true);
        expect(rowOf(panel, W).querySelector('[data-choice="theirs"]')?.getAttribute("aria-pressed")).toBe(
            "true",
        );
        // One left: finishing says so and pushes nothing.
        await panel.finish();
        expect(panel.querySelector("[role=status]")?.textContent).toBe("cloud.merge.stillOpen1");
        expect(head().id).toBe(other.id);

        choose(panel, H, "ours");
        await panel.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");

        expect(head().kind).toBe("merge");
        expect(head().parentIds).toEqual([other.id, base]);
        expect(headValues()).toEqual({ w: "30", h: "6" });
        expect(doc.values).toEqual({ w: "30", h: "6" });
        expect(a.documents.conflicts).toBeUndefined();
        expect(AutosaveHolds.isHeld).toBe(false);
    });

    test("'Keep all from this device' / 'Take all from <other>' choose every conflict", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10", h: "5" }, { w: "20", h: "6" }, { w: "30", h: "7" });
        const panel = openPanel(a, doc);

        panel.querySelector<HTMLButtonElement>('[data-action="takeAllTheirs"]')!.click();
        expect(panel.resolution.rows.map((r) => r.choice)).toEqual(["theirs", "theirs"]);
        panel.querySelector<HTMLButtonElement>('[data-action="keepAllMine"]')!.click();
        expect(panel.resolution.rows.map((r) => r.choice)).toEqual(["ours", "ours"]);
        await panel.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");
        expect(headValues()).toEqual({ w: "20", h: "6" });
    });

    test("selecting a conflict selects the node it is about in this device's document", async () => {
        const nodes = [{ __cla$$__: "GroupNode", id: "n1", name: "Part", visible: true }];
        const a = await device();
        const { doc } = await conflictOn(
            a,
            { w: "10" },
            { w: "10" },
            { w: "10" },
            nodes,
            [{ ...nodes[0], name: "Mine" }],
            [{ ...nodes[0], name: "Theirs" }],
        );
        const node = { id: "n1", name: "Mine" } as unknown as INode;
        const setSelectedNodes = rs.fn((_nodes: INode[], _toggle: boolean) => 1);
        Object.assign(doc, {
            modelManager: {
                findNode: (predicate: (n: INode) => boolean) => (predicate(node) ? node : undefined),
            },
            selection: { setSelectedNodes },
        });
        const panel = openPanel(a, doc);
        const [row] = panel.resolution.rows;
        expect(row.conflict.path).toBe("node/n1/prop/name");
        expect(panel.querySelector<HTMLElement>('[data-group="n1"]')).not.toBeNull();

        rowOf(panel, "node/n1/prop/name").querySelector<HTMLButtonElement>("button")!.click();

        expect(setSelectedNodes).toHaveBeenCalledWith([node], false);
        expect(rowOf(panel, "node/n1/prop/name").hasAttribute("data-selected")).toBe(true);

        setSelectedNodes.mockClear();
        panel.querySelector<HTMLElement>('[data-group="n1"] h3 button')!.click();
        expect(setSelectedNodes).toHaveBeenCalledWith([node], false);
    });

    test("the live preview is a separate read-only document following the choices; mine is untouched", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const loads: DocumentSource[] = [];
        const panel = openPanel(a, doc);
        Object.assign(panel.resolution.options, {
            previewDelayMs: 5,
            loadPreview: async (data: Serialized, source: DocumentSource) => {
                loads.push(source);
                return new SyncDoc(a.app, data, source.repository!) as unknown as IDocument;
            },
        });
        const replacedBefore = doc.replaced.length;

        panel.querySelector<HTMLButtonElement>('[data-action="showPreview"]')!.click();
        await until(() => panel.resolution.previewDocument !== undefined, "the preview");
        const preview = panel.resolution.previewDocument as unknown as SyncDoc;
        expect(loads[0].repository).toBeInstanceOf(MergePreviewRepository);
        expect(mergePreviewOf(preview as unknown as IDocument)?.documentId).toBe("doc-1");
        expect(preview.id).not.toBe("doc-1");
        // The unresolved merge holds the first choice: mine.
        expect(preview.values).toEqual({ w: "20" });
        expect((await preview.save("manual")).isOk).toBe(false);

        choose(panel, W, "theirs");
        await until(() => preview.values["w"] === "30", "the preview updated");
        expect(preview.replaced).toEqual(["merge preview"]);
        expect(doc.values).toEqual({ w: "20" });
        expect(doc.replaced.length).toBe(replacedBefore);

        panel.querySelector<HTMLButtonElement>('[data-action="hidePreview"]')!.click();
        await until(() => panel.resolution.previewDocument === undefined, "the preview closed");
        expect(a.app.documents.has(preview as unknown as IDocument)).toBe(false);
    });

    test("a rebuild failure needs an explicit accept (or a fix and re-validate) before the merge is pushed", async () => {
        const nodes = [{ __cla$$__: "GroupNode", id: "n1", name: "Part", visible: true }];
        const evaluate = rs.fn(async (data: Serialized) => {
            const values = valuesOf(data);
            const broken = values["w"] === "99" && values["h"] === "6";
            return Result.ok(
                new Map(broken ? [["node/n1/rebuild", { nodeId: "n1", label: "Part", error: "boom" }]] : []),
            );
        });
        const a = await device({ sync: { evaluator: { evaluate } } });
        const { doc } = await conflictOn(
            a,
            { w: "10", h: "5" },
            { w: "10", h: "6" },
            { w: "99", h: "5" },
            nodes,
        );
        const panel = openPanel(a, doc);
        const row = rowOf(panel, "node/n1/rebuild");
        expect(row.dataset["kind"]).toBe("rebuild-failure");
        expect(row.querySelector('[data-action="openFailing"]')).not.toBeNull();

        await panel.finish();
        expect(panel.querySelector("[role=status]")?.textContent).toBe("cloud.merge.acceptFailures1");
        expect(head().kind).not.toBe("merge");

        // Fixed here (h back to 5): re-validated, the failure is gone.
        doc.edit("h", "5");
        await panel.revalidate();
        expect(panel.resolution.rows).toEqual([]);
        doc.edit("h", "6");
        await panel.revalidate();
        choose(panel, "node/n1/rebuild", "accept");
        await panel.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");
        expect(head().kind).toBe("merge");
        expect(headValues()).toEqual({ w: "99", h: "6" });
    });

    test("a newer head during resolution re-merges and keeps the choices by path; a gone path is dropped with a note", async () => {
        const a = await device();
        const { doc } = await conflictOn(
            a,
            { w: "10", h: "5", d: "1" },
            { w: "20", h: "6", d: "1" },
            { w: "30", h: "7", d: "1" },
        );
        const panel = openPanel(a, doc);
        choose(panel, W, "theirs");
        choose(panel, H, "ours");

        // The tablet saves again: d changed (no conflict), h back to the base (h no longer conflicts).
        const newer = await docs.saveContentElsewhere(
            "doc-1",
            documentData("doc-1", { w: "30", h: "5", d: "2" }),
            "Tablet",
        );
        await until(() => a.engine.syncConflictOf("doc-1")?.theirs.versionId === newer.id, "re-merged");

        expect(panel.resolution.rows.map((r) => [r.conflict.path, r.choice])).toEqual([[W, "theirs"]]);
        const notes = panel.querySelector("[data-notes]")?.textContent ?? "";
        expect(notes).toContain("cloud.merge.remoteUpdatedTablet");
        expect(notes).toContain("cloud.merge.droppedmerge.conflict.property");
        await panel.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");
        expect(head().parentIds[0]).toBe(newer.id);
        expect(headValues()).toEqual({ w: "30", h: "6", d: "2" });
    });

    test("save as a copy: the other version stays the head, a new document holds mine", async () => {
        const a = await device();
        const { doc, other } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const panel = openPanel(a, doc);

        panel.querySelector<HTMLButtonElement>('[data-action="saveCopy"]')!.click();
        await until(() => [...a.app.documents].some((x) => x.id !== "doc-1"), "the copy opened");
        await a.engine.settle();

        expect(head().id).toBe(other.id);
        expect(headValues()).toEqual({ w: "30" });
        const copy = [...a.app.documents].find((x) => x.id !== "doc-1") as unknown as SyncDoc;
        expect(copy.values).toEqual({ w: "20" });
        expect(headValues(copy.id)).toEqual({ w: "20" });
        expect(copy.name).toBe("cloud.conflict.copyNameBracket");
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
        expect(a.documents.conflicts).toBeUndefined();
    });

    test("the merge report holds the three versions, the conflicts and the choices", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const panel = openPanel(a, doc);
        choose(panel, W, "theirs");

        const report = panel.resolution.report();
        expect(report.format).toBe(MERGE_REPORT_FORMAT);
        expect(report.documentId).toBe("doc-1");
        expect(valuesOf(report.base as Serialized)).toEqual({ w: "10" });
        expect(valuesOf(report.ours as Serialized)).toEqual({ w: "20" });
        expect(valuesOf(report.theirs as Serialized)).toEqual({ w: "30" });
        expect(report.conflicts.map((c) => [c.path, c.choice])).toEqual([[W, "theirs"]]);
        expect(report.sides.theirs.deviceName).toBe("Tablet");
        expect(Number.isFinite(Date.parse(report.exportedAt))).toBe(true);
    });

    test("an agent's version is labelled 'Agent (MCP)'", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "20");
        await doc.save("auto");
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }), "Laptop", "mcp");
        a.network.down = false;
        a.engine.refreshAll();
        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");
        const panel = openPanel(a, doc);

        expect(a.engine.syncConflictOf("doc-1")?.theirs.kind).toBe("mcp");
        expect(panel.textContent).toContain("cloud.merge.agent");
        expect(panel.textContent).not.toContain("Laptop");
    });

    test("the conflict toast offers Resolve, which opens the panel", async () => {
        const a = await device();
        await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const [resolve] = a.toastActions("cloud.sync.conflict{0}");
        expect(resolve.label).toBe("cloud.merge.resolve");

        resolve.run();
        await until(() => a.documents.conflicts !== undefined, "the panel");
    });
});

describe("resolving safely (review fixes)", () => {
    test("resolve waits for a re-merge already running: the resolved conflict never comes back", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const panel = openPanel(a, doc);
        choose(panel, W, "ours");
        // The next head fetch (the re-merge of a newer version) is slow: it answers after a resolve
        // that did not wait for it would be done.
        const fetchHead = a.repository.fetchHead.bind(a.repository);
        let fetches = 0;
        rs.spyOn(a.repository, "fetchHead").mockImplementation(async (id: string) => {
            fetches++;
            if (fetches === 1) await new Promise((resolve) => setTimeout(resolve, 300));
            return fetchHead(id);
        });
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30", d: "1" }), "Tablet");
        await until(() => fetches > 0, "the re-merge started");

        const resolved = await a.engine.resolve("doc-1", [{ path: W, choice: "ours" }]);
        await a.engine.settle();

        expect(resolved.isOk).toBe(true);
        expect(a.engine.syncConflictOf("doc-1")).toBeUndefined();
        expect(a.repository.stateOf("doc-1")).not.toBe("conflict");
        expect(a.toasted("cloud.sync.conflict{0}")).toHaveLength(1);
        a.documents.closeConflicts();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");
        expect(headValues()).toEqual({ w: "20", d: "1" });
    });

    test("resolve pushes only the merge expected: another head or merge comes back 'changed', labels updated", async () => {
        const a = await device();
        const { doc, other } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const choices = [{ path: W, choice: "theirs" as const }];

        const stale = await a.engine.resolve("doc-1", choices, { headVersionId: "an-older-head" });
        expect(!stale.isOk && stale.error.kind).toBe("changed");
        expect(a.engine.syncConflictOf("doc-1")?.theirs.versionId).toBe(other.id);
        const different = await a.engine.resolve("doc-1", choices, { headVersionId: other.id, merged: "{}" });
        expect(!different.isOk && different.error.kind).toBe("changed");
        expect(a.repository.stateOf("doc-1")).toBe("conflict");
        expect(head().id).toBe(other.id);
        expect(doc.values).toEqual({ w: "20" });
    });

    test("Finish refuses when an edit dropped a choice: the note shows, nothing pushed; again, it pushes", async () => {
        const a = await device();
        const { doc, other } = await conflictOn(
            a,
            { w: "10", h: "5" },
            { w: "20", h: "6" },
            { w: "30", h: "7" },
        );
        const panel = openPanel(a, doc);
        choose(panel, W, "ours");
        choose(panel, H, "ours");
        // Edited here to the other side's value: no conflict on w any more, the choice is dropped.
        doc.edit("w", "30");

        await panel.finish();

        expect(panel.querySelector("[role=status]")?.textContent).toBe("cloud.merge.changed");
        expect(panel.querySelector("[data-notes]")?.textContent).toContain("cloud.merge.dropped");
        expect(head().id).toBe(other.id);
        await panel.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");
        expect(headValues()).toEqual({ w: "30", h: "6" });
    });

    test("nothing is replaced under a running command; an open edit session is ended first", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const choices = [{ path: W, choice: "theirs" as const }];
        (a.app as { executingCommand?: unknown }).executingCommand = {};
        const busy = await a.engine.resolve("doc-1", choices);
        expect(!busy.isOk && busy.error.kind).toBe("busy");
        expect(doc.values).toEqual({ w: "20" });

        (a.app as { executingCommand?: unknown }).executingCommand = undefined;
        const end = rs.fn(() => release());
        const release = EditSessions.begin(doc as unknown as IDocument, end);
        expect(EditSessions.isActive(doc as unknown as IDocument)).toBe(true);
        const resolved = await a.engine.resolve("doc-1", choices);
        expect(resolved.isOk).toBe(true);
        expect(end).toHaveBeenCalledTimes(1);
        expect(EditSessions.isActive(doc as unknown as IDocument)).toBe(false);
        expect(doc.values).toEqual({ w: "30" });
    });

    test("the panel stays while the conflict remains without a merge result, and keeps the last one", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const panel = openPanel(a, doc);
        const conflict = a.engine.syncConflictOf("doc-1")!;
        rs.spyOn(a.engine, "syncConflictOf").mockReturnValue({ ...conflict, result: undefined });

        (a.engine as unknown as { emit(id: string): void }).emit("doc-1");

        expect(a.documents.conflicts).toBe(panel);
        expect(panel.resolution.rows.map((r) => r.conflict.path)).toEqual([W]);
    });

    test("a Finish that throws shows the error and leaves the panel usable", async () => {
        const a = await device();
        const { doc } = await conflictOn(a, { w: "10" }, { w: "20" }, { w: "30" });
        const panel = openPanel(a, doc);
        rs.spyOn(panel.resolution, "finish").mockRejectedValue(new Error("boom"));

        await panel.finish();

        expect(panel.querySelector("[role=status]")?.textContent).toBe("cloud.merge.failedboom");
        const keep = rowOf(panel, W).querySelector<HTMLButtonElement>('[data-choice="ours"]')!;
        expect(keep.disabled).toBe(false);
    });
});

describe("a clean merge", () => {
    /** `doc-1` with a pending save here and a non-conflicting change on the tablet, merged cleanly. */
    async function cleanMerge(a: Device) {
        const doc = await a.create("doc-1", { w: "10", h: "5" });
        a.network.down = true;
        doc.edit("h", "6");
        await doc.save("auto");
        const other = await docs.saveContentElsewhere(
            "doc-1",
            documentData("doc-1", { w: "99", h: "5" }),
            "Tablet",
        );
        a.network.down = false;
        a.engine.refreshAll();
        await until(
            () => head().kind === "merge" && a.repository.stateOf("doc-1") === "saved",
            "merged and pushed",
        );
        return { doc, other };
    }

    test("is toasted with View changes and Undo merge; View changes lists what came in", async () => {
        const a = await device();
        await cleanMerge(a);
        const actions = a.toastActions("cloud.sync.mergedFrom{0}");
        expect(actions.map((x) => x.label)).toEqual(["cloud.merge.viewChanges", "cloud.merge.undo"]);
        expect(a.toasted("cloud.sync.mergedFrom{0}")).toEqual([["Tablet"]]);

        actions[0].run();
        await until(() => document.querySelector("dialog[open]") !== null, "the changes");
        const items = [...document.querySelectorAll("dialog[open] li")];
        expect(items.length).toBe(1);
        expect(items[0].textContent).toContain("diff.changedValue");
        expect(items[0].textContent).toContain("1099");
    });

    test("Undo merge restores the pre-merge local state as one undo step and waits instead of merging again", async () => {
        const a = await device();
        const { doc } = await cleanMerge(a);
        const merge = head();
        expect(doc.values).toEqual({ w: "99", h: "6" });
        const steps = doc.undoSteps;

        const [, undo] = a.toastActions("cloud.sync.mergedFrom{0}");
        undo.run();
        await until(() => a.repository.stateOf("doc-1") === "conflict", "held after the undo");
        await a.engine.settle();

        expect(doc.values).toEqual({ w: "10", h: "6" });
        expect(doc.undoSteps).toBe(steps + 1);
        expect(doc.replaced.at(-1)).toBe("undo merge");
        expect(a.toasted("cloud.merge.undone")).toHaveLength(1);
        // Nothing pushed on top of the merge (which would revert the tablet's change), nothing merged again.
        expect(head().id).toBe(merge.id);
        const record = await a.store.get("doc-1");
        expect(record?.localDirty).toBe(true);
        expect(valuesOf(await a.repository.load("doc-1").then((x) => x.value.data))).toEqual({
            w: "10",
            h: "6",
        });
        expect(a.engine.syncConflictOf("doc-1")?.undone).toBe(true);
        // The panel opened with "Merge again".
        const panel = a.documents.conflicts!;
        expect(panel.querySelector('[data-action="mergeAgain"]')).not.toBeNull();

        await panel.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "merged again");
        expect(head().kind).toBe("merge");
        expect(headValues()).toEqual({ w: "99", h: "6" });
        expect(doc.values).toEqual({ w: "99", h: "6" });
    });

    test("Undo merge re-checks right before replacing: a save written meanwhile wins, the record goes back", async () => {
        const a = await device();
        const { doc } = await cleanMerge(a);
        const merge = head();
        const put = a.store.put.bind(a.store);
        let edited = false;
        rs.spyOn(a.store, "put").mockImplementation(async (record) => {
            await put(record);
            if (!edited && record.baseVersion?.id !== merge.id) {
                // The user edits while the undo writes the record.
                edited = true;
                doc.edit("w", "12");
            }
        });

        const undone = await a.engine.undoMerge("doc-1");

        expect(!undone.isOk && undone.error.kind).toBe("edited");
        expect(edited).toBe(true);
        expect(doc.values).toEqual({ w: "12", h: "6" });
        expect(doc.replaced.at(-1)).not.toBe("undo merge");
        expect((await a.store.get("doc-1"))?.baseVersion?.id).toBe(merge.id);
        expect(a.repository.stateOf("doc-1")).not.toBe("conflict");
    });

    test("Undo merge is refused while a command runs", async () => {
        const a = await device();
        const { doc } = await cleanMerge(a);
        (a.app as { executingCommand?: unknown }).executingCommand = {};

        const undone = await a.engine.undoMerge("doc-1");

        expect(!undone.isOk && undone.error.kind).toBe("busy");
        expect(doc.values).toEqual({ w: "99", h: "6" });
    });

    test("Undo merge is refused once the document was edited after the merge", async () => {
        const a = await device();
        const { doc } = await cleanMerge(a);
        doc.edit("w", "12");

        const undone = await a.engine.undoMerge("doc-1");
        expect(undone.isOk).toBe(false);
        expect(!undone.isOk && undone.error.kind).toBe("edited");
        expect(doc.values).toEqual({ w: "12", h: "6" });
    });
});
