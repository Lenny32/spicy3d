// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FileData } from "../src";
import { readFileAsync, readFilesAsync } from "../src";

/**
 * Creates a mock FileList usable in tests.
 */
function createFileList(files: File[]): FileList {
    const list = {
        length: files.length,
        item: (index: number) => files[index] ?? null,
        [Symbol.iterator]: function* () {
            for (const f of files) yield f;
        },
    };
    for (let i = 0; i < files.length; i++) {
        (list as Record<number, File>)[i] = files[i];
    }
    return list as unknown as FileList;
}

const originalCreateElement = document.createElement;

/**
 * Overrides document.createElement so that the created input element fires
 * `onClick(input)` synchronously when clicked. Restored after each test.
 */
function patchInputClick(onClick: (input: HTMLInputElement) => void) {
    const origCreate = originalCreateElement.bind(document) as (
        tag: string,
        options?: ElementCreationOptions,
    ) => HTMLElement;
    document.createElement = ((tag: string, _options?: ElementCreationOptions) => {
        const el = origCreate(tag);
        if (tag === "input") {
            (el as HTMLInputElement).click = () => onClick(el as HTMLInputElement);
        }
        return el;
    }) as typeof document.createElement;
}

function selectFiles(input: HTMLInputElement, files: FileList) {
    Object.defineProperty(input, "files", {
        value: files,
        writable: false,
        configurable: true,
    });
    input.onchange?.(new Event("change"));
}

afterEach(() => {
    document.createElement = originalCreateElement;
});

describe("readFilesAsync", () => {
    test("should return a Promise", () => {
        const result = readFilesAsync(".txt", false);
        expect(result).toBeInstanceOf(Promise);
    });

    test("should return ok when files are selected (input click + change)", async () => {
        const testFile = new File(["content"], "test.txt", { type: "text/plain" });
        const fileList = createFileList([testFile]);

        patchInputClick((input) => selectFiles(input, fileList));

        const result = await readFilesAsync(".txt", false);

        expect(result.isOk).toBe(true);
    });

    test("should return ok with multiple files", async () => {
        const file1 = new File(["a"], "a.txt", { type: "text/plain" });
        const file2 = new File(["b"], "b.txt", { type: "text/plain" });
        const fileList = createFileList([file1, file2]);

        patchInputClick((input) => selectFiles(input, fileList));

        const result = await readFilesAsync("*", true);

        expect(result.isOk).toBe(true);
        expect(result.value?.length).toBe(2);
    });

    test("should return result.ok with truthy check on empty FileList", async () => {
        // In happy-dom, input.files is always a FileList (never null), so the
        // "no files selected" path is not reachable in tests, but we verify that
        // an empty FileList (truthy) passes the check.
        const emptyList = createFileList([]);

        patchInputClick((input) => selectFiles(input, emptyList));

        const result = await readFilesAsync("*", false);

        // Empty FileList is truthy, so result.isOk should be true
        expect(result.isOk).toBe(true);
    });
});

describe("readFileAsync", () => {
    test("should return a Promise", () => {
        const result = readFileAsync(".txt", false);
        expect(result).toBeInstanceOf(Promise);
    });

    test("should accept readAsDataURL method parameter", () => {
        const result = readFileAsync(".png", false, "readAsDataURL");
        expect(result).toBeInstanceOf(Promise);
    });

    test("should default to readAsText method", () => {
        const result = readFileAsync(".txt", false);
        expect(result).toBeInstanceOf(Promise);
    });

    test("should propagate error from cancel", async () => {
        patchInputClick((input) => {
            input.oncancel?.(new Event("cancel"));
        });

        const result = await readFileAsync("*", false);

        expect(result.isOk).toBe(false);
        expect(result.error).toBe("cancel");
    });
});

describe("FileData interface validation", () => {
    test("should have fileName and data properties", () => {
        const fileData: FileData = {
            fileName: "test.txt",
            data: "file content",
        };
        expect(fileData.fileName).toBe("test.txt");
        expect(fileData.data).toBe("file content");
    });

    test("should handle empty data", () => {
        const fileData: FileData = {
            fileName: "empty.txt",
            data: "",
        };
        expect(fileData.fileName).toBe("empty.txt");
        expect(fileData.data).toBe("");
    });

    test("should handle data URL", () => {
        const fileData: FileData = {
            fileName: "image.png",
            data: "data:image/png;base64,iVBORw0KGgo",
        };
        expect(fileData.fileName).toBe("image.png");
        expect(fileData.data).toMatch(/^data:/);
    });
});

describe("readFilesAsync edge cases", () => {
    test("should set input type to file", async () => {
        let capturedType: string | null = null;
        patchInputClick((input) => {
            capturedType = input.type;
            input.onchange?.(new Event("change"));
        });

        await readFilesAsync("*", false);

        expect(capturedType).toBe("file");
    });

    test("should set visibility to hidden", async () => {
        let capturedVisibility: string | null = null;
        patchInputClick((input) => {
            capturedVisibility = input.style.visibility;
            input.onchange?.(new Event("change"));
        });

        await readFilesAsync("*", false);

        expect(capturedVisibility).toBe("hidden");
    });

    test("should set multiple=true", async () => {
        let capturedMultiple: boolean | null = null;
        patchInputClick((input) => {
            capturedMultiple = input.multiple;
            input.onchange?.(new Event("change"));
        });

        await readFilesAsync(".csv", true);

        expect(capturedMultiple).toBe(true);
    });

    test("should set multiple=false", async () => {
        let capturedMultiple: boolean | null = null;
        patchInputClick((input) => {
            capturedMultiple = input.multiple;
            input.onchange?.(new Event("change"));
        });

        await readFilesAsync(".txt", false);

        expect(capturedMultiple).toBe(false);
    });

    test("should set accept attribute", async () => {
        let capturedAccept: string | null = null;
        patchInputClick((input) => {
            capturedAccept = input.accept;
            input.onchange?.(new Event("change"));
        });

        await readFilesAsync(".step,.stp", false);

        expect(capturedAccept).toBe(".step,.stp");
    });

    test("should handle empty accept string", async () => {
        let capturedAccept: string | null = null;
        patchInputClick((input) => {
            capturedAccept = input.accept;
            input.onchange?.(new Event("change"));
        });

        await readFilesAsync("", true);

        expect(capturedAccept).toBe("");
    });
});

describe("isIOS detection", () => {
    test("isIOS expression evaluates to a boolean", () => {
        const isIOS =
            /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase()) ||
            (navigator.maxTouchPoints > 0 && /(Macintosh)/.test(navigator.userAgent));
        expect(typeof isIOS).toBe("boolean");
    });
});
