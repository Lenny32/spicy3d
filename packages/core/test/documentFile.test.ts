// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import {
    DOCUMENT_FILE_EXTENSION,
    DOCUMENT_FILE_MIME_TYPE,
    DOCUMENT_FORMAT_VERSION,
    decodeDocumentFile,
    encodeDocumentFile,
    isDocumentFileName,
    type Serialized,
} from "../src";
import { loadDocumentFixtures } from "../test-utils";

describe("document files", () => {
    const sample = {
        __cla$$__: "Document",
        formatVersion: DOCUMENT_FORMAT_VERSION,
        moduleVersions: { parametric: 1 },
        id: "doc-1",
        name: "Bracket — 1",
        userData: { nested: [1, 2, { x: "ü" }] },
    } as unknown as Serialized;

    test("the extension is .spicy", () => {
        expect(DOCUMENT_FILE_EXTENSION).toBe(".spicy");
    });

    test("a .spicy file is gzipped JSON", async () => {
        const blob = await encodeDocumentFile(sample);
        const bytes = new Uint8Array(await blob.arrayBuffer());

        expect(blob.type).toBe(DOCUMENT_FILE_MIME_TYPE);
        expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
        const json = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
        expect(JSON.parse(json)).toEqual(sample);
    });

    test("encode → decode round-trips the data, format version included", async () => {
        const decoded = await decodeDocumentFile(await encodeDocumentFile(sample));

        expect(decoded.isOk).toBe(true);
        expect(decoded.value).toEqual(sample);
        expect(decoded.value["formatVersion"]).toBe(DOCUMENT_FORMAT_VERSION);
    });

    test.each(
        loadDocumentFixtures().map((x) => [x.name, x.data] as const),
    )("fixture %s round-trips", async (_name, data) => {
        const decoded = await decodeDocumentFile(await encodeDocumentFile(data));
        expect(decoded.value).toEqual(data);
    });

    test("a legacy plain-JSON file decodes too", async () => {
        const decoded = await decodeDocumentFile(new Blob([JSON.stringify(sample)]));
        expect(decoded.value).toEqual(sample);
    });

    test.each([
        ["not JSON", new Blob(["hello"])],
        ["a JSON array", new Blob(["[1,2]"])],
        ["JSON null", new Blob(["null"])],
        ["corrupt gzip", new Blob([new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02])])],
    ])("%s is unreadable", async (_name, blob) => {
        const decoded = await decodeDocumentFile(blob);

        expect(decoded.isOk).toBe(false);
        expect(decoded.error.kind).toBe("unreadable");
    });

    test.each([
        ["part.spicy", true],
        ["PART.SPICY", true],
        ["old.cd", true],
        ["model.step", false],
        ["plugin.spicyplugin", false],
    ])("isDocumentFileName(%s) is %s", (name, expected) => {
        expect(isDocumentFileName(name)).toBe(expected);
    });
});
