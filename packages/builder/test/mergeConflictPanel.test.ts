// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type ConflictPanel, reapplyResolutions } from "@spicy3d/cloud";
import {
    type IDocument,
    Logger,
    type MergeResolution,
    mergeDocuments,
    type ResolutionChoice,
    Result,
    resolveMerge,
    type Serialized,
    SidePanels,
} from "@spicy3d/core";
import { loadMergeFixtures, type MergeFixture } from "@spicy3d/core/test-utils";
import { FakeDocumentServer } from "../../cloud/test/_helpers/fakeDocumentServer";
import { FakeServer, TestRequest } from "../../cloud/test/_helpers/fakeServer";
import {
    Device,
    FakeEventsServer,
    FlakyNetwork,
    SyncDoc,
    until,
} from "../../cloud/test/_helpers/syncHarness";
// Every package that registers merge rules.
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// CLOUD-13: every CLOUD-11 fixture resolved through the conflict panel, over the real sync engine
// and a fake server — this device saved `ours` offline, another device saved `theirs`; the panel
// picks, for every conflict (and every conflict a choice creates), its n-th choice, finishes, and
// the pushed `merge` version is exactly `resolveMerge` of the fixture with those choices. A case
// without conflicts merges on its own; `rebuild-failure-thin-wall` needs its failure accepted
// (the kernel is stood in for by an evaluator reporting the fixture's failure on the merge).

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

let devices: Device[] = [];

afterEach(() => {
    for (const device of devices) device.dispose();
    devices = [];
    for (const panel of [...SidePanels.items]) SidePanels.items.remove(panel);
    rs.restoreAllMocks();
});

const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The fixture's rebuild failures, reported for its merged document only (the kernel's verdict). */
function evaluatorFor(fixture: MergeFixture) {
    const failures = fixture.conflicts.filter((c) => c.kind === "rebuild-failure");
    const merged = JSON.stringify(asStored(fixture.expected));
    return {
        evaluate: async (data: Serialized) => {
            const broken = failures.length > 0 && JSON.stringify(asStored(data)) === merged;
            return Result.ok(
                new Map(
                    broken
                        ? failures.map((c) => {
                              const [, nodeId, , featureId] = c.path.split("/");
                              return [
                                  c.path,
                                  {
                                      nodeId,
                                      label: String(c.args[0]),
                                      error: "thin wall",
                                      ...(c.path.includes("/feature/") ? { featureId } : {}),
                                  },
                              ] as const;
                          })
                        : [],
                ),
            );
        },
    };
}

/** `ours` pending on this device, `theirs` saved by another one: merged by the sync. */
async function diverge(fixture: MergeFixture) {
    rs.spyOn(Logger, "info").mockImplementation(() => {});
    rs.spyOn(Logger, "warn").mockImplementation(() => {});
    const server = new FakeServer();
    const docs = new FakeDocumentServer(server);
    const events = new FakeEventsServer(docs);
    const a = await Device.start(server, events, new FlakyNetwork(server), {
        deviceName: "Desktop",
        sync: { evaluator: evaluatorFor(fixture) },
    });
    devices.push(a);
    const id = fixture.base["id"] as string;
    const doc = new SyncDoc(a.app, fixture.base, a.repository);
    await doc.save("manual");
    await a.engine.settle();
    a.network.down = true;
    expect(doc.replaceContent(fixture.ours, "edit").isOk).toBe(true);
    await doc.save("auto");
    await docs.saveContentElsewhere(id, fixture.theirs, "Tablet");
    a.network.down = false;
    a.engine.refreshAll();
    const head = () => docs.head(id)!;
    // Merged and pushed, adopted (the same change on both sides), or waiting for the user.
    await until(() => ["conflict", "saved"].includes(a.repository.stateOf(id)), "merged or in conflict");
    await a.engine.settle();
    return { a, docs, doc, id, head };
}

/** Picks, for each row still without a choice (new ones too), its `n`-th choice (the last if fewer). */
function resolveThrough(panel: ConflictPanel, n: number): MergeResolution[] {
    const picked: MergeResolution[] = [];
    for (let guard = 0; guard < 50; guard++) {
        const row = [...panel.querySelectorAll<HTMLElement>("[data-path]")].find(
            (r) => !r.hasAttribute("data-resolved"),
        );
        if (!row) return picked;
        const buttons = [...row.querySelectorAll<HTMLButtonElement>("[data-choice]")];
        expect(buttons.length).toBeGreaterThan(0);
        const button = buttons[Math.min(n, buttons.length - 1)];
        picked.push({ path: row.dataset["path"]!, choice: button.dataset["choice"] as ResolutionChoice });
        button.click();
    }
    throw new Error("the conflicts never ran out");
}

const fixtures = loadMergeFixtures();
const cases = fixtures.flatMap((fixture) => {
    const widest = Math.max(1, ...fixture.conflicts.map((c) => c.choices.length));
    return Array.from({ length: widest }, (_, n) => [fixture.name, n, fixture] as const);
});

describe("every merge fixture resolved through the conflict panel", () => {
    test.each(cases)("%s, choice #%i of every conflict", async (_name, n, fixture) => {
        const { a, docs, doc, id, head } = await diverge(fixture);
        const merged = mergeDocuments(fixture.base, fixture.ours, fixture.theirs);
        expect(merged.isOk).toBe(true);

        if (fixture.conflicts.length === 0) {
            // Clean: merged on its own and pushed (the toast offers View changes / Undo merge),
            // or nothing to merge (the same change on both sides).
            const same = JSON.stringify(fixture.ours) === JSON.stringify(fixture.theirs);
            expect(a.repository.stateOf(id)).toBe("saved");
            expect(asStored(docs.content(head()))).toEqual(asStored(fixture.expected));
            expect(head().kind).toBe(same ? "auto" : "merge");
            expect(a.toastActions("cloud.sync.mergedFrom{0}").map((x) => x.label)).toEqual(
                same ? [] : ["cloud.merge.viewChanges", "cloud.merge.undo"],
            );
            return;
        }

        expect(a.repository.stateOf(id)).toBe("conflict");
        const panel = a.documents.openConflicts(doc as unknown as IDocument);
        expect(panel).not.toBeUndefined();
        const expectedKinds = fixture.conflicts.map((c) => c.kind);
        expect(panel!.resolution.rows.map((r) => r.conflict.kind)).toEqual(expectedKinds);

        const picked = resolveThrough(panel!, n);
        await panel!.finish();
        await until(() => head().kind === "merge" && a.repository.stateOf(id) === "saved", "pushed");

        // An accepted rebuild failure changes nothing in the merge.
        const structural = picked.filter((p) => !p.path.endsWith("/rebuild"));
        const expected = reapplyResolutions(merged.value, structural);
        expect(expected.isOk).toBe(true);
        expect(expected.value.dropped).toEqual([]);
        expect(expected.value.result.conflicts.filter((c) => c.kind !== "rebuild-failure")).toEqual([]);
        expect(asStored(docs.content(head()))).toEqual(asStored(expected.value.result.merged));
        expect(asStored(doc.serialize())).toEqual(asStored(expected.value.result.merged));
        expect(a.documents.conflicts).toBeUndefined();
    });
});

describe("reapplyResolutions", () => {
    const rename = fixtures.find((f) => f.name === "rename-variable-vs-new-expression")!;
    const depth = "node/body-1/feature/f1/param/depth";
    const created = "variable/v2/expression";

    test("answers, in one call, a conflict another choice creates (resolveMerge alone refuses it)", () => {
        const merged = mergeDocuments(rename.base, rename.ours, rename.theirs);
        expect(merged.isOk).toBe(true);
        const choices: MergeResolution[] = [
            { path: depth, choice: "theirs" },
            { path: created, choice: "accept" },
        ];
        const single = resolveMerge(merged.value, choices);
        expect(!single.isOk && single.error).toEqual({ kind: "unknownConflict", path: created });

        const reapplied = reapplyResolutions(merged.value, choices);

        expect(reapplied.isOk).toBe(true);
        expect(reapplied.value.applied).toEqual(choices);
        expect(reapplied.value.dropped).toEqual([]);
        expect(reapplied.value.result.conflicts).toEqual([]);
    });

    test("drops the choices whose path the merge does not have, or whose choice it does not offer", () => {
        const merged = mergeDocuments(rename.base, rename.ours, rename.theirs);
        const reapplied = reapplyResolutions(merged.value, [
            { path: "node/gone/prop/name", choice: "ours" },
            { path: depth, choice: "theirs-first" },
        ]);

        expect(reapplied.value.applied).toEqual([]);
        expect(reapplied.value.dropped.map((d) => d.path)).toEqual(["node/gone/prop/name", depth]);
        expect(reapplied.value.result.merged).toEqual(merged.value.merged);
    });
});
