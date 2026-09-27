// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    AutosaveHolds,
    AutosaveSettings,
    AutosaveStatus,
    type DialogButton,
    type FileAutosaveState,
    type IApplication,
    type ICommand,
    type IDocument,
    type IFileAutosave,
    ObjectStorage,
    type PropertyChangedHandler,
    PubSub,
    Result,
    type SaveOutcome,
    type SaveRequest,
    Transaction,
} from "@spicy3d/core";
import { createMockApplication, MemoryDocumentRepository } from "@spicy3d/core/test-utils";
import { Document } from "../../src/document";
import { AutosaveService } from "../../src/services/autosaveService";

const MINUTE = 60_000;

/** A mock application whose `executingCommand` notifies like the real one. */
function observableApp(): IApplication {
    const app = createMockApplication();
    type Handler = PropertyChangedHandler<IApplication, keyof IApplication>;
    const listeners = new Set<Handler>();
    let executing: ICommand | undefined;
    Object.defineProperty(app, "executingCommand", {
        get: () => executing,
        set: (value: ICommand | undefined) => {
            const old = executing;
            executing = value;
            for (const listener of listeners) listener("executingCommand", app, old);
        },
    });
    app.onPropertyChanged = (handler) => {
        listeners.add(handler as Handler);
    };
    app.removePropertyChanged = (handler) => {
        listeners.delete(handler as Handler);
    };
    return app;
}

/** A repository that answers each save only once `release()` is called; `requested` = every call. */
function slowRepository() {
    const waiting: (() => void)[] = [];
    const repository = new (class extends MemoryDocumentRepository {
        readonly requested: SaveRequest[] = [];
        override async save(request: SaveRequest) {
            this.requested.push(request);
            await new Promise<void>((resolve) => waiting.push(resolve));
            return super.save(request);
        }
    })("cloud");
    return Object.assign(repository, { release: () => waiting.splice(0).forEach((x) => x()) });
}

/** A per-file opt-in fake: every document is in the given state. */
function files(state: FileAutosaveState): IFileAutosave {
    return { state: () => state, set: async () => state === "on" };
}

describe("AutosaveService", () => {
    let app: IApplication;
    let repository: MemoryDocumentRepository;
    let settings: AutosaveSettings;
    let status: AutosaveStatus;
    let dialogOpen: boolean;
    let service: AutosaveService;
    let document: Document;
    const kinds = () => repository.saves.map((x) => x.kind);

    const edit = (name: string) =>
        Transaction.execute(document, "rename", () => {
            document.modelManager.rootNode.name = name;
        });

    function start(
        options: { files?: IFileAutosave; writeFile?: (document: IDocument) => Promise<Result<void>> } = {},
    ) {
        service = new AutosaveService({
            settings,
            status,
            files: options.files ?? files("unavailable"),
            writeFile: options.writeFile,
            isDialogOpen: () => dialogOpen,
        });
        service.register(app);
        service.start();
    }

    beforeEach(() => {
        rs.useFakeTimers({ now: Date.parse("2026-09-27T12:00:00Z") });
        app = observableApp();
        repository = new MemoryDocumentRepository("cloud");
        settings = new AutosaveSettings(new ObjectStorage("spicy3d-test", `autosave-${Math.random()}`));
        status = new AutosaveStatus();
        dialogOpen = false;
        document = new Document(app, "Bracket", "doc-1", { repository });
    });

    afterEach(() => {
        service?.stop();
        document.dispose();
        rs.useRealTimers();
    });

    test("a dirty document is autosaved at the interval (5 minutes by default) as an `auto` version", async () => {
        start();
        edit("changed");

        await rs.advanceTimersByTimeAsync(5 * MINUTE - 1000);
        expect(repository.saves).toHaveLength(0);

        await rs.advanceTimersByTimeAsync(1000);
        expect(kinds()).toEqual(["auto"]);
        expect(document.isDirty).toBe(false);
        expect(status.lastAutosavedAt(document)).toBe(Date.parse("2026-09-27T12:05:00Z"));
    });

    test("a clean document is never autosaved", async () => {
        start();

        await rs.advanceTimersByTimeAsync(60 * MINUTE);

        expect(repository.saves).toHaveLength(0);
    });

    test("once saved, the next autosave counts from the next edit", async () => {
        start();
        edit("first");
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(kinds()).toEqual(["auto"]);

        await rs.advanceTimersByTimeAsync(10 * MINUTE);
        expect(kinds()).toEqual(["auto"]);

        edit("second");
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(kinds()).toEqual(["auto", "auto"]);
    });

    test("a document dirty when the service starts is autosaved too", async () => {
        edit("before start");
        start();

        await rs.advanceTimersByTimeAsync(5 * MINUTE);

        expect(kinds()).toEqual(["auto"]);
    });

    test("never during a command: deferred, then saved as soon as the command ends", async () => {
        start();
        edit("changed");
        app.executingCommand = { execute: async () => {} };

        await rs.advanceTimersByTimeAsync(20 * MINUTE);
        expect(repository.saves).toHaveLength(0);

        app.executingCommand = undefined;
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto"]);
    });

    test("never during a hold (a sketch session): saved once it is released", async () => {
        start();
        edit("changed");
        const release = AutosaveHolds.hold("sketch");

        await rs.advanceTimersByTimeAsync(6 * MINUTE);
        expect(repository.saves).toHaveLength(0);

        release();
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto"]);
    });

    test("never while a dialog is open or the pointer is pressed (a drag)", async () => {
        start();
        edit("changed");
        dialogOpen = true;
        await rs.advanceTimersByTimeAsync(6 * MINUTE);
        expect(repository.saves).toHaveLength(0);

        dialogOpen = false;
        globalThis.dispatchEvent(new Event("pointerdown"));
        await rs.advanceTimersByTimeAsync(5000);
        expect(repository.saves).toHaveLength(0);

        globalThis.dispatchEvent(new Event("pointerup"));
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto"]);
    });

    test("a shorter interval applies to the pending timer; Off stops autosaving", async () => {
        start();
        edit("changed");
        await rs.advanceTimersByTimeAsync(2 * MINUTE);

        settings.intervalMinutes = 1;
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto"]);

        settings.intervalMinutes = 0;
        edit("again");
        await rs.advanceTimersByTimeAsync(60 * MINUTE);
        expect(kinds()).toEqual(["auto"]);

        settings.intervalMinutes = 10;
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto", "auto"]);
    });

    test("a manual save restarts the timer, and is a `manual` version", async () => {
        start();
        edit("first");
        await rs.advanceTimersByTimeAsync(4 * MINUTE);

        await document.save("manual");
        edit("second");
        await rs.advanceTimersByTimeAsync(4 * MINUTE);
        expect(kinds()).toEqual(["manual"]);

        await rs.advanceTimersByTimeAsync(MINUTE);
        expect(kinds()).toEqual(["manual", "auto"]);
    });

    test("a manual save of a clean document still saves (it promotes the autosave to a kept version)", async () => {
        start();
        edit("changed");
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(document.isDirty).toBe(false);
        expect(status.lastAutosavedAt(document)).toBeGreaterThan(0);

        const saved = await document.save("manual");

        expect(saved.isOk && saved.value.status).toBe("saved");
        expect(kinds()).toEqual(["auto", "manual"]);
        expect(repository.saves[1].data).toEqual(repository.saves[0].data);
    });

    test("another save after an autosave clears 'Autosaved' from the status", async () => {
        start();
        edit("first");
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(status.lastAutosavedAt(document)).toBe(Date.parse("2026-09-27T12:05:00Z"));

        edit("second");
        await document.save("manual");

        expect(status.lastAutosavedAt(document)).toBeUndefined();
    });

    test("saving 'yes' in the close prompt while an autosave is due never saves the closed document", async () => {
        // The repository answers only when released, so the prompt's save is still running when
        // the deferred autosave wakes up.
        const slow = slowRepository();
        document.repository = slow;
        const prompts: DialogButton[][] = [];
        const original = PubSub.default.pub.bind(PubSub.default);
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(((
            event: string,
            ...args: unknown[]
        ) => {
            if (event === "showDialog") prompts.push(args[2] as DialogButton[]);
            else (original as (e: string, ...a: unknown[]) => void)(event, ...args);
        }) as typeof PubSub.default.pub);
        try {
            start();
            edit("changed");
            const closing = document.close();
            dialogOpen = true;
            await rs.advanceTimersByTimeAsync(5 * MINUTE);
            expect(prompts).toHaveLength(1);

            dialogOpen = false;
            prompts[0].find((x) => x.content === "common.save")!.onclick?.();
            await rs.advanceTimersByTimeAsync(2000);
            slow.release();
            expect(await closing).toBe(true);
            await rs.advanceTimersByTimeAsync(10 * MINUTE);
            slow.release();
            await rs.advanceTimersByTimeAsync(0);

            expect(slow.requested.map((x) => x.kind)).toEqual(["manual"]);
            expect(slow.documents.get("doc-1")?.data["name"]).toBe("changed");
            expect(slow.documents.get("doc-1")?.data["models"]).toEqual(slow.saves[0].data["models"]);
        } finally {
            pub.mockRestore();
        }
    });

    test("a pointer released outside the window (blur, tab hidden) no longer counts as a drag", async () => {
        start();
        edit("changed");
        globalThis.dispatchEvent(new Event("pointerdown"));
        await rs.advanceTimersByTimeAsync(6 * MINUTE);
        expect(repository.saves).toHaveLength(0);

        globalThis.dispatchEvent(new Event("blur"));
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto"]);

        edit("again");
        globalThis.dispatchEvent(new Event("pointerdown"));
        await rs.advanceTimersByTimeAsync(6 * MINUTE);
        const visibility = rs.spyOn(globalThis.document, "visibilityState", "get").mockReturnValue("hidden");
        try {
            globalThis.document.dispatchEvent(new Event("visibilitychange"));
        } finally {
            visibility.mockRestore();
        }
        await rs.advanceTimersByTimeAsync(0);
        expect(kinds()).toEqual(["auto", "auto"]);
    });

    test("one autosave at a time: a deferred one and a re-armed timer never both start a save", async () => {
        const slow = slowRepository();
        document.repository = slow;
        start();
        edit("changed");
        dialogOpen = true;
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(slow.requested).toHaveLength(0);

        // Deferred (waiting); the interval change re-arms the timer, which fires first.
        dialogOpen = false;
        settings.intervalMinutes = 1;
        await rs.advanceTimersByTimeAsync(0);
        expect(slow.requested).toHaveLength(1);

        // The idle poll then finds the deferred one: it must not start a second save.
        await rs.advanceTimersByTimeAsync(2000);
        expect(slow.requested).toHaveLength(1);
        slow.release();
        await rs.advanceTimersByTimeAsync(0);
        expect(slow.saves.map((x) => x.kind)).toEqual(["auto"]);
        // Nothing was queued behind it either.
        expect(slow.requested).toHaveLength(1);
    });

    test("a local document overwrites its copy in this browser", async () => {
        const local = new MemoryDocumentRepository("local");
        document.repository = local;
        start();
        edit("changed");

        await rs.advanceTimersByTimeAsync(5 * MINUTE);

        expect(local.saves.map((x) => x.kind)).toEqual(["auto"]);
        expect(local.documents.get("doc-1")?.data["id"]).toBe("doc-1");
    });

    test("a read-only document (edited in another tab) is skipped", async () => {
        const readOnly = Object.assign(new MemoryDocumentRepository("cloud"), { isReadOnly: () => true });
        document.repository = readOnly;
        start();
        edit("changed");

        await rs.advanceTimersByTimeAsync(30 * MINUTE);

        expect(readOnly.saves).toHaveLength(0);
    });

    test("an opened .spicy file is written back only with its opt-in on", async () => {
        const writeFile = rs.fn(async (_document: IDocument): Promise<Result<void>> => {
            document.markSaved();
            return Result.ok(undefined);
        });
        start({ files: files("off"), writeFile });
        edit("changed");
        await rs.advanceTimersByTimeAsync(30 * MINUTE);
        expect(writeFile).not.toHaveBeenCalled();
        expect(repository.saves).toHaveLength(0);
        service.stop();

        start({ files: files("on"), writeFile });
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(repository.saves).toHaveLength(0);
        expect(document.isDirty).toBe(false);
    });

    test("a conflict opens no dialog and is not retried until the version changes", async () => {
        const conflicting = new (class extends MemoryDocumentRepository {
            answer: SaveOutcome = { status: "conflict", headVersion: "v-other" };
            override async save(request: SaveRequest) {
                this.saves.push(request);
                return Result.ok(this.answer);
            }
        })("cloud");
        document.repository = conflicting;
        document.version = "v-1";
        const handler = rs.fn(async () => {});
        app.repositories.conflictHandler = handler;
        start();
        edit("changed");

        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(conflicting.saves.map((x) => x.kind)).toEqual(["auto"]);
        expect(status.lastAutosavedAt(document)).toBeUndefined();

        await rs.advanceTimersByTimeAsync(30 * MINUTE);
        expect(conflicting.saves).toHaveLength(1);
        expect(handler).not.toHaveBeenCalled();

        // Resolved ("save mine as the latest version"): based on the head now.
        document.version = "v-other";
        conflicting.answer = { status: "saved", updatedAt: 1, version: "v-3" };
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(conflicting.saves).toHaveLength(2);
        expect(document.isDirty).toBe(false);
    });

    test("offline: stays dirty and tries again at the next interval", async () => {
        start();
        edit("changed");
        repository.failWith = { kind: "offline" };

        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(document.isDirty).toBe(true);

        repository.failWith = undefined;
        await rs.advanceTimersByTimeAsync(5 * MINUTE);
        expect(kinds()).toEqual(["auto"]);
        expect(document.isDirty).toBe(false);
    });

    test("a closed document is forgotten", async () => {
        start();
        edit("changed");
        await document.close({ discardChanges: true });

        await rs.advanceTimersByTimeAsync(30 * MINUTE);

        expect(repository.saves).toHaveLength(0);
    });
});
