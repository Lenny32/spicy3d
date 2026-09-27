// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { sha256Hex } from "@spicy3d/core";
import type { ApiSchema } from "../../src/api";
import { type FakeServer, json, problem, type RecordedRequest } from "./fakeServer";

type VersionResponse = ApiSchema<"VersionResponse">;
type NewVersionRequest = ApiSchema<"NewVersionRequest">;

export interface FakeDocument {
    id: string;
    name: string;
    versions: VersionResponse[];
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}

/**
 * The documents, versions and blobs endpoints of SpicySrv (SRV-05), in memory, with the rules the
 * client relies on: content-addressed uploads checked against their hash, `If-Match` required
 * (428), a stale base answering 409 `version_conflict` with the head, referenced blobs required
 * (422 `blobs_missing`), `Idempotency-Key` replays, trash and restore, the version history
 * (newest first, `cursor` = the last id of the previous page, `kind` filter) and labels / pins. Installed as the fallback of
 * a {@link FakeServer}, so scripted routes (`on(...)`) still win.
 */
export class FakeDocumentServer {
    readonly blobs = new Map<string, Uint8Array>();
    readonly documents = new Map<string, FakeDocument>();
    /** SHA-256 of every `PUT /api/blobs/{sha}` that stored a blob, in order. */
    readonly uploaded: string[] = [];
    private readonly keys = new Map<string, { documentId: string; versionId: string; create: boolean }>();
    private clock = Date.parse("2026-09-27T10:00:00Z");
    private sequence = 0;

    constructor(readonly server: FakeServer) {
        server.fallback = (request) => this.handle(request);
    }

    private now(): string {
        this.clock += 60_000;
        return new Date(this.clock).toISOString().replace(/\.\d+Z$/, "Z");
    }

    private versionId(): string {
        this.sequence++;
        return `0190a0c2-0000-7000-8000-${String(this.sequence).padStart(12, "0")}`;
    }

    /**
     * Adds a version on top of the head as another device would, reusing the head's content
     * (manifest, blobs, thumbnail) — for histories of many versions without uploads.
     */
    addVersion(
        id: string,
        fields: Partial<
            Pick<
                VersionResponse,
                "kind" | "label" | "pinned" | "deviceName" | "createdAt" | "formatVersion" | "parentIds"
            >
        > = {},
    ): VersionResponse {
        const document = this.documents.get(id)!;
        const previous = document.versions.at(-1)!;
        const version: VersionResponse = {
            ...previous,
            id: this.versionId(),
            parentIds: [previous.id],
            kind: "auto",
            label: null,
            pinned: false,
            createdAt: this.now(),
            clientId: "other-tab",
            ...fields,
        };
        document.versions.push(version);
        document.updatedAt = version.createdAt;
        return version;
    }

    /**
     * SpicySrv's autosave retention, simplified to its first rule (SRV-06): autosaves older than
     * `keepAllHours` before `now` go unless labeled, pinned or the head; children are re-parented.
     */
    pruneAutosaves(id: string, keepAllHours: number, now: number): string[] {
        const document = this.documents.get(id)!;
        const head = document.versions.at(-1);
        const pruned = document.versions.filter(
            (v) =>
                v.kind === "auto" &&
                !v.label &&
                !v.pinned &&
                v !== head &&
                Date.parse(v.createdAt) < now - keepAllHours * 3_600_000,
        );
        const gone = new Map(pruned.map((v) => [v.id, v.parentIds]));
        const parentsOf = (ids: string[]): string[] =>
            ids.flatMap((p) => (gone.has(p) ? parentsOf(gone.get(p)!) : [p]));
        document.versions = document.versions
            .filter((v) => !gone.has(v.id))
            .map((v) => ({ ...v, parentIds: parentsOf(v.parentIds) }));
        return pruned.map((v) => v.id);
    }

    head(id: string): VersionResponse | undefined {
        return this.documents.get(id)?.versions.at(-1);
    }

    /** Another device saves a new head (for conflicts). */
    async saveElsewhere(id: string, deviceName = "Laptop – Chrome"): Promise<VersionResponse> {
        const document = this.documents.get(id)!;
        const previous = document.versions.at(-1)!;
        const version: VersionResponse = {
            ...previous,
            id: this.versionId(),
            parentIds: [previous.id],
            createdAt: this.now(),
            deviceName,
            clientId: "other-tab",
        };
        document.versions.push(version);
        document.updatedAt = version.createdAt;
        return version;
    }

    private summary(document: FakeDocument) {
        const head = document.versions.at(-1) ?? null;
        return {
            id: document.id,
            name: document.name,
            headVersionId: head?.id ?? null,
            sizeBytes: head?.sizeBytes ?? 0,
            thumbnailSha256: head?.thumbnailSha256 ?? null,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            deletedAt: document.deletedAt as string,
        };
    }

    private response(document: FakeDocument, status = 200) {
        const head = document.versions.at(-1) ?? null;
        return json(status, { ...this.summary(document), head }, head ? { ETag: `"${head.id}"` } : {});
    }

    private referenced(version: NewVersionRequest): string[] {
        const all = new Set([version.manifestSha256, ...(version.blobs ?? [])]);
        if (version.thumbnailSha256) all.add(version.thumbnailSha256);
        return [...all];
    }

    private storeVersion(document: FakeDocument, request: NewVersionRequest, parents: string[]) {
        const refs = this.referenced(request);
        const version: VersionResponse = {
            id: this.versionId(),
            documentId: document.id,
            parentIds: parents,
            kind: request.kind ?? "manual",
            label: request.label,
            pinned: false,
            createdAt: this.now(),
            deviceName: request.deviceName,
            clientId: request.clientId,
            formatVersion: request.formatVersion,
            manifestSha256: request.manifestSha256,
            thumbnailSha256: request.thumbnailSha256,
            sizeBytes: refs.reduce((sum, sha) => sum + (this.blobs.get(sha)?.length ?? 0), 0),
        };
        document.versions.push(version);
        document.updatedAt = version.createdAt;
        return version;
    }

    private missing(version: NewVersionRequest): string[] {
        return this.referenced(version)
            .filter((sha) => !this.blobs.has(sha))
            .sort();
    }

    private async handle(request: RecordedRequest): Promise<Response> {
        const { method, path } = request;
        const parts = path.split("/").filter(Boolean); // ["api", "documents", id, ...]
        if (parts[1] === "blobs") return this.handleBlobs(request, parts[2]);
        if (parts[1] === "versions" && method === "PATCH") {
            const version = [...this.documents.values()]
                .flatMap((d) => d.versions)
                .find((v) => v.id === parts[2]);
            if (!version) return problem(404, "not_found");
            const body = request.body as { label: string | null; pinned: boolean | null };
            if (typeof body.label === "string" && body.label.length > 200) {
                return problem(422, "validation_failed", { errors: { label: ["label_too_long"] } });
            }
            if (typeof body.label === "string") version.label = body.label.trim() || null;
            if (typeof body.pinned === "boolean") version.pinned = body.pinned;
            return json(200, version);
        }
        if (parts[1] === "versions" && method === "GET") {
            const version = [...this.documents.values()]
                .flatMap((d) => d.versions)
                .find((v) => v.id === parts[2]);
            const bytes = version && this.blobs.get(version.manifestSha256);
            return bytes
                ? new Response(bytes as BodyInit, {
                      status: 200,
                      headers: { "Content-Type": "application/json" },
                  })
                : problem(404, "not_found");
        }
        if (parts[1] !== "documents") return problem(404, "not_found");
        const id = parts[2];
        const document = id ? this.documents.get(id) : undefined;
        const key = request.headers["idempotency-key"];

        if (!id && method === "GET") {
            const query = new URLSearchParams(request.search);
            const trash = query.get("trash") === "true";
            const q = query.get("q")?.toLowerCase();
            const items = [...this.documents.values()]
                .filter((d) => (trash ? d.deletedAt !== null : d.deletedAt === null))
                .filter((d) => !q || d.name.toLowerCase().includes(q))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((d) => this.summary(d));
            return json(200, { items, nextCursor: null });
        }
        if (!id && method === "POST") {
            const body = request.body as { id: string; name: string; version: NewVersionRequest };
            const replay = key ? this.keys.get(key) : undefined;
            if (replay?.create && replay.documentId === body.id) {
                return this.response(this.documents.get(body.id)!, 201);
            }
            if (this.documents.has(body.id)) return problem(409, "document_exists");
            const missing = this.missing(body.version);
            if (missing.length > 0) return problem(422, "blobs_missing", { missing });
            const created: FakeDocument = {
                id: body.id,
                name: body.name,
                versions: [],
                createdAt: this.now(),
                updatedAt: "",
                deletedAt: null,
            };
            this.documents.set(body.id, created);
            const version = this.storeVersion(created, body.version, []);
            if (key) this.keys.set(key, { documentId: body.id, versionId: version.id, create: true });
            return this.response(created, 201);
        }
        if (!document) return problem(404, "not_found");

        if (parts[3] === "versions" && method === "GET") {
            const query = new URLSearchParams(request.search);
            const cursor = query.get("cursor");
            const kind = query.get("kind");
            const limit = Number(query.get("limit") ?? 50);
            const all = [...document.versions]
                .reverse()
                .filter((v) => !kind || v.kind === kind)
                .filter((v) => !cursor || v.id < cursor);
            const items = all.slice(0, limit);
            return json(200, { items, nextCursor: all.length > limit ? items.at(-1)!.id : null });
        }
        if (parts[3] === "versions" && method === "POST") {
            const body = request.body as NewVersionRequest;
            const replay = key ? this.keys.get(key) : undefined;
            if (replay && !replay.create && replay.documentId === id) {
                const version = document.versions.find((v) => v.id === replay.versionId)!;
                return json(201, version, { ETag: `"${version.id}"`, "Idempotent-Replayed": "true" });
            }
            const ifMatch = request.headers["if-match"]?.replace(/"/g, "");
            if (!ifMatch) return problem(428, "precondition_required");
            if (document.deletedAt) return problem(409, "document_in_trash");
            const head = document.versions.at(-1)!;
            if (head.id !== ifMatch) {
                return problem(409, "version_conflict", {
                    headVersionId: head.id,
                    headCreatedAt: head.createdAt,
                    headDeviceName: head.deviceName,
                });
            }
            const parents = body.parentIds ?? [];
            if (parents.length !== (body.kind === "merge" ? 2 : 1)) {
                return problem(422, "validation_failed", { errors: { parentIds: ["invalid_parents"] } });
            }
            const missing = this.missing(body);
            if (missing.length > 0) return problem(422, "blobs_missing", { missing });
            const version = this.storeVersion(document, body, parents);
            if (key) this.keys.set(key, { documentId: id, versionId: version.id, create: false });
            return json(201, version, { ETag: `"${version.id}"` });
        }
        if (parts[3] === "restore" && method === "POST") {
            document.deletedAt = null;
            document.updatedAt = this.now();
            return this.response(document);
        }
        switch (method) {
            case "GET":
                return this.response(document);
            case "PATCH":
                document.name = (request.body as { name: string }).name;
                document.updatedAt = this.now();
                return this.response(document);
            case "DELETE":
                document.deletedAt ??= this.now();
                document.updatedAt = document.deletedAt;
                return new Response(null, { status: 204 });
        }
        return problem(405, "method_not_allowed");
    }

    private async handleBlobs(request: RecordedRequest, segment: string | undefined): Promise<Response> {
        if (segment === "check" && request.method === "POST") {
            const hashes = (request.body as { hashes: string[] }).hashes;
            return json(200, { missing: [...new Set(hashes)].filter((h) => !this.blobs.has(h)) });
        }
        const sha = segment ?? "";
        if (request.method === "PUT") {
            const bytes = request.body as Uint8Array;
            if ((await sha256Hex(bytes)) !== sha) return problem(422, "hash_mismatch");
            this.blobs.set(sha, bytes);
            this.uploaded.push(sha);
            return new Response(null, { status: 204 });
        }
        const bytes = this.blobs.get(sha);
        return bytes
            ? new Response(bytes as BodyInit, {
                  status: 200,
                  headers: { "Content-Type": "application/octet-stream" },
              })
            : problem(404, "not_found");
    }
}

/** The client's config with the storage limits the repository reads. */
export const CONFIG: ApiSchema<"ConfigResponse"> = {
    apiVersion: "1",
    eventsSocket: "/api/events",
    features: { signup: true, emailVerification: false, email: false, mcp: false },
    mcp: null,
    publicUrl: "https://spicy.test",
    serverTime: "2026-09-27T10:00:00Z",
    storage: {
        autosaveRetention: { keepAllHours: 24, hourlyDays: 7, dailyDays: 30 },
        maxManifestBytes: 16 * 1024 * 1024,
        maxUploadBytes: 100 * 1024 * 1024,
        quotaBytes: null,
        trashRetentionDays: 30,
    },
    version: "0.0.1",
};
