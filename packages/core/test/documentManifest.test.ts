// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import {
    assembleManifest,
    BLOB_REF_KEY,
    CLOUD_VERSION_FILE_TYPE,
    decodeCloudVersionEnvelope,
    decodeDocumentFile,
    isCloudVersionEnvelope,
    manifestBlobRefs,
    type Serialized,
    sha256Hex,
    splitManifest,
} from "../src";

const encoder = new TextEncoder();
const brep = `DBRep_DrawableShape\nCASCADE Topology V3\n${"1 0 0 0 1 0 0 0 1 0 0 0\n".repeat(400)}`;
const positions = Array.from({ length: 3000 }, (_, i) => (i % 7) * 0.5);
const indices = Array.from({ length: 1500 }, (_, i) => i);

function sampleDocument(): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        id: "doc-1",
        name: "Bracket",
        models: {
            children: [
                { __cla$$__: "EditableShapeNode", shape: { __cla$$__: "OccShape", shape: brep, id: "s1" } },
                // The same geometry twice (a copy): one blob.
                { __cla$$__: "EditableShapeNode", shape: { __cla$$__: "OccShape", shape: brep, id: "s2" } },
                {
                    __cla$$__: "MeshNode",
                    mesh: {
                        position: { __cla$$__: "Float32Array", buffer: positions },
                        index: { __cla$$__: "Uint32Array", buffer: indices },
                        small: { __cla$$__: "Float32Array", buffer: [1, 2, 3] },
                    },
                },
            ],
        },
        userData: { note: "short", samples: Array.from({ length: 1200 }, (_, i) => i / 3) },
    } as unknown as Serialized;
}

async function split(data = sampleDocument()) {
    return splitManifest(data);
}

describe("splitManifest", () => {
    test("moves BREP strings and mesh buffers to blobs and keeps small values inline", async () => {
        const { manifest, blobs } = await split();
        const children = (manifest["models"] as any).children;

        const shapeRef = children[0].shape.shape;
        expect(Object.keys(shapeRef)).toEqual([BLOB_REF_KEY]);
        expect(children[1].shape.shape).toEqual(shapeRef);
        expect(children[2].mesh.position.buffer).toEqual({
            [BLOB_REF_KEY]: expect.any(String),
            $as: "float32",
        });
        expect(children[2].mesh.index.buffer).toEqual({ [BLOB_REF_KEY]: expect.any(String), $as: "uint32" });
        expect(children[2].mesh.small.buffer).toEqual([1, 2, 3]);
        expect((manifest["userData"] as any).samples).toEqual({
            [BLOB_REF_KEY]: expect.any(String),
            $as: "json",
        });
        expect((manifest["userData"] as any).note).toBe("short");
        expect(manifest["name"]).toBe("Bracket");
        // brep (shared), positions, indices, samples.
        expect(blobs.size).toBe(4);
    });

    test("names each blob by the SHA-256 of its uncompressed bytes", async () => {
        const { manifest, blobs } = await split();
        const sha = (manifest["models"] as any).children[0].shape.shape[BLOB_REF_KEY];

        expect(sha).toBe(await sha256Hex(encoder.encode(brep)));
        expect(sha).toMatch(/^[0-9a-f]{64}$/);
        expect(blobs.get(sha)).toEqual(encoder.encode(brep));
        for (const [hash, bytes] of blobs) expect(await sha256Hex(bytes)).toBe(hash);
    });

    test("is deterministic and leaves the input untouched", async () => {
        const data = sampleDocument();
        const before = JSON.stringify(data);
        const a = await splitManifest(data);
        const b = await splitManifest(data);

        expect(JSON.stringify(data)).toBe(before);
        expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
        expect([...a.blobs.keys()]).toEqual([...b.blobs.keys()]);
    });

    test("an unchanged shape keeps its blob when something else changes", async () => {
        const first = await split();
        const edited = sampleDocument();
        edited["name"] = "Bracket v2";
        const second = await splitManifest(edited);

        expect([...second.blobs.keys()]).toEqual([...first.blobs.keys()]);
        expect(JSON.stringify(second.manifest)).not.toBe(JSON.stringify(first.manifest));
    });

    test("thresholds are configurable", async () => {
        const { manifest, blobs } = await splitManifest(sampleDocument(), {
            minStringLength: 1,
            minArrayLength: 1_000_000,
        });

        expect(isRefObject((manifest["userData"] as any).note)).toBe(true);
        expect(Array.isArray((manifest["userData"] as any).samples)).toBe(true);
        expect(blobs.size).toBeGreaterThan(1);
    });
});

function isRefObject(value: unknown) {
    return typeof value === "object" && value !== null && BLOB_REF_KEY in value;
}

describe("assembleManifest", () => {
    test("puts every blob back: split → assemble round-trips the document", async () => {
        const original = sampleDocument();
        const { manifest, blobs } = await splitManifest(original);
        const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));

        expect(assembled.isOk).toBe(true);
        expect(assembled.value).toEqual(original);
    });

    test("keeps an object of the document that has a $blob key of its own", async () => {
        const original = {
            ...sampleDocument(),
            userData: { odd: { $blob: "not a reference" }, other: { $literal: { a: 1 } } },
        } as Serialized;
        const { manifest, blobs } = await splitManifest(original);

        expect(manifestBlobRefs(manifest)).not.toContain("not a reference");
        expect(assembleManifest(manifest, (sha) => blobs.get(sha)).value).toEqual(original);
    });

    test("reports the first missing blob", async () => {
        const { manifest } = await split();
        const assembled = assembleManifest(manifest, () => undefined);

        expect(assembled.isOk).toBe(false);
        expect(assembled.error).toEqual({ kind: "missingBlob", sha256: manifestBlobRefs(manifest)[0] });
    });

    test("rejects a manifest that is not an object, or a json blob that is not numbers", async () => {
        expect(assembleManifest([1, 2], () => undefined).error?.kind).toBe("invalidManifest");
        const bad = assembleManifest({ x: { $blob: "a", $as: "json" } }, () => encoder.encode('"text"'));
        expect(bad.error?.kind).toBe("invalidManifest");
    });

    test("manifestBlobRefs lists each referenced blob once", async () => {
        const { manifest, blobs } = await split();

        expect(manifestBlobRefs(manifest).sort()).toEqual([...blobs.keys()].sort());
    });
});

function base64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

async function envelopeOf(data: Serialized, serverName = "Renamed on the server") {
    const { manifest, blobs } = await splitManifest(data);
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const manifestSha = await sha256Hex(manifestBytes);
    const encoded: Record<string, string> = { [manifestSha]: base64(manifestBytes) };
    for (const [sha, bytes] of blobs) {
        let text = "";
        for (let i = 0; i < bytes.length; i += 4096) {
            text += String.fromCharCode(...bytes.subarray(i, i + 4096));
        }
        encoded[sha] = btoa(text);
    }
    return {
        type: CLOUD_VERSION_FILE_TYPE,
        exportFormat: 1,
        document: { id: data["id"], name: serverName },
        version: { id: "0190a0c2-0000-7000-8000-000000000001", kind: "manual" },
        manifestSha256: manifestSha,
        thumbnailSha256: null,
        blobs: encoded,
    };
}

describe("server export envelope", () => {
    test("is recognized by its type", async () => {
        expect(isCloudVersionEnvelope(await envelopeOf(sampleDocument()))).toBe(true);
        expect(isCloudVersionEnvelope(sampleDocument())).toBe(false);
    });

    test("reassembles the document, with the server's name", async () => {
        const decoded = decodeCloudVersionEnvelope(await envelopeOf(sampleDocument()));

        expect(decoded.isOk).toBe(true);
        expect(decoded.value).toEqual({ ...sampleDocument(), name: "Renamed on the server" });
    });

    test("an unknown export format or a missing manifest is an error", async () => {
        const envelope = await envelopeOf(sampleDocument());

        expect(decodeCloudVersionEnvelope({ ...envelope, exportFormat: 2 }).isOk).toBe(false);
        expect(decodeCloudVersionEnvelope({ ...envelope, blobs: {} }).error?.kind).toBe("missingBlob");
    });

    test("a gzipped export .spicy file opens as its document", async () => {
        const json = new Blob([JSON.stringify(await envelopeOf(sampleDocument()))]);
        const gzipped = await new Response(json.stream().pipeThrough(new CompressionStream("gzip"))).blob();

        const decoded = await decodeDocumentFile(gzipped);

        expect(decoded.isOk).toBe(true);
        expect(decoded.value["name"]).toBe("Renamed on the server");
        expect((decoded.value["models"] as any).children[0].shape.shape).toBe(brep);
    });
});
