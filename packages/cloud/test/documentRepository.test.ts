// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { parseUtc, type SaveRequest, type Serialized, sha256Hex } from "@spicy3d/core";
import type { Account } from "../src/account/account";
import { MemoryBlobCache } from "../src/documents/blobCache";
import { CloudDocumentRepository } from "../src/documents/repository";
import { CONFIG, FakeDocumentServer } from "./_helpers/fakeDocumentServer";
import { FakeServer, json, problem, signedInAccount, TestRequest } from "./_helpers/fakeServer";

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

const BREP = `CASCADE Topology V3\n${"0.5 0 0 1\n".repeat(2000)}`;
/** A tiny valid PNG header: 64×40. */
const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0,
    40, 8, 6, 0, 0, 0,
]);

function documentData(name = "Bracket", brep = BREP): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: {},
        id: "doc-1",
        name,
        models: { shape: { __cla$$__: "OccShape", shape: brep, id: "s1" } },
        userData: {},
    } as unknown as Serialized;
}

function request(overrides: Partial<SaveRequest> = {}): SaveRequest {
    return { id: "doc-1", name: "Bracket", data: documentData(), kind: "manual", ...overrides };
}

interface Setup {
    server: FakeServer;
    cloud: FakeDocumentServer;
    account: Account;
    cache: MemoryBlobCache;
    repository: CloudDocumentRepository;
}

async function setup(): Promise<Setup> {
    const server = new FakeServer();
    const account = await signedInAccount(server);
    account.deviceSettings.deviceName = "Desk – Firefox";
    const cloud = new FakeDocumentServer(server);
    const cache = new MemoryBlobCache();
    const repository = new CloudDocumentRepository({
        account,
        config: CONFIG,
        cache,
        clientId: "tab-1",
        encodeThumbnail: async () => PNG,
        createObjectUrl: (blob) => `blob:${blob.type}:${blob.size}`,
    });
    server.requests.length = 0;
    return { server, cloud, account, cache, repository };
}

const calls = (server: FakeServer) => server.calls;

describe("save", () => {
    test("a new document is created with its first version, after uploading its blobs", async () => {
        const { server, cloud, repository } = await setup();

        const saved = await repository.save(request({ thumbnail: "data:image/png;base64,xx" }));

        expect(saved.isOk).toBe(true);
        const head = cloud.head("doc-1")!;
        expect(saved.value).toEqual({
            status: "saved",
            updatedAt: parseUtc(head.createdAt),
            version: head.id,
        });
        const create = server.requests.find((r) => r.method === "POST" && r.path === "/api/documents")!;
        expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(create.body).toMatchObject({
            id: "doc-1",
            name: "Bracket",
            version: {
                parentIds: null,
                kind: "manual",
                formatVersion: 1,
                deviceName: "Desk – Firefox",
                clientId: "tab-1",
                thumbnailSha256: await sha256Hex(PNG),
            },
        });
        // Manifest, BREP and thumbnail, checked first, then uploaded raw.
        expect(calls(server).slice(0, 4)).toEqual([
            "POST /api/blobs/check",
            ...Array(3).fill(expect.stringMatching(/^PUT \/api\/blobs\/[0-9a-f]{64}$/)),
        ]);
        expect(cloud.uploaded).toContain(await sha256Hex(new TextEncoder().encode(BREP)));
        const upload = server.requests.find((r) => r.method === "PUT")!;
        expect(upload.headers["content-type"]).toBe("application/octet-stream");
        expect(upload.headers["content-encoding"]).toBeUndefined();
        expect(repository.stateOf("doc-1")).toBe("saved");
    });

    test("a save based on the head creates a new version with If-Match and its parent", async () => {
        const { server, cloud, repository } = await setup();
        const first = await repository.save(request());
        const base = first.value!.status === "saved" ? first.value!.version : undefined;
        server.requests.length = 0;

        const second = await repository.save(
            request({ baseVersion: base, data: documentData("Bracket", `${BREP}x`) }),
        );

        expect(second.value).toMatchObject({ status: "saved", version: cloud.head("doc-1")!.id });
        const post = server.requests.find((r) => r.path === "/api/documents/doc-1/versions")!;
        expect(post.headers["if-match"]).toBe(`"${base}"`);
        expect(post.body).toMatchObject({ parentIds: [base], kind: "manual" });
        expect(cloud.documents.get("doc-1")!.versions).toHaveLength(2);
    });

    test("unchanged geometry uploads only the manifest", async () => {
        const { server, cloud, repository } = await setup();
        const first = await repository.save(request());
        const uploadedBefore = cloud.uploaded.length;
        server.requests.length = 0;

        // Same BREP, other name: only the manifest differs.
        const base = first.value!.status === "saved" ? first.value!.version : undefined;
        await repository.save(
            request({ baseVersion: base, name: "Bracket", data: documentData("Bracket (edited)") }),
        );

        const puts = server.requests.filter((r) => r.method === "PUT");
        expect(puts).toHaveLength(1);
        const post = server.requests.find((r) => r.path === "/api/documents/doc-1/versions")!;
        expect(puts[0].path).toBe(`/api/blobs/${(post.body as { manifestSha256: string }).manifestSha256}`);
        expect(cloud.uploaded.length).toBe(uploadedBefore + 1);
    });

    test("a stale base answers a conflict with the head's device and time", async () => {
        const { cloud, repository } = await setup();
        const first = await repository.save(request());
        const base = first.value!.status === "saved" ? first.value!.version : undefined;
        const newer = await cloud.saveElsewhere("doc-1", "Laptop – Chrome");

        const stale = await repository.save(request({ baseVersion: base, data: documentData("x") }));

        expect(stale.value).toEqual({
            status: "conflict",
            headVersion: newer.id,
            headCreatedAt: parseUtc(newer.createdAt),
            headDeviceName: "Laptop – Chrome",
        });
        expect(repository.stateOf("doc-1")).toBe("conflict");
        expect(cloud.documents.get("doc-1")!.versions).toHaveLength(2);
    });

    test("creating an id that exists already is a conflict on its head", async () => {
        const { cloud, repository } = await setup();
        await repository.save(request());

        const again = await repository.save(request({ data: documentData("other") }));

        expect(again.value).toMatchObject({ status: "conflict", headVersion: cloud.head("doc-1")!.id });
    });

    test("blobs collected between check and save are uploaded and the save retried with the same key", async () => {
        const { server, cloud, repository } = await setup();
        let dropped = false;
        const realFetch = server.fallback!;
        server.fallback = async (r) => {
            // The BREP vanishes right after the check (garbage collection).
            if (!dropped && r.method === "POST" && r.path === "/api/documents") {
                dropped = true;
                const brep = await sha256Hex(new TextEncoder().encode(BREP));
                cloud.blobs.delete(brep);
            }
            return realFetch(r);
        };

        const saved = await repository.save(request());

        expect(saved.value?.status).toBe("saved");
        const creates = server.requests.filter((r) => r.method === "POST" && r.path === "/api/documents");
        expect(creates).toHaveLength(2);
        expect(creates[1].headers["idempotency-key"]).toBe(creates[0].headers["idempotency-key"]);
    });

    test("a save retried after no answer reuses its Idempotency-Key", async () => {
        const { server, repository } = await setup();
        const cloudFallback = server.fallback!;
        let offline = true;
        server.fallback = async (r) => {
            if (offline && r.path === "/api/documents" && r.method === "POST") {
                offline = false;
                throw new TypeError("Failed to fetch");
            }
            return cloudFallback(r);
        };

        const lost = await repository.save(request());
        const retried = await repository.save(request());

        expect(lost.error).toEqual({ kind: "offline" });
        expect(repository.stateOf("doc-1")).toBe("saved");
        expect(retried.value?.status).toBe("saved");
        const keys = server.requests
            .filter((r) => r.method === "POST" && r.path === "/api/documents")
            .map((r) => r.headers["idempotency-key"]);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
    });

    test("a retried save with another label or thumbnail is a new request (new key)", async () => {
        const { server, repository } = await setup();
        const cloudFallback = server.fallback!;
        server.fallback = async (r) => {
            if (r.path === "/api/documents" && r.method === "POST") throw new TypeError("Failed to fetch");
            return cloudFallback(r);
        };

        await repository.save(request({ label: "A" }));
        await repository.save(request({ label: "B" }));
        await repository.save(request({ label: "B" }));

        const keys = server.requests
            .filter((r) => r.method === "POST" && r.path === "/api/documents")
            .map((r) => r.headers["idempotency-key"]);
        expect(keys).toHaveLength(3);
        expect(keys[1]).not.toBe(keys[0]);
        expect(keys[2]).toBe(keys[1]);
    });

    test("a replayed create whose head is no longer ours is a conflict on that head", async () => {
        const { server, repository } = await setup();
        const head = {
            id: "0190a0c2-0000-7000-8000-000000000099",
            documentId: "doc-1",
            parentIds: ["x"],
            kind: "manual",
            label: null,
            pinned: false,
            createdAt: "2026-09-27T11:00:00Z",
            deviceName: "Laptop – Chrome",
            clientId: null,
            formatVersion: 1,
            manifestSha256: "f".repeat(64),
            thumbnailSha256: null,
            sizeBytes: 1,
        };
        server.on(
            "POST /api/documents",
            json(
                201,
                { id: "doc-1", name: "Bracket", head, headVersionId: head.id },
                { "Idempotent-Replayed": "true" },
            ),
        );

        const saved = await repository.save(request());

        expect(saved.value).toEqual({
            status: "conflict",
            headVersion: head.id,
            headCreatedAt: parseUtc(head.createdAt),
            headDeviceName: "Laptop – Chrome",
        });
    });

    test("loading a document starts from a clean save state (no stale conflict)", async () => {
        const { cloud, repository } = await setup();
        const first = await repository.save(request());
        const base = first.value!.status === "saved" ? first.value!.version : undefined;
        await cloud.saveElsewhere("doc-1");
        await repository.save(request({ baseVersion: base, data: documentData("x") }));
        expect(repository.stateOf("doc-1")).toBe("conflict");

        await repository.load("doc-1");

        expect(repository.stateOf("doc-1")).toBe("idle");
    });

    test("offline marks the document offline; other failures are errors", async () => {
        const { server, repository } = await setup();
        server.on("POST /api/blobs/check", () => {
            throw new TypeError("Failed to fetch");
        });
        const states: string[] = [];
        repository.onStateChanged((_id, state) => states.push(state));

        const offline = await repository.save(request());
        server.on("POST /api/blobs/check", problem(507, "quota_exceeded"));
        const quota = await repository.save(request());

        expect(offline.error).toEqual({ kind: "offline" });
        expect(quota.error).toEqual({ kind: "quota" });
        expect(states).toEqual(["saving", "offline", "saving", "error"]);
    });

    test("an expired session asks to sign in again and the save goes on", async () => {
        const { server, account, repository } = await setup();
        let expired = true;
        const cloudFallback = server.fallback!;
        server.fallback = (r) => {
            if (expired && r.path === "/api/blobs/check") return problem(401, "unauthorized");
            return cloudFallback(r);
        };
        account.setReauthenticationHandler(() => {
            expired = false;
            server.on("POST /api/auth/login", json(200, account.user));
            void account.signIn("ada@example.test", "pw");
        });

        const saved = await repository.save(request());

        expect(saved.value?.status).toBe("saved");
        expect(account.status).toBe("signedIn");
    });

    test("a read-only document is not saved", async () => {
        const { server } = await setup();
        const account = await signedInAccount(server);
        const repository = new CloudDocumentRepository({
            account,
            config: CONFIG,
            cache: new MemoryBlobCache(),
            editGuard: { isReadOnly: (id) => id === "doc-1" },
        });
        server.requests.length = 0;

        const saved = await repository.save(request());

        expect(saved.error).toEqual({ kind: "readOnly" });
        expect(server.requests).toEqual([]);
    });

    test("a renamed document is renamed on the server (metadata only)", async () => {
        const { server, cloud, repository } = await setup();
        const first = await repository.save(request());
        const base = first.value!.status === "saved" ? first.value!.version : undefined;
        server.requests.length = 0;

        await repository.save(
            request({ baseVersion: base, name: "Bracket v2", data: documentData("Bracket v2") }),
        );

        expect(calls(server)).toContain("PATCH /api/documents/doc-1");
        expect(cloud.documents.get("doc-1")!.name).toBe("Bracket v2");
    });
});

describe("load", () => {
    test("reassembles the head from its manifest and blobs, with the server's name", async () => {
        const { cloud, repository } = await setup();
        await repository.save(request());
        cloud.documents.get("doc-1")!.name = "Renamed elsewhere";
        const fresh = new CloudDocumentRepository({
            account: repository.account,
            config: CONFIG,
            cache: new MemoryBlobCache(),
        });

        const loaded = await fresh.load("doc-1");

        expect(loaded.isOk).toBe(true);
        expect(loaded.value).toEqual({
            data: { ...documentData(), name: "Renamed elsewhere" },
            version: cloud.head("doc-1")!.id,
        });
    });

    test("cached blobs are not downloaded again", async () => {
        const { server, repository } = await setup();
        await repository.save(request());
        server.requests.length = 0;

        const loaded = await repository.load("doc-1");

        expect(loaded.isOk).toBe(true);
        expect(calls(server)).toEqual(["GET /api/documents/doc-1"]);
    });

    test("downloads the manifest from its version and the blobs by hash, then caches them", async () => {
        const { server, cloud, repository } = await setup();
        await repository.save(request());
        const cache = new MemoryBlobCache();
        const fresh = new CloudDocumentRepository({ account: repository.account, config: CONFIG, cache });
        server.requests.length = 0;

        await fresh.load("doc-1");

        const head = cloud.head("doc-1")!;
        expect(calls(server)).toEqual([
            "GET /api/documents/doc-1",
            `GET /api/versions/${head.id}`,
            `GET /api/blobs/${await sha256Hex(new TextEncoder().encode(BREP))}`,
        ]);
        expect(cache.entries.has(head.manifestSha256)).toBe(true);
    });

    test("a blob that doesn't match its hash is refused", async () => {
        const { cloud, repository } = await setup();
        await repository.save(request());
        const brep = await sha256Hex(new TextEncoder().encode(BREP));
        cloud.blobs.set(brep, new TextEncoder().encode("tampered"));
        const fresh = new CloudDocumentRepository({
            account: repository.account,
            config: CONFIG,
            cache: new MemoryBlobCache(),
        });

        const loaded = await fresh.load("doc-1");

        expect(loaded.error).toMatchObject({ kind: "failed" });
    });

    test("an unknown document is not found", async () => {
        const { repository } = await setup();

        expect((await repository.load("nope")).error).toEqual({ kind: "notFound", id: "nope" });
    });
});

describe("list, trash, thumbnails", () => {
    test("lists documents with local-time dates, size and head, filtered by name", async () => {
        const { server, cloud, repository } = await setup();
        await repository.save(request());
        await repository.save(
            request({ id: "doc-2", name: "Gear", data: { ...documentData("Gear"), id: "doc-2" } }),
        );
        server.requests.length = 0;

        const page = await repository.list({ search: " gea " });

        expect(server.requests[0].search).toContain("q=gea");
        expect(server.requests[0].search).toContain("trash=false");
        const doc = cloud.documents.get("doc-2")!;
        expect(page.value).toEqual({
            items: [
                {
                    id: "doc-2",
                    name: "Gear",
                    updatedAt: parseUtc(doc.updatedAt),
                    location: "cloud",
                    sizeBytes: cloud.head("doc-2")!.sizeBytes,
                    headVersion: cloud.head("doc-2")!.id,
                },
            ],
        });
    });

    test("delete moves to the trash, restore brings it back", async () => {
        const { repository } = await setup();
        await repository.save(request());

        expect((await repository.delete("doc-1")).isOk).toBe(true);
        expect((await repository.list()).value!.items).toEqual([]);
        const trash = await repository.listTrash();
        expect(trash.value!.items.map((x) => x.id)).toEqual(["doc-1"]);
        expect(Number.isFinite(trash.value!.items[0].deletedAt)).toBe(true);

        expect((await repository.restore("doc-1")).isOk).toBe(true);
        expect((await repository.list()).value!.items.map((x) => x.id)).toEqual(["doc-1"]);
        expect(repository.trashRetentionDays).toBe(30);
    });

    test("a thumbnail is downloaded once and shown through an object URL of its type", async () => {
        const { server, repository } = await setup();
        await repository.save(request({ thumbnail: "data:image/png;base64,xx" }));
        await repository.clearCache();
        const [meta] = (await repository.list()).value!.items;
        server.requests.length = 0;

        const url = await repository.thumbnailUrl(meta);
        const again = await repository.thumbnailUrl(meta);

        expect(url).toBe(`blob:image/png:${PNG.length}`);
        expect(again).toBe(url);
        expect(calls(server)).toEqual([`GET /api/blobs/${await sha256Hex(PNG)}`]);
    });

    test("rename patches the name", async () => {
        const { server, cloud, repository } = await setup();
        await repository.save(request());

        expect((await repository.rename("doc-1", "New name")).isOk).toBe(true);
        expect(server.calls).toContain("PATCH /api/documents/doc-1");
        expect(cloud.documents.get("doc-1")!.name).toBe("New name");
    });
});
