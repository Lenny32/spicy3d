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
 * one runs. `idle` = not saved (nor failed) since it was opened. With the offline sync (CLOUD-10):
 * `pending` = saved on this device, waiting to be pushed; `offline` = the same, the server out of
 * reach; `merging` = the head moved meanwhile and the sync merges; `remotePending` = a newer
 * version from another device waits until the user is done (a command, a drag); `conflict` = a
 * merge needs the user.
 */
export type CloudSaveState =
    | "idle"
    | "saving"
    | "saved"
    | "pending"
    | "offline"
    | "merging"
    | "remotePending"
    | "conflict"
    | "error";

/** A save as a manifest and its blobs (see {@link CloudDocumentRepository.prepare}). */
export interface PreparedSave {
    manifestSha256: string;
    blobs: string[];
    thumbnailSha256?: string;
    formatVersion: number;
    /** The manifest, the blobs and the thumbnail, by hash. */
    bytes: Map<string, Uint8Array>;
}

/** A version to push whose content is known by hash (see {@link CloudDocumentRepository.push}). */
export interface PushRequest {
    id: string;
    name: string;
    /** The head it is based on (`If-Match`); `undefined` creates the document. */
    baseVersion?: string;
    /** A merge's second parent (this device's line); ignored unless `kind` is `merge`. */
    mergeParent?: string;
    kind: SaveRequest["kind"];
    label?: string;
    manifestSha256: string;
    blobs: string[];
    thumbnailSha256?: string;
    formatVersion: number;
    /** The same for every retry of this push. */
    idempotencyKey: string;
    /** Sent as is when given (a retry resends the first attempt's), else this tab's. */
    clientId?: string;
    deviceName?: string;
    /** The bytes of a hash the server lacks. */
    bytes: (sha256: string) => Promise<Uint8Array | undefined>;
}

export type PushOutcome = { status: "saved"; version: CloudVersion } | SaveConflict;

export interface PushFailure {
    error: DocumentRepositoryError;
    /** Offline, 5xx, 429, a session to renew: the same push may work later. */
    retryable: boolean;
    /** The server's `Retry-After`. */
    retryAfterMs?: number;
    /** The server's problem code, if it answered one. */
    code?: string;
}

function isRetryableFailure(error: DocumentRepositoryError): boolean {
    return error.kind === "offline" || error.kind === "unauthorized";
}

/** A document's head as the server has it, with its content. */
export interface LoadedHead {
    name: string;
    head: CloudVersion;
    data: Serialized;
    /** Blob references from the manifest already parsed while loading. */
    blobs: string[];
}

/**
 * The offline sync (CLOUD-10), attached while signed in: saves land on this device first and are
 * pushed in the background, opening falls back to this device's copy, the listing too when offline.
 */
export interface IRepositorySync {
    save(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>>;
    load(id: string, useCache?: boolean): Promise<Result<LoadedDocument, DocumentRepositoryError>>;
    /** The documents this device has copies of (the listing while offline), matching `search`. */
    offlineList(search?: string): Promise<DocumentMeta[]>;
    /** Marks the listed documents that have changes this device hasn't pushed. */
    annotate(items: DocumentMeta[]): Promise<void>;
    /** A conflict the sync can't merge on its own, for the MVP dialog. */
    conflictOf(id: string): SaveConflict | undefined;
    /**
     * Pushes the document's pending save now; `ok` once the server has everything this device
     * saved (e.g. before a restore, which would otherwise be merged with it afterwards).
     */
    flush(id: string): Promise<Result<void, DocumentRepositoryError | { kind: "conflict" }>>;
}

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

/** Offline, 5xx, 429 or a session to renew (retrying may work), not an answer given for good. */
export function isRetryableCloudError(error: CloudError): boolean {
    return !isFinal(error);
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
    private readonly freshHeads = new Set<string>();
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

    /** The offline sync, while attached. */
    get sync(): IRepositorySync | undefined {
        return this.syncEngine;
    }

    private syncEngine?: IRepositorySync;

    attachSync(sync: IRepositorySync | undefined): void {
        this.syncEngine = sync;
    }

    /** The sync reports the state of the documents it handles. */
    reportState(id: string, state: CloudSaveState): void {
        this.setState(id, state);
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
        if (this.stateOf(id) !== "conflict") return undefined;
        return this.syncEngine?.conflictOf(id) ?? this.conflicts.get(id);
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
        if (!result.isOk) {
            const error = toRepositoryError(result.error);
            // Offline: the documents this device has copies of.
            if (error.kind === "offline" && this.syncEngine && !trash && !cursor) {
                return Result.ok({ items: await this.syncEngine.offlineList(q) });
            }
            return Result.err(error);
        }
        const { items, nextCursor } = result.value.data;
        const page: DocumentPage = { items: items.map((x) => this.toMeta(x)) };
        if (nextCursor) page.nextCursor = nextCursor;
        if (!trash) await this.syncEngine?.annotate(page.items);
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

    /** A document's thumbnail as this device has it (a pending save's), for the offline listing. */
    rememberThumbnail(id: string, sha: string): void {
        this.thumbnailShas.set(id, sha);
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
        const useCache = !this.freshHeads.delete(id);
        if (this.syncEngine) return this.syncEngine.load(id, useCache);
        const loaded = await this.loadHead(id);
        return loaded.isOk
            ? Result.ok({ data: loaded.value.data, version: loaded.value.head.id })
            : Result.err(loaded.error);
    }

    /** An explicit restore or "Open latest" must read the head on its next opening. */
    loadFreshOnNextOpen(id: string): void {
        this.freshHeads.add(id);
    }

    /** The head of a document and its content (named as the server names the document). */
    async loadHead(id: string): Promise<Result<LoadedHead, DocumentRepositoryError>> {
        const head = await this.fetchHead(id);
        if (!head.isOk) return Result.err(head.error);
        const { version, name } = head.value;
        if (!version) return Result.err({ kind: "notFound", id });
        const manifest = await this.manifestOf(version);
        if (!manifest.isOk) return Result.err(manifest.error);
        const data = await this.assemble(manifest.value.manifest);
        // Renames are metadata only: the server's name is the document's name.
        return data.isOk
            ? Result.ok({ name, head: version, data: { ...data.value, name }, blobs: manifest.value.blobs })
            : Result.err(data.error);
    }

    /** `GET /api/documents/{id}`: the head version (`undefined` for none), name and trash state. */
    async fetchHead(
        id: string,
    ): Promise<Result<{ version?: CloudVersion; name: string; trashed: boolean }, DocumentRepositoryError>> {
        const document = await this.account.call((api) =>
            api.GET("/api/documents/{id}", { params: { path: { id } } }),
        );
        if (!document.isOk) return Result.err(toRepositoryError(document.error, id));
        const { head, name, deletedAt } = document.value.data;
        this.serverNames.set(id, name);
        if (head?.thumbnailSha256) this.thumbnailShas.set(id, head.thumbnailSha256);
        return Result.ok({ version: head ?? undefined, name, trashed: Boolean(deletedAt) });
    }

    /** The manifest of a version (cached), with the blobs it references. */
    async manifestOf(
        version: Pick<CloudVersion, "id" | "manifestSha256">,
    ): Promise<Result<{ manifest: unknown; blobs: string[] }, DocumentRepositoryError>> {
        try {
            const manifest = await this.manifest(version);
            return Result.ok({ manifest, blobs: manifestBlobRefs(manifest) });
        } catch (error) {
            return Result.err(failureOf(error));
        }
    }

    /** A manifest assembled with its blobs; `cachedOnly` refuses misses without a network request. */
    async assemble(
        manifest: unknown,
        cachedOnly = false,
    ): Promise<Result<Serialized, DocumentRepositoryError>> {
        try {
            const blobs = new Map<string, Uint8Array>();
            await mapLimit(manifestBlobRefs(manifest), TRANSFER_CONCURRENCY, async (sha) => {
                blobs.set(sha, await this.blob(sha, undefined, cachedOnly));
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

    /** The serialized document a version holds: its manifest, assembled with its blobs (cached). */
    private async content(
        version: Pick<CloudVersion, "id" | "manifestSha256">,
    ): Promise<Result<Serialized, DocumentRepositoryError>> {
        let manifest: unknown;
        try {
            manifest = await this.manifest(version);
        } catch (error) {
            return Result.err(failureOf(error));
        }
        return this.assemble(manifest);
    }

    /** A version's manifest (JSON), from the cache or `GET /api/versions/{id}`. Throws. */
    private async manifest(version: Pick<CloudVersion, "id" | "manifestSha256">): Promise<unknown> {
        return JSON.parse(decoder.decode(await this.blob(version.manifestSha256, version.id)));
    }

    /**
     * A blob from the cache, else from the server (a manifest from its version: `versionId`),
     * checked against its hash and cached. Throws a {@link RepositoryFailure}.
     */
    private async blob(sha: string, versionId?: string, cachedOnly = false): Promise<Uint8Array> {
        const cached = await this.cache.get(sha);
        if (cached) return cached;
        if (cachedOnly) throw new RepositoryFailure({ kind: "failed", message: "incomplete cached version" });
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
        // Local-first: the sync writes the save to this device, then pushes it when it can.
        if (this.sync) return this.sync.save(request);
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

    /**
     * A save as a manifest and its blobs: the manifest bytes, their hash, the blobs, the thumbnail.
     * Refuses a manifest over the server's limit.
     */
    async prepare(
        data: Serialized,
        thumbnailUrl?: string,
    ): Promise<Result<PreparedSave, DocumentRepositoryError>> {
        const split = await splitManifest(data, this.options.split);
        const manifestBytes = encoder.encode(JSON.stringify(split.manifest));
        if (manifestBytes.byteLength > this.options.config.storage.maxManifestBytes) {
            return Result.err({
                kind: "failed",
                message: I18n.translate(fieldErrorMessageKey("manifest_too_large")),
            });
        }
        const manifestSha256 = await sha256Hex(manifestBytes);
        const thumbnail = thumbnailUrl ? await this.encodeThumbnail(thumbnailUrl) : undefined;
        const thumbnailSha256 = thumbnail ? await sha256Hex(thumbnail) : undefined;
        const bytes = new Map<string, Uint8Array>([[manifestSha256, manifestBytes], ...split.blobs]);
        if (thumbnail && thumbnailSha256) bytes.set(thumbnailSha256, thumbnail);
        return Result.ok({
            manifestSha256,
            blobs: [...split.blobs.keys()],
            thumbnailSha256,
            formatVersion: Number(data["formatVersion"]) || DOCUMENT_FORMAT_VERSION,
            bytes,
        });
    }

    private async saveVersion(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const { id, baseVersion } = request;
        const prepared = await this.prepare(request.data, request.thumbnail);
        if (!prepared.isOk) return Result.err(prepared.error);
        const { manifestSha256, thumbnailSha256, bytes } = prepared.value;
        const pendingKey = [id, baseVersion, manifestSha256, request.kind, request.label, thumbnailSha256]
            .map((x) => x ?? "")
            .join("|");
        const key = this.pendingKeys.get(pendingKey) ?? newIdempotencyKey();
        this.pendingKeys.set(pendingKey, key);
        const pushed = await this.push({
            id,
            name: request.name,
            baseVersion,
            kind: request.kind,
            label: request.label,
            manifestSha256,
            blobs: prepared.value.blobs,
            thumbnailSha256,
            formatVersion: prepared.value.formatVersion,
            idempotencyKey: key,
            bytes: async (sha) => bytes.get(sha),
        });
        if (!pushed.isOk) {
            if (!pushed.error.retryable) this.pendingKeys.delete(pendingKey);
            return Result.err(pushed.error.error);
        }
        this.pendingKeys.delete(pendingKey);
        if (pushed.value.status === "conflict") return Result.ok(pushed.value);
        // The server keeps every blob of the version now: cache them for the next load.
        await Promise.all([...bytes].map(([sha, blob]) => this.cache.put(sha, blob)));
        const head = pushed.value.version;
        return Result.ok({ status: "saved", updatedAt: parseUtc(head.createdAt), version: head.id });
    }

    /**
     * Pushes a version whose manifest and blobs are known: `POST /api/blobs/check`, uploads of the
     * missing ones (read through `bytes`), then the create (no `baseVersion`) or a new version on
     * top of `baseVersion` (`If-Match`), with `Idempotency-Key`. A stale base (or a create of an id
     * that exists) answers `conflict` with the head. Renames the document when `name` differs from
     * the server's. Never throws.
     */
    async push(request: PushRequest): Promise<Result<PushOutcome, PushFailure>> {
        try {
            return await this.pushOnce(request);
        } catch (error) {
            const failure = failureOf(error);
            return Result.err({ error: failure, retryable: isRetryableFailure(failure) });
        }
    }

    private async pushOnce(request: PushRequest): Promise<Result<PushOutcome, PushFailure>> {
        const { id, baseVersion, manifestSha256, thumbnailSha256 } = request;
        const referenced = [manifestSha256, ...request.blobs];
        if (thumbnailSha256) referenced.push(thumbnailSha256);
        const unique = [...new Set(referenced)];
        await this.upload(request.bytes, await this.missing(unique));

        const parentIds = baseVersion
            ? request.kind === "merge" && request.mergeParent && request.mergeParent !== baseVersion
                ? [baseVersion, request.mergeParent]
                : [baseVersion]
            : null;
        const version: NewVersionRequest = {
            parentIds,
            // A merge whose second parent is gone (or the same) is an ordinary save of its content.
            kind: request.kind === "merge" && parentIds?.length !== 2 ? "auto" : request.kind,
            label: request.label ?? null,
            manifestSha256,
            blobs: [...new Set(request.blobs)],
            thumbnailSha256: thumbnailSha256 ?? null,
            formatVersion: request.formatVersion,
            deviceName: request.deviceName ?? this.account.deviceSettings.effectiveDeviceName,
            clientId: request.clientId ?? this.clientId,
        };
        const key = request.idempotencyKey;
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
                          if (r.value.replayed && head.manifestSha256 !== manifestSha256) {
                              return Result.err(replayedConflict(head));
                          }
                          return Result.ok(head);
                      });

        let answer = await send();
        if (!answer.isOk && problemCode(answer.error) === "blobs_missing") {
            // Garbage collected between the check and the save: upload them and retry once.
            const missing = answer.error.kind === "problem" ? (answer.error.problem.missing ?? []) : [];
            await this.upload(request.bytes, missing);
            answer = await send();
        }
        if (!answer.isOk) {
            const outcome = await this.saveFailure(id, answer.error);
            if (outcome.isOk) return Result.ok(outcome.value as SaveConflict);
            return Result.err({
                error: outcome.error,
                retryable: !isFinal(answer.error),
                retryAfterMs:
                    answer.error.kind === "problem" && answer.error.retryAfterSeconds !== undefined
                        ? answer.error.retryAfterSeconds * 1000
                        : undefined,
                code: problemCode(answer.error),
            });
        }
        if (thumbnailSha256) this.thumbnailShas.set(id, thumbnailSha256);
        if (!baseVersion) this.serverNames.set(id, request.name);
        await this.renameIfNeeded(id, request.name);
        return Result.ok({ status: "saved", version: answer.value });
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
    private async upload(
        bytesOf: (sha: string) => Promise<Uint8Array | undefined>,
        missing: string[],
    ): Promise<void> {
        await mapLimit(missing, TRANSFER_CONCURRENCY, async (sha) => {
            const bytes = await bytesOf(sha);
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
    loadVersion(
        version: Pick<CloudVersion, "id" | "manifestSha256">,
    ): Promise<Result<Serialized, DocumentRepositoryError>> {
        if (!this.isOwnersSession()) return Promise.resolve(Result.err({ kind: "unauthorized" }));
        return this.content(version);
    }

    /** A complete cached version, without making any network requests; a miss is an error. */
    async loadCachedVersion(manifestSha256: string): Promise<Result<Serialized, DocumentRepositoryError>> {
        if (!this.isOwnersSession()) return Result.err({ kind: "unauthorized" });
        try {
            const bytes = await this.blob(manifestSha256, undefined, true);
            return this.assemble(JSON.parse(decoder.decode(bytes)), true);
        } catch (error) {
            return Result.err(failureOf(error));
        }
    }

    /**
     * A version's content by id alone (its manifest hash unknown here, e.g. the base of a save made
     * before the sync knew the document): `GET /api/versions/{id}`, then cached by its hash.
     */
    async loadVersionById(versionId: string): Promise<Result<Serialized, DocumentRepositoryError>> {
        const result = await this.account.call((api) =>
            api.GET("/api/versions/{versionId}", { params: { path: { versionId } }, parseAs: "arrayBuffer" }),
        );
        if (!result.isOk) return Result.err(toRepositoryError(result.error));
        const bytes = new Uint8Array(result.value.data as unknown as ArrayBuffer);
        let manifest: unknown;
        try {
            manifest = JSON.parse(decoder.decode(bytes));
        } catch (error) {
            return Result.err({ kind: "failed", message: String(error) });
        }
        await this.cache.put(await sha256Hex(bytes), bytes);
        return this.assemble(manifest);
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
                this.loadFreshOnNextOpen(id);
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
