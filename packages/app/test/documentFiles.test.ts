// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    DOCUMENT_FILE_EXTENSION,
    type DocumentSource,
    encodeDocumentFile,
    type IApplication,
    type IDocument,
    Material,
    PubSub,
    type Serialized,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { Document } from "../src/document";
import { openDocumentFile, saveDocumentFile } from "../src/documentFiles";

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
});
