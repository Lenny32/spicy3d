// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    AutosaveStatus,
    DOCUMENT_FILE_EXTENSION,
    type DocumentSource,
    encodeDocumentFile,
    type FileAutosaveState,
    type IApplication,
    type IDocument,
    Material,
    PubSub,
    type Serialized,
    Transaction,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { Document } from "../src/document";
import { autosaveToOriginFile, fileAutosave, openDocumentFile, saveDocumentFile } from "../src/documentFiles";

interface FakeHandle {
    handle: FileSystemFileHandle;
    written: Blob[];
}

function fakeHandle(name: string, failWrite = false): FakeHandle {
    const written: Blob[] = [];
    const handle = {
        kind: "file",
        name,
        createWritable: async () => ({
            write: async (blob: Blob) => {
                if (failWrite) throw new Error("permission denied");
                written.push(blob);
            },
            close: async () => {},
        }),
    } as unknown as FileSystemFileHandle;
    return { handle, written };
}

describe("document files", () => {
    let app: IApplication;
    let documents: IDocument[];
    let downloads: Blob[];
    let createObjectURL: ReturnType<typeof rs.spyOn>;

    const trackedLoad = async (data: Serialized, source?: DocumentSource) => {
        const document = await Document.load(app, data, source);
        if (document) documents.push(document);
        return document;
    };

    function makeDocument() {
        const document = new Document(app, "Bracket");
        documents.push(document);
        document.variables.setItems([{ id: "v1", name: "w", expression: "50", type: "length" }]);
        document.settings.lengthUnit = "in";
        document.modelManager.materials.push(new Material({ document, name: "Steel", color: 0x898989 }));
        return document;
    }

    beforeEach(() => {
        app = createMockApplication();
        app.loadDocument = trackedLoad;
        documents = [];
        downloads = [];
        createObjectURL = rs.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
            downloads.push(blob as Blob);
            return "blob:fake";
        });
    });

    afterEach(() => {
        createObjectURL.mockRestore();
        delete (window as any).showSaveFilePicker;
        for (const document of documents) document.dispose();
    });

    test("download → reopen round-trips the model", async () => {
        const original = makeDocument();

        const saved = await saveDocumentFile(original);
        expect(saved.unchecked()).toBe("downloaded");
        expect(downloads).toHaveLength(1);

        const file = new File([downloads[0]], `Bracket${DOCUMENT_FILE_EXTENSION}`);
        const reopened = await openDocumentFile(app, { file });

        expect(reopened).not.toBeUndefined();
        expect(reopened!.serialize()).toEqual(original.serialize());
        expect(reopened!.settings.lengthUnit).toBe("in");
        expect(reopened!.modelManager.materials.map((x) => x.name)).toEqual(["Steel"]);
        expect(reopened!.isDirty).toBe(false);
        expect(reopened!.repository).toBe(app.repositories.local);
    });

    test("an unreadable file shows the not-a-document toast", async () => {
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            const reopened = await openDocumentFile(app, { file: new File(["garbage"], "x.spicy") });

            expect(reopened).toBeUndefined();
            expect(pub).toHaveBeenCalledWith("showToast", "error.document.notSpicy3D");
        } finally {
            pub.mockRestore();
        }
    });

    test("with the File System Access API, the first save picks a file and later saves write back to it", async () => {
        const target = fakeHandle("Bracket.spicy");
        const picker = rs.fn(async (_options: { suggestedName: string }) => target.handle);
        (window as any).showSaveFilePicker = picker;
        const document = makeDocument();

        expect((await saveDocumentFile(document)).unchecked()).toBe("written");
        expect((await saveDocumentFile(document)).unchecked()).toBe("written");

        expect(picker).toHaveBeenCalledTimes(1);
        expect(picker.mock.calls[0][0].suggestedName).toBe("Bracket.spicy");
        expect(target.written).toHaveLength(2);
        expect(downloads).toHaveLength(0);
        const reopened = await openDocumentFile(app, {
            file: new File([target.written[1]], "Bracket.spicy"),
        });
        expect(reopened!.serialize()).toEqual(document.serialize());
    });

    test("a document opened with a file handle saves back to that file without asking", async () => {
        const source = fakeHandle("opened.spicy");
        const picker = rs.fn(async () => fakeHandle("other.spicy").handle);
        (window as any).showSaveFilePicker = picker;
        const file = new File([await encodeDocumentFile(makeDocument().serialize())], "opened.spicy");
        const opened = await openDocumentFile(app, { file, handle: source.handle });

        const saved = await saveDocumentFile(opened!);

        expect(saved.unchecked()).toBe("written");
        expect(picker).not.toHaveBeenCalled();
        expect(source.written).toHaveLength(1);
    });

    test("a legacy .cd file is never written back: saving picks a new .spicy file", async () => {
        const legacy = fakeHandle("old.cd");
        const target = fakeHandle("old.spicy");
        const picker = rs.fn(async (_options: { suggestedName: string }) => target.handle);
        (window as any).showSaveFilePicker = picker;
        const file = new File([JSON.stringify(makeDocument().serialize())], "old.cd");
        const opened = await openDocumentFile(app, { file, handle: legacy.handle });

        await saveDocumentFile(opened!);

        expect(legacy.written).toHaveLength(0);
        expect(picker).toHaveBeenCalledTimes(1);
        expect(picker.mock.calls[0][0].suggestedName).toBe(`${opened!.name}${DOCUMENT_FILE_EXTENSION}`);
        expect(target.written).toHaveLength(1);
    });

    test("writing back to the file it was opened from saves the document; a new file is only a copy", async () => {
        const source = fakeHandle("opened.spicy");
        const file = new File([await encodeDocumentFile(makeDocument().serialize())], "opened.spicy");
        const opened = await openDocumentFile(app, { file, handle: source.handle });
        const edit = () =>
            Transaction.execute(opened!, "rename", () => {
                opened!.modelManager.rootNode.name = `edited ${Math.random()}`;
            });
        edit();
        expect(opened!.isDirty).toBe(true);

        await saveDocumentFile(opened!);
        expect(opened!.isDirty).toBe(false);

        const copy = makeDocument();
        Transaction.execute(copy, "rename", () => {
            copy.modelManager.rootNode.name = "edited";
        });
        (window as any).showSaveFilePicker = async () => fakeHandle("copy.spicy").handle;
        await saveDocumentFile(copy);
        expect(copy.isDirty).toBe(true);
    });

    test("dismissing the save picker cancels: nothing written or downloaded", async () => {
        (window as any).showSaveFilePicker = async () => {
            throw new DOMException("dismissed", "AbortError");
        };

        const saved = await saveDocumentFile(makeDocument());

        expect(saved.isOk).toBe(false);
        expect(saved.error).toBe("cancel");
        expect(downloads).toHaveLength(0);
    });

    test("a failed write is reported", async () => {
        (window as any).showSaveFilePicker = async () => fakeHandle("locked.spicy", true).handle;

        const saved = await saveDocumentFile(makeDocument());

        expect(saved.isOk).toBe(false);
        expect(saved.error).toBe("permission denied");
    });
    describe("autosave to the origin file", () => {
        /** A handle of the file at `path` (another handle object for the same path = the same file). */
        function permissionHandle(path: string, permission: PermissionState) {
            const fake = fakeHandle(path);
            const requests: string[] = [];
            Object.assign(fake.handle, {
                path,
                queryPermission: async () => "prompt",
                requestPermission: async ({ mode }: { mode: string }) => {
                    requests.push(mode);
                    return permission;
                },
                isSameEntry: async (other: FileSystemFileHandle) =>
                    (other as { path?: string }).path === path,
            });
            return { ...fake, requests };
        }

        async function openWith(handle: FileSystemFileHandle) {
            const file = new File([await encodeDocumentFile(makeDocument().serialize())], handle.name);
            const opened = await openDocumentFile(app, { file, handle });
            Transaction.execute(opened!, "rename", () => {
                opened!.modelManager.rootNode.name = `edited ${Math.random()}`;
            });
            return opened!;
        }

        test("off by default: autosave writes nothing to the file", async () => {
            const source = permissionHandle("opened.spicy", "granted");
            const opened = await openWith(source.handle);

            expect(fileAutosave.state(opened)).toBe("off");
            expect((await autosaveToOriginFile(opened)).isOk).toBe(false);
            expect(source.written).toHaveLength(0);
            expect(opened.isDirty).toBe(true);
        });

        test("turned on (with write access asked for), autosave writes back and the document is saved", async () => {
            const source = permissionHandle("opened.spicy", "granted");
            const opened = await openWith(source.handle);

            expect(await fileAutosave.set(opened, true)).toBe(true);
            expect(source.requests).toEqual(["readwrite"]);
            expect(fileAutosave.state(opened)).toBe("on");

            expect((await autosaveToOriginFile(opened)).isOk).toBe(true);
            expect(source.written).toHaveLength(1);
            expect(opened.isDirty).toBe(false);
            await fileAutosave.set(opened, false);
        });

        test("write access refused: stays off", async () => {
            const source = permissionHandle("opened.spicy", "denied");
            const opened = await openWith(source.handle);

            expect(await fileAutosave.set(opened, true)).toBe(false);
            expect(fileAutosave.state(opened)).toBe("off");
        });

        test("remembered for the session: the same file opened again keeps it on", async () => {
            const first = permissionHandle("opened.spicy", "granted");
            const opened = await openWith(first.handle);
            await fileAutosave.set(opened, true);

            const again = permissionHandle("opened.spicy", "granted");
            const reopened = await openWith(again.handle);
            expect(fileAutosave.state(reopened)).toBe("on");

            const other = permissionHandle("other.spicy", "granted");
            expect(fileAutosave.state(await openWith(other.handle))).toBe("off");
            await fileAutosave.set(opened, false);
        });

        test("the status is told once the file is known, so the opt-in shows for the file just opened", async () => {
            const seen: FileAutosaveState[] = [];
            const unsubscribe = AutosaveStatus.current.onChanged((document) => {
                seen.push(fileAutosave.state(document));
            });
            try {
                await openWith(permissionHandle("opened.spicy", "granted").handle);
            } finally {
                unsubscribe();
            }
            expect(seen).toEqual(["off"]);
        });

        test("a document not opened from a writable .spicy file has no such option", () => {
            expect(fileAutosave.state(makeDocument())).toBe("unavailable");
        });
    });
});
