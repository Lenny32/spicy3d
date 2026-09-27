// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DOCUMENT_FILE_EXTENSION,
    DOCUMENT_FILE_MIME_TYPE,
    decodeDocumentFile,
    download,
    encodeDocumentFile,
    type FileAutosaveState,
    I18n,
    type IApplication,
    type IDocument,
    type IFileAutosave,
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

/** The permission part of the File System Access API (Chromium-only). */
interface PermissionHandle {
    queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
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
/** The `.spicy` file each document was opened from, when it was opened from a writable one. */
const originFiles = new WeakMap<IDocument, FileSystemFileHandle>();

/** Only a `.spicy` file is written back: a legacy `.cd` (plain JSON) must not get gzip bytes. */
const isSpicyHandle = (handle: FileSystemFileHandle) =>
    handle.name.toLowerCase().endsWith(DOCUMENT_FILE_EXTENSION);

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
 * with the `handle` of a `.spicy` file, "save to file" writes back to the same file (a legacy
 * `.cd` file is never overwritten: saving picks a new `.spicy` file).
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
    if (document && handle && isSpicyHandle(handle)) {
        fileHandles.set(document, handle);
        originFiles.set(document, handle);
        if (await isAutosavedFile(handle)) fileAutosaveOn.add(document);
    }
    return document;
}

/** Documents whose autosave writes back to their origin file (the user turned it on). */
const fileAutosaveOn = new WeakSet<IDocument>();
/** The files autosave was turned on for in this tab, so reopening one keeps the choice. */
const autosavedFiles: FileSystemFileHandle[] = [];

async function isAutosavedFile(handle: FileSystemFileHandle): Promise<boolean> {
    for (const known of autosavedFiles) {
        try {
            if (known === handle || (await known.isSameEntry(handle))) return true;
        } catch {
            // A file that went away: not the same one.
        }
    }
    return false;
}

async function forgetAutosavedFile(handle: FileSystemFileHandle) {
    for (let i = autosavedFiles.length - 1; i >= 0; i--) {
        const known = autosavedFiles[i];
        const same = known === handle || (await known.isSameEntry(handle).catch(() => false));
        if (same) autosavedFiles.splice(i, 1);
    }
}

/**
 * Write access to `handle` for writes without a click (autosave). Asked for while the user turns
 * the option on (the prompt needs that click); without the permission API, assumed granted.
 */
async function requestWriteAccess(handle: FileSystemFileHandle): Promise<boolean> {
    const permissions = handle as unknown as PermissionHandle;
    try {
        if ((await permissions.queryPermission?.({ mode: "readwrite" })) === "granted") return true;
        if (!permissions.requestPermission) return true;
        return (await permissions.requestPermission({ mode: "readwrite" })) === "granted";
    } catch (error) {
        Logger.warn(`document file: no write access to ${handle.name}`, error);
        return false;
    }
}

/**
 * The per-file opt-in of autosave: off for every opened file until the user turns it on, then
 * remembered for that file for the rest of the session (this tab).
 */
export const fileAutosave: IFileAutosave = {
    state(document: IDocument): FileAutosaveState {
        if (!originFiles.has(document)) return "unavailable";
        return fileAutosaveOn.has(document) ? "on" : "off";
    },
    async set(document: IDocument, enabled: boolean): Promise<boolean> {
        const handle = originFiles.get(document);
        if (!handle) return false;
        if (!enabled) {
            fileAutosaveOn.delete(document);
            await forgetAutosavedFile(handle);
            return false;
        }
        if (!(await requestWriteAccess(handle))) return false;
        fileAutosaveOn.add(document);
        if (!(await isAutosavedFile(handle))) autosavedFiles.push(handle);
        return true;
    },
};

/**
 * Autosave of a document opened from a `.spicy` file with the opt-in on: writes it back to that
 * file (which counts as a save). `err("unavailable")` when it has no such file or the opt-in is off.
 */
export async function autosaveToOriginFile(document: IDocument): Promise<Result<void>> {
    const handle = originFiles.get(document);
    if (!handle || !fileAutosaveOn.has(document)) return Result.err("unavailable");
    const position = document.history.position();
    try {
        const blob = await encodeDocumentFile(document.serialize());
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        document.markSaved(position);
        PubSub.default.pub("documentSaved", document, "auto");
        return Result.ok(undefined);
    } catch (error) {
        Logger.warn(`document file: cannot autosave to ${handle.name}`, error);
        return Result.err((error as Error).message);
    }
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

    // Taken with the content: edits made while writing stay unsaved.
    const origin = originFiles.get(document);
    const position = origin ? document.history.position() : undefined;
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
        // Written back to the file the document was opened from: that file is where it lives, so
        // it is saved (no "unsaved changes" on close). A download or a newly picked file is a
        // copy and leaves the state alone; the local repository's copy may then be older, but
        // saving there still works as before.
        if (origin && origin === handle) {
            document.markSaved(position);
            PubSub.default.pub("documentSaved", document, "manual");
        }
        return Result.ok("written");
    } catch (error) {
        Logger.warn(`document file: cannot write ${handle.name}`, error);
        return Result.err((error as Error).message);
    }
}
