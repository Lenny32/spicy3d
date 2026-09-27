// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DOCUMENT_FILE_EXTENSION,
    DOCUMENT_FILE_MIME_TYPE,
    decodeDocumentFile,
    download,
    encodeDocumentFile,
    I18n,
    type IApplication,
    type IDocument,
    LEGACY_DOCUMENT_FILE_EXTENSIONS,
    Logger,
    PubSub,
    Result,
    readFilesAsync,
} from "@spicy3d/core";

// The File System Access API is Chromium-only and not in lib.dom yet.
interface FilePickerType {
    description: string;
    accept: Record<string, string[]>;
}
interface FilePickerWindow {
    showOpenFilePicker?: (options: {
        types: FilePickerType[];
        multiple: boolean;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options: {
        types: FilePickerType[];
        suggestedName: string;
    }) => Promise<FileSystemFileHandle>;
}

/** A document file picked or dropped, with its handle when the browser can write it back. */
export interface DocumentFileEntry {
    file: File;
    handle?: FileSystemFileHandle;
}

/** How `saveDocumentFile` stored the document. */
export type DocumentFileSaveOutcome = "written" | "downloaded";

/** The file each document was opened from or last saved to (File System Access API only). */
const fileHandles = new WeakMap<IDocument, FileSystemFileHandle>();

const pickerWindow = () => window as unknown as FilePickerWindow;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

function pickerTypes(): FilePickerType[] {
    return [
        {
            description: I18n.translate("document.file.description"),
            accept: {
                [DOCUMENT_FILE_MIME_TYPE]: [DOCUMENT_FILE_EXTENSION, ...LEGACY_DOCUMENT_FILE_EXTENSIONS],
            },
        },
    ];
}

/** Lets the user pick a document file; resolves `err("cancel")` when the picker is dismissed. */
export async function pickDocumentFile(): Promise<Result<DocumentFileEntry[]>> {
    const showOpenFilePicker = pickerWindow().showOpenFilePicker;
    if (showOpenFilePicker) {
        try {
            const handles = await showOpenFilePicker.call(window, { types: pickerTypes(), multiple: false });
            return Result.ok(
                await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle }))),
            );
        } catch (error) {
            if (isAbort(error)) return Result.err("cancel");
            Logger.warn("document file: open picker failed, falling back to a file input", error);
        }
    }
    const accept = [DOCUMENT_FILE_EXTENSION, ...LEGACY_DOCUMENT_FILE_EXTENSIONS].join(",");
    const files = await readFilesAsync(accept, false);
    return files.isOk ? Result.ok(Array.from(files.value, (file) => ({ file }))) : files.parse();
}

/**
 * Opens a `.spicy` (or legacy plain-JSON) file. The document saves to the local repository;
 * with a `handle`, "save to file" writes back to the same file.
 */
export async function openDocumentFile(
    app: IApplication,
    { file, handle }: DocumentFileEntry,
): Promise<IDocument | undefined> {
    const decoded = await decodeDocumentFile(file);
    if (!decoded.isOk) {
        Logger.warn(`document file: cannot read ${file.name} (${decoded.error.message})`);
        PubSub.default.pub("showToast", "error.document.notSpicy3D");
        return undefined;
    }
    const document = await app.loadDocument(decoded.value);
    if (document && handle) fileHandles.set(document, handle);
    return document;
}

/**
 * Saves the document as a `.spicy` file: back to the file it came from where the browser
 * supports it, to a newly picked file otherwise, and as a download without the API.
 * Resolves `err("cancel")` when the user dismisses the save picker.
 */
export async function saveDocumentFile(document: IDocument): Promise<Result<DocumentFileSaveOutcome>> {
    const fileName = `${document.name}${DOCUMENT_FILE_EXTENSION}`;
    let handle = fileHandles.get(document);
    const showSaveFilePicker = pickerWindow().showSaveFilePicker;
    if (!handle && showSaveFilePicker) {
        try {
            // Before encoding: the picker needs the user activation of the click.
            handle = await showSaveFilePicker.call(window, { types: pickerTypes(), suggestedName: fileName });
        } catch (error) {
            if (isAbort(error)) return Result.err("cancel");
            Logger.warn("document file: save picker failed, downloading instead", error);
        }
    }

    const blob = await encodeDocumentFile(document.serialize());
    if (!handle) {
        download([blob], fileName);
        return Result.ok("downloaded");
    }
    try {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        fileHandles.set(document, handle);
        return Result.ok("written");
    } catch (error) {
        Logger.warn(`document file: cannot write ${handle.name}`, error);
        return Result.err((error as Error).message);
    }
}
