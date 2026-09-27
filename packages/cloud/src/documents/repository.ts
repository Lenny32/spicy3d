// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    DOCUMENT_FORMAT_VERSION,
    type DocumentListQuery,
    type DocumentMeta,
    type DocumentPage,
    type DocumentRepositoryError,
    I18n,
    type IDocumentRepository,
    type LoadedDocument,
    Logger,
    manifestBlobRefs,
    parseUtc,
    Result,
    type SaveConflict,
    type SaveOutcome,
    type SaveRequest,
    type Serialized,
    type SplitManifestOptions,
    type StoredDocumentInfo,
    sha256Hex,
    splitManifest,
} from "@spicy3d/core";
import type { Account } from "../account/account";
import type { ApiSchema, ConfigResponse } from "../api";
import { ifMatch, newIdempotencyKey } from "../client";
import { type CloudError, cloudErrorMessage, fieldErrorMessageKey, problemCode } from "../problem";
import { defaultBlobCache, type IBlobCache } from "./blobCache";
import { encodeThumbnail, thumbnailType } from "./thumbnail";

type DocumentSummary = ApiSchema<"DocumentSummary">;
type NewVersionRequest = ApiSchema<"NewVersionRequest">;

/** A version of a cloud document as the server lists it (`VersionResponse`). */
export type CloudVersion = ApiSchema<"VersionResponse">;

/** A page of a document's history, newest first. */
export interface VersionPage {
    items: CloudVersion[];
    /** Pass as `cursor` for the next (older) page; `undefined` on the last page. */
    nextCursor?: string;
}

export interface VersionListQuery {
    cursor?: string;
    /** Page size, 1–200 (the server's default is 50). */
    limit?: number;
}

/** A label and pin change of a version (`PATCH /api/versions/{id}`); omitted fields are kept. */
export interface VersionUpdate {
    /** `""` removes the label. */
    label?: string;
    pinned?: boolean;
}

/**
 * A restore's new head. `onTopOf`: another save moved the head between reading it and restoring, so
 * the restore went on top of that newer save (nothing is lost, but the user should know).
 */
export interface RestoredVersion {
    version: CloudVersion;
    onTopOf?: { deviceName?: string; createdAt?: number };
}

/** Restoring retries this many times when another save moved the head in between. */
const RESTORE_ATTEMPTS = 3;

/** At most this many hashes per `POST /api/blobs/check` (SpicySrv `MaxCheckHashes`). */
const MAX_CHECK_HASHES = 1000;
/** Blob transfers running at once. */
const TRANSFER_CONCURRENCY = 4;

/**
 * What the title bar shows for a cloud document: the outcome of its last save, or `saving` while
 * one runs. `idle` = not saved (nor failed) since it was opened.
 */
export type CloudSaveState = "idle" | "saving" | "saved" | "offline" | "conflict" | "error";

/** Tells the repository which documents this tab may only show (another tab edits them). */
export interface IEditGuard {
    isReadOnly(id: string): boolean;
}

export interface CloudDocumentRepositoryOptions {
    account: Account;
    config: ConfigResponse;
    cache?: IBlobCache;
    /** This tab, echoed in the server's real-time events (CLOUD-10 ignores its own saves). */
    clientId?: string;
    /** View image → thumbnail bytes; `undefined` saves without one. */
    encodeThumbnail?: (imageUrl: string) => Promise<Uint8Array | undefined>;
    split?: SplitManifestOptions;
    editGuard?: IEditGuard;
    /** Object URL of downloaded thumbnails (replaced in tests). */
    createObjectUrl?: (blob: Blob) => string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A new id per browser tab. */
export const TAB_CLIENT_ID: string = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}`;

async function mapLimit<T, U>(items: T[], limit: number, run: (item: T) => Promise<U>): Promise<U[]> {
    const results: U[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function toRepositoryError(error: CloudError, id?: string): DocumentRepositoryError {
    if (error.kind === "offline") return { kind: "offline" };
    if (error.kind === "problem") {
        if (error.status === 401) return { kind: "unauthorized" };
        if (error.status === 404 && id) return { kind: "notFound", id };
        if (error.status === 507 || error.problem.code === "quota_exceeded") return { kind: "quota" };
    }
    return { kind: "failed", message: cloudErrorMessage(error) };
}

/** An answer the server gave for good: retrying the same request can't change it. */
function isFinal(error: CloudError): boolean {
    return error.kind === "problem" && error.status < 500 && error.status !== 429 && error.status !== 401;
}

type SavedVersion = ApiSchema<"VersionResponse">;

/** A created document always has its first version; anything else is an answer this client can't use. */
function noHead<T>(result: Result<T, CloudError>): Result<SavedVersion, CloudError> {
    return result.isOk ? Result.err({ kind: "invalidResponse" }) : Result.err(result.error);
}

function replayedConflict(head: SavedVersion): CloudError {
    return {
        kind: "problem",
        status: 409,
        problem: {
            code: "version_conflict",
            headVersionId: head.id,
            headCreatedAt: head.createdAt,
            headDeviceName: head.deviceName ?? undefined,
        },
    };
}

class RepositoryFailure {
    constructor(readonly error: DocumentRepositoryError) {}
}

function failureOf(error: unknown): DocumentRepositoryError {
    return error instanceof RepositoryFailure
        ? error.error
        : { kind: "failed", message: (error as Error).message };
}

/**
 * Documents on the Spicy3D server (SRV-05). A version is a manifest — the serialized document
 * with its large values moved to content-addressed blobs (`splitManifest`) — plus those blobs and
 * an optional thumbnail. Saving uploads only the blobs the server doesn't have yet (unchanged
 * geometry costs nothing), then creates the document (`POST /api/documents`) or a new version on
 * top of `baseVersion` (`If-Match`; a stale base answers `conflict`). Loading reads the head's
 * manifest and blobs through the {@link IBlobCache}. Every call goes through `account.call`, so an
 * expired session asks to sign in again and the request is retried with the same `Idempotency-Key`.
 */
export class CloudDocumentRepository implements IDocumentRepository {
    readonly kind = "cloud";
    readonly cache: IBlobCache;
    readonly clientId: string;
    private readonly states = new Map<string, CloudSaveState>();
    private readonly conflicts = new Map<string, SaveConflict>();
    private readonly stateListeners = new Set<(id: string, state: CloudSaveState) => void>();
    /** The server's name of each document seen, to rename (metadata only) when the app's differs. */
    private readonly serverNames = new Map<string, string>();
    private readonly thumbnailShas = new Map<string, string>();
    private readonly thumbnailUrls = new Map<string, Promise<string | undefined>>();
    /** Idempotency keys of saves that got no final answer, reused when the same save is retried. */
    private readonly pendingKeys = new Map<string, string>();
    private readonly encodeThumbnail: (imageUrl: string) => Promise<Uint8Array | undefined>;
    private readonly createObjectUrl: (blob: Blob) => string;

    /** The user this repository saves for; another one signed in never gets its documents. */
    readonly ownerId: string | undefined;

    constructor(readonly options: CloudDocumentRepositoryOptions) {
        this.ownerId = options.account.user?.id;
        this.cache = options.cache ?? defaultBlobCache();
        this.clientId = options.clientId ?? TAB_CLIENT_ID;
        this.encodeThumbnail = options.encodeThumbnail ?? encodeThumbnail;
        this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    }

    get account(): Account {
        return this.options.account;
    }

    get trashRetentionDays(): number {
        return this.options.config.storage.trashRetentionDays;
    }

    // ---- Save state --------------------------------------------------------------------------

    stateOf(id: string): CloudSaveState {
        return this.states.get(id) ?? "idle";
    }

    /** Returns the unsubscribe function. */
    onStateChanged(listener: (id: string, state: CloudSaveState) => void): () => void {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }

    private setState(id: string, state: CloudSaveState) {
        if (this.stateOf(id) === state) return;
        this.states.set(id, state);
        for (const listener of [...this.stateListeners]) listener(id, state);
    }

    /** Another tab edits the document: saving it here answers `readOnly`. */
    isReadOnly(id: string): boolean {
        return this.options.editGuard?.isReadOnly(id) ?? false;
    }

    /** The conflict the last save of a document met, while that is its state. */
    conflictOf(id: string): SaveConflict | undefined {
        return this.stateOf(id) === "conflict" ? this.conflicts.get(id) : undefined;
    }

    // ---- Listing -----------------------------------------------------------------------------

    list(query: DocumentListQuery = {}): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        return this.listPage(query, false);
    }

    listTrash(query: DocumentListQuery = {}): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        return this.listPage(query, true);
    }

    private async listPage(
        { cursor, search, limit }: DocumentListQuery,
        trash: boolean,
    ): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        const q = search?.trim() || undefined;
        const result = await this.account.call((api) =>
            api.GET("/api/documents", { params: { query: { cursor, q, limit, trash } } }),
        );
        if (!result.isOk) return Result.err(toRepositoryError(result.error));
        const { items, nextCursor } = result.value.data;
        const page: DocumentPage = { items: items.map((x) => this.toMeta(x)) };
        if (nextCursor) page.nextCursor = nextCursor;
        return Result.ok(page);
    }

    private toMeta(summary: DocumentSummary): DocumentMeta {
        this.serverNames.set(summary.id, summary.name);
        if (summary.thumbnailSha256) this.thumbnailShas.set(summary.id, summary.thumbnailSha256);
        const meta: DocumentMeta = {
            id: summary.id,
            name: summary.name,
            updatedAt: parseUtc(summary.updatedAt),
            location: "cloud",
            sizeBytes: summary.sizeBytes,
        };
        if (summary.headVersionId) meta.headVersion = summary.headVersionId;
        // Typed `string` but null outside the trash (SpicySrv#8).
        if (summary.deletedAt) meta.deletedAt = parseUtc(summary.deletedAt);
        return meta;
    }

    async thumbnailUrl(meta: DocumentMeta): Promise<string | undefined> {
        const sha = this.thumbnailShas.get(meta.id);
        return sha ? this.imageUrl(sha) : undefined;
    }

    /** The object URL of a thumbnail blob (a version's), downloaded once; `undefined` if unusable. */
    imageUrl(sha: string): Promise<string | undefined> {
        let url = this.thumbnailUrls.get(sha);
        if (!url) {
            url = this.blob(sha).then(
                (bytes) => {
                    const type = thumbnailType(bytes);
                    return type ? this.createObjectUrl(new Blob([bytes as BlobPart], { type })) : undefined;
                },
                () => undefined,
            );
            this.thumbnailUrls.set(sha, url);
        }
        return url;
    }

    // ---- Loading -----------------------------------------------------------------------------

    /** Signed in (or expired, about to sign in again) as the user this repository belongs to. */
    private isOwnersSession(): boolean {
        const user = this.account.user;
        return user !== undefined && user.id === this.ownerId;
    }

    /** Forgets the last save outcome of a document (it was closed or reloaded). */
    resetState(id: string): void {
        this.setState(id, "idle");
    }

    async load(id: string): Promise<Result<LoadedDocument, DocumentRepositoryError>> {
        if (!this.isOwnersSession()) return Result.err({ kind: "unauthorized" });
        // A reload (open latest, taking over from another tab) starts from a clean state.
        this.resetState(id);
        const document = await this.account.call((api) =>
            api.GET("/api/documents/{id}", { params: { path: { id } } }),
        );
        if (!document.isOk) return Result.err(toRepositoryError(document.error, id));
        const { head, name } = document.value.data;
        if (!head) return Result.err({ kind: "notFound", id });
        this.serverNames.set(id, name);
        if (head.thumbnailSha256) this.thumbnailShas.set(id, head.thumbnailSha256);

        const data = await this.content(head);
        // Renames are metadata only: the server's name is the document's name.
        return data.isOk
            ? Result.ok({ data: { ...data.value, name }, version: head.id })
            : Result.err(data.error);
    }

    /** The serialized document a version holds: its manifest, assembled with its blobs (cached). */
    private async content(version: CloudVersion): Promise<Result<Serialized, DocumentRepositoryError>> {
        try {
            const manifest = await this.manifest(version);
            const refs = manifestBlobRefs(manifest);
            const blobs = new Map<string, Uint8Array>();
            await mapLimit(refs, TRANSFER_CONCURRENCY, async (sha) => {
                blobs.set(sha, await this.blob(sha));
            });
            const assembled = assembleManifest(manifest, (sha) => blobs.get(sha));
            if (!assembled.isOk) {
                return Result.err({ kind: "failed", message: JSON.stringify(assembled.error) });
            }
            return Result.ok(assembled.value);
        } catch (error) {
            return Result.err(failureOf(error));
        }
    }

    /** A version's manifest (JSON), from the cache or `GET /api/versions/{id}`. Throws. */
    private async manifest(version: CloudVersion): Promise<unknown> {
        return JSON.parse(decoder.decode(await this.blob(version.manifestSha256, version.id)));
    }

    /**
     * A blob from the cache, else from the server (a manifest from its version: `versionId`),
     * checked against its hash and cached. Throws a {@link RepositoryFailure}.
     */
    private async blob(sha: string, versionId?: string): Promise<Uint8Array> {
        const cached = await this.cache.get(sha);
        if (cached) return cached;
        const result = await this.account.call((api) =>
            versionId
                ? api.GET("/api/versions/{versionId}", {
                      params: { path: { versionId } },
                      parseAs: "arrayBuffer",
                  })
                : api.GET("/api/blobs/{sha256}", {
                      params: { path: { sha256: sha } },
                      parseAs: "arrayBuffer",
                  }),
        );
        if (!result.isOk) throw new RepositoryFailure(toRepositoryError(result.error));
        const bytes = new Uint8Array(result.value.data as unknown as ArrayBuffer);
        if ((await sha256Hex(bytes)) !== sha) {
            throw new RepositoryFailure({ kind: "failed", message: `blob ${sha} does not match its hash` });
        }
        await this.cache.put(sha, bytes);
        return bytes;
    }

    // ---- Saving ------------------------------------------------------------------------------

    async save(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        if (!this.isOwnersSession()) return Result.err({ kind: "unauthorized" });
        if (this.isReadOnly(request.id)) return Result.err({ kind: "readOnly" });
        this.setState(request.id, "saving");
        let result: Result<SaveOutcome, DocumentRepositoryError>;
        try {
            result = await this.saveVersion(request);
        } catch (error) {
            result = Result.err(failureOf(error));
        }
        if (!result.isOk) {
            this.setState(request.id, result.error.kind === "offline" ? "offline" : "error");
        } else {
            if (result.value.status === "conflict") this.conflicts.set(request.id, result.value);
            else this.conflicts.delete(request.id);
            this.setState(request.id, result.value.status === "saved" ? "saved" : "conflict");
        }
        return result;
    }

    private async saveVersion(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const { id, baseVersion } = request;
        const split = await splitManifest(request.data, this.options.split);
        const manifestBytes = encoder.encode(JSON.stringify(split.manifest));
        const manifestSha = await sha256Hex(manifestBytes);
        if (manifestBytes.byteLength > this.options.config.storage.maxManifestBytes) {
            return Result.err({
                kind: "failed",
                message: I18n.translate(fieldErrorMessageKey("manifest_too_large")),
            });
        }

        const thumbnail = request.thumbnail ? await this.encodeThumbnail(request.thumbnail) : undefined;
        const thumbnailSha = thumbnail ? await sha256Hex(thumbnail) : undefined;
        const uploads = new Map<string, Uint8Array>([[manifestSha, manifestBytes], ...split.blobs]);
        if (thumbnail && thumbnailSha) uploads.set(thumbnailSha, thumbnail);
        await this.upload(uploads, await this.missing([...uploads.keys()]));

        const version: NewVersionRequest = {
            parentIds: baseVersion ? [baseVersion] : null,
            kind: request.kind,
            label: request.label ?? null,
            manifestSha256: manifestSha,
            blobs: [...split.blobs.keys()],
            thumbnailSha256: thumbnailSha ?? null,
            formatVersion: Number(request.data["formatVersion"]) || DOCUMENT_FORMAT_VERSION,
            deviceName: this.account.deviceSettings.effectiveDeviceName,
            clientId: this.clientId,
        };
        const pendingKey = [id, baseVersion, manifestSha, request.kind, request.label, thumbnailSha]
            .map((x) => x ?? "")
            .join("|");
        const key = this.pendingKeys.get(pendingKey) ?? newIdempotencyKey();
        this.pendingKeys.set(pendingKey, key);

        const send = (): Promise<Result<SavedVersion, CloudError>> =>
            baseVersion
                ? this.account
                      .call((api) =>
                          api.POST("/api/documents/{id}/versions", {
                              params: {
                                  path: { id },
                                  header: { "If-Match": ifMatch(baseVersion), "Idempotency-Key": key },
                              },
                              body: version,
                          }),
                      )
                      .then((r) => (r.isOk ? Result.ok(r.value.data) : Result.err(r.error)))
                : this.account
                      .call((api) =>
                          api.POST("/api/documents", {
                              params: { header: { "Idempotency-Key": key } },
                              body: { id, name: request.name, version },
                          }),
                      )
                      .then((r) => {
                          if (!r.isOk || !r.value.data.head) return noHead(r);
                          const head = r.value.data.head;
                          // A replayed create answers the document's *current* head: when it is no
                          // longer our version, a newer save got in meanwhile.
                          if (r.value.replayed && head.manifestSha256 !== manifestSha) {
                              return Result.err(replayedConflict(head));
                          }
                          return Result.ok(head);
                      });

        let answer = await send();
        if (!answer.isOk && problemCode(answer.error) === "blobs_missing") {
            // Garbage collected between the check and the save: upload them and retry once.
            const missing = answer.error.kind === "problem" ? (answer.error.problem.missing ?? []) : [];
            await this.upload(uploads, missing);
            answer = await send();
        }
        if (!answer.isOk) {
            if (isFinal(answer.error)) this.pendingKeys.delete(pendingKey);
            return this.saveFailure(id, answer.error);
        }
        this.pendingKeys.delete(pendingKey);

        // The server keeps every blob of the version now: cache them for the next load.
        await Promise.all([...uploads].map(([sha, bytes]) => this.cache.put(sha, bytes)));
        if (thumbnailSha) this.thumbnailShas.set(id, thumbnailSha);
        if (!baseVersion) this.serverNames.set(id, request.name);
        await this.renameIfNeeded(id, request.name);
        const head = answer.value;
        return Result.ok({
            status: "saved",
            updatedAt: parseUtc(head.createdAt),
            version: head.id,
        });
    }

    private async saveFailure(
        id: string,
        error: CloudError,
    ): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const code = problemCode(error);
        if (code === "version_conflict" && error.kind === "problem") {
            const conflict: SaveConflict = { status: "conflict" };
            if (error.problem.headVersionId) conflict.headVersion = error.problem.headVersionId;
            if (error.problem.headCreatedAt) conflict.headCreatedAt = parseUtc(error.problem.headCreatedAt);
            if (error.problem.headDeviceName) conflict.headDeviceName = error.problem.headDeviceName;
            return Result.ok(conflict);
        }
        if (code === "document_exists") {
            // Created meanwhile (another tab, or moved here before): its head is the conflict.
            const existing = await this.account.call((api) =>
                api.GET("/api/documents/{id}", { params: { path: { id } } }),
            );
            const head = existing.isOk ? existing.value.data.head : undefined;
            const conflict: SaveConflict = { status: "conflict" };
            if (head) {
                conflict.headVersion = head.id;
                conflict.headCreatedAt = parseUtc(head.createdAt);
                if (head.deviceName) conflict.headDeviceName = head.deviceName;
            }
            return Result.ok(conflict);
        }
        return Result.err(toRepositoryError(error, id));
    }

    /** The hashes among `hashes` the server still needs (`POST /api/blobs/check`). */
    private async missing(hashes: string[]): Promise<string[]> {
        const missing: string[] = [];
        for (let i = 0; i < hashes.length; i += MAX_CHECK_HASHES) {
            const chunk = hashes.slice(i, i + MAX_CHECK_HASHES);
            const result = await this.account.call((api) =>
                api.POST("/api/blobs/check", { body: { hashes: chunk } }),
            );
            if (!result.isOk) throw new RepositoryFailure(toRepositoryError(result.error));
            missing.push(...result.value.data.missing);
        }
        return missing;
    }

    /**
     * `PUT /api/blobs/{sha256}` of each missing blob, as raw bytes: the server hashes the body as
     * received and stores it gzipped itself; it doesn't accept `Content-Encoding: gzip` uploads.
     */
    private async upload(uploads: Map<string, Uint8Array>, missing: string[]): Promise<void> {
        await mapLimit(missing, TRANSFER_CONCURRENCY, async (sha) => {
            const bytes = uploads.get(sha);
            if (!bytes) {
                throw new RepositoryFailure({ kind: "failed", message: `the server lacks blob ${sha}` });
            }
            const result = await this.account.call((api) =>
                api.PUT("/api/blobs/{sha256}", {
                    params: { path: { sha256: sha } },
                    body: bytes as unknown as Blob,
                    bodySerializer: (body: unknown) => body as BodyInit,
                    headers: { "Content-Type": "application/octet-stream" },
                }),
            );
            if (!result.isOk) throw new RepositoryFailure(toRepositoryError(result.error));
        });
    }

    private async renameIfNeeded(id: string, name: string) {
        if (this.serverNames.get(id) === name) return;
        const renamed = await this.rename(id, name);
        if (!renamed.isOk) Logger.warn(`[cloud] rename of ${id} failed: ${renamed.error.kind}`);
    }

    // ---- Metadata, trash ---------------------------------------------------------------------

    async rename(id: string, name: string): Promise<Result<void, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.PATCH("/api/documents/{id}", { params: { path: { id } }, body: { name } }),
        );
        if (!result.isOk) return Result.err(toRepositoryError(result.error, id));
        this.serverNames.set(id, result.value.data.name);
        return Result.ok(undefined);
    }

    /** Moves the document to the server's trash (restorable for `trashRetentionDays`). */
    async delete(id: string): Promise<Result<void, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.DELETE("/api/documents/{id}", { params: { path: { id } } }),
        );
        return result.isOk ? Result.ok(undefined) : Result.err(toRepositoryError(result.error, id));
    }

    async restore(id: string): Promise<Result<void, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.POST("/api/documents/{id}/restore", { params: { path: { id } } }),
        );
        return result.isOk ? Result.ok(undefined) : Result.err(toRepositoryError(result.error, id));
    }

    async stat(id: string): Promise<Result<StoredDocumentInfo | undefined, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.GET("/api/documents/{id}", { params: { path: { id } } }),
        );
        if (!result.isOk) {
            return result.error.kind === "problem" && result.error.status === 404
                ? Result.ok(undefined)
                : Result.err(toRepositoryError(result.error, id));
        }
        const { name, headVersionId, deletedAt } = result.value.data;
        return Result.ok({ name, version: headVersionId ?? undefined, trashed: Boolean(deletedAt) });
    }

    /** The head version of a document, e.g. to tell whether another tab saved meanwhile. */
    async headVersion(id: string): Promise<Result<string | undefined, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.GET("/api/documents/{id}", { params: { path: { id } } }),
        );
        if (!result.isOk) return Result.err(toRepositoryError(result.error, id));
        return Result.ok(result.value.data.headVersionId ?? undefined);
    }

    // ---- History (SRV-05, SRV-06) ------------------------------------------------------------

    /** A page of the document's versions, newest first (`GET /api/documents/{id}/versions`). */
    async listVersions(
        id: string,
        { cursor, limit }: VersionListQuery = {},
    ): Promise<Result<VersionPage, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.GET("/api/documents/{id}/versions", { params: { path: { id }, query: { cursor, limit } } }),
        );
        if (!result.isOk) return Result.err(toRepositoryError(result.error, id));
        const { items, nextCursor } = result.value.data;
        const page: VersionPage = { items };
        if (nextCursor) page.nextCursor = nextCursor;
        return Result.ok(page);
    }

    /**
     * The document a version holds, as saved (in its own format: the caller migrates, e.g. through
     * `Document.load`). Its manifest and blobs are downloaded once, then read from the cache.
     */
    loadVersion(version: CloudVersion): Promise<Result<Serialized, DocumentRepositoryError>> {
        if (!this.isOwnersSession()) return Promise.resolve(Result.err({ kind: "unauthorized" }));
        return this.content(version);
    }

    /** Sets or clears the label, pins or unpins (a labeled or pinned autosave is never pruned). */
    async updateVersion(
        versionId: string,
        { label, pinned }: VersionUpdate,
    ): Promise<Result<CloudVersion, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.PATCH("/api/versions/{versionId}", {
                params: { path: { versionId } },
                body: { label: label ?? null, pinned: pinned ?? null },
            }),
        );
        return result.isOk ? Result.ok(result.value.data) : Result.err(toRepositoryError(result.error));
    }

    /**
     * "Restore": a new head version (`kind: restore`, parent = the current head, `If-Match` it)
     * with the content of `version` — history is never rewritten, the previous head stays. The
     * content is referenced, not uploaded again: the same manifest, blobs and thumbnail. When
     * another save moves the head in between, the restore goes on top of that one instead.
     */
    async restoreVersion(
        id: string,
        version: CloudVersion,
    ): Promise<Result<RestoredVersion, DocumentRepositoryError>> {
        if (!this.isOwnersSession()) return Result.err({ kind: "unauthorized" });
        if (this.isReadOnly(id)) return Result.err({ kind: "readOnly" });
        let onTopOf: RestoredVersion["onTopOf"];
        let blobs: string[];
        try {
            blobs = manifestBlobRefs(await this.manifest(version));
        } catch (error) {
            return Result.err(failureOf(error));
        }
        let head = await this.headVersion(id);
        const key = newIdempotencyKey();
        for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
            if (!head.isOk) return Result.err(head.error);
            const base = head.value;
            if (!base) return Result.err({ kind: "notFound", id });
            const body: NewVersionRequest = {
                parentIds: [base],
                kind: "restore",
                label: null,
                manifestSha256: version.manifestSha256,
                blobs,
                thumbnailSha256: version.thumbnailSha256,
                formatVersion: Number(version.formatVersion) || DOCUMENT_FORMAT_VERSION,
                deviceName: this.account.deviceSettings.effectiveDeviceName,
                clientId: this.clientId,
            };
            const result = await this.account.call((api) =>
                api.POST("/api/documents/{id}/versions", {
                    params: {
                        path: { id },
                        header: { "If-Match": ifMatch(base), "Idempotency-Key": `${key}-${attempt}` },
                    },
                    body,
                }),
            );
            if (result.isOk) {
                if (version.thumbnailSha256) this.thumbnailShas.set(id, version.thumbnailSha256);
                const restored: RestoredVersion = { version: result.value.data };
                if (onTopOf) restored.onTopOf = onTopOf;
                return Result.ok(restored);
            }
            const error = result.error;
            if (problemCode(error) !== "version_conflict" || error.kind !== "problem") {
                return Result.err(toRepositoryError(error, id));
            }
            onTopOf = {};
            if (error.problem.headDeviceName) onTopOf.deviceName = error.problem.headDeviceName;
            if (error.problem.headCreatedAt) onTopOf.createdAt = parseUtc(error.problem.headCreatedAt);
            const next = error.problem.headVersionId;
            head = next ? Result.ok(next) : await this.headVersion(id);
        }
        return Result.err({ kind: "failed", message: I18n.translate("cloud.history.restoreBusy") });
    }

    /** Removes the cached copies of cloud documents from this device. */
    async clearCache(): Promise<void> {
        this.thumbnailUrls.clear();
        await this.cache.clear();
    }
}
