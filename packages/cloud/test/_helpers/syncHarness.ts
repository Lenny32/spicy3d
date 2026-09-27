// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CloseDocumentOptions,
    DocumentMigrations,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    ObjectStorage,
    PubSub,
    Result,
    type SaveKind,
    type Serialized,
    UserActivity,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { Account } from "../../src/account/account";
import { CloudDeviceSettings } from "../../src/account/deviceSettings";
import { CloudClient } from "../../src/client";
import { CloudConnection } from "../../src/cloud";
import { type IBlobCache, MemoryBlobCache } from "../../src/documents/blobCache";
import { CloudDocuments } from "../../src/documents/cloudDocuments";
import { EditLocks, type LockManagerLike } from "../../src/documents/editLocks";
import type { CloudDocumentRepository } from "../../src/documents/repository";
import { EventsChannel, type SocketLike } from "../../src/sync/events";
import type { SyncEngine, SyncEngineOptions } from "../../src/sync/syncEngine";
import { type ISyncStore, MemorySyncStore } from "../../src/sync/syncStore";
import { CONFIG, type FakeDocumentServer } from "./fakeDocumentServer";
import { BASE, type FakeServer, json, USER } from "./fakeServer";

/** A seeded PRNG (mulberry32): the fault injection is the same on every run. */
export function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (real time) until `condition` holds; fails with `what` after `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<number> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
    return Date.now() - start;
}

export interface FaultRates {
    /** The request never reaches the server (connection refused, DNS…). */
    drop?: number;
    /** The server handles the request, but the answer is lost (the connection dies). */
    loseAnswer?: number;
    /** The request reaches the server twice (a proxy retrying); the client gets one answer. */
    duplicate?: number;
    /** The request hangs, then fails (a timeout), without reaching the server. */
    timeout?: number;
}

/**
 * The network between a client and the fake server: `down` refuses everything (server stopped,
 * cable out), `faults` inject failures with a seeded PRNG.
 */
export class FlakyNetwork {
    down = false;
    faults: FaultRates = {};
    readonly injected = { drop: 0, loseAnswer: 0, duplicate: 0, timeout: 0, refused: 0 };

    constructor(
        readonly server: FakeServer,
        readonly random: () => number = seeded(1),
    ) {}

    /** One-shot: the next request matching loses its answer (it still reaches the server). */
    loseAnswerOnce(matches: (request: Request) => boolean, thenDown = false) {
        this.once.push({ matches, thenDown });
    }

    private readonly once: { matches: (request: Request) => boolean; thenDown: boolean }[] = [];

    readonly fetch = async (request: Request): Promise<Response> => {
        if (this.down) {
            this.injected.refused++;
            throw new TypeError("Failed to fetch");
        }
        const scripted = this.once.findIndex((x) => x.matches(request));
        if (scripted >= 0) {
            const [{ thenDown }] = this.once.splice(scripted, 1);
            this.injected.loseAnswer++;
            await this.server.fetch(request);
            // The network goes with the answer (nothing retried before the test says so).
            if (thenDown) this.down = true;
            throw new TypeError("connection reset");
        }
        const roll = this.random();
        const { drop = 0, loseAnswer = 0, duplicate = 0, timeout = 0 } = this.faults;
        if (roll < drop) {
            this.injected.drop++;
            throw new TypeError("Failed to fetch");
        }
        if (roll < drop + timeout) {
            this.injected.timeout++;
            await sleep(20);
            throw new TypeError("network timeout");
        }
        if (roll < drop + timeout + duplicate) {
            this.injected.duplicate++;
            const copy = request.clone();
            await this.server.fetch(copy);
            return this.server.fetch(request);
        }
        if (roll < drop + timeout + duplicate + loseAnswer) {
            this.injected.loseAnswer++;
            await this.server.fetch(request);
            throw new TypeError("connection reset");
        }
        return this.server.fetch(request);
    };
}

/** A WebSocket to the fake events endpoint. */
export class FakeSocket implements SocketLike {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    closed = false;

    constructor(
        readonly url: string,
        private readonly hub: FakeEventsServer,
    ) {}

    close(code = 1000) {
        if (this.closed) return;
        this.closed = true;
        this.hub.sockets.delete(this);
        queueMicrotask(() => this.onclose?.({ code, reason: "" }));
    }

    /** The server ends the connection (`1006`: the network went away). */
    drop(code = 1006) {
        this.close(code);
    }

    deliver(message: unknown) {
        if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
    }
}

/**
 * SRV-07's `/ws/events` for the fake server: every new head is published as `document.updated`
 * with the saving client's id. `up = false` refuses connections; `dropRate` / `duplicateRate`
 * lose or repeat messages (events are hints).
 */
export class FakeEventsServer {
    readonly sockets = new Set<FakeSocket>();
    readonly urls: string[] = [];
    up = true;
    dropRate = 0;
    duplicateRate = 0;

    constructor(
        docs: FakeDocumentServer,
        public random: () => number = seeded(7),
    ) {
        docs.headListeners.add((documentId, version) =>
            this.publish({
                type: "document.updated",
                documentId,
                headVersionId: version.id,
                kind: version.kind,
                clientId: version.clientId,
                at: version.createdAt,
            }),
        );
    }

    readonly createSocket = (url: string): SocketLike => {
        this.urls.push(url);
        const socket = new FakeSocket(url, this);
        queueMicrotask(() => {
            if (!this.up) {
                socket.drop();
                return;
            }
            this.sockets.add(socket);
            socket.onopen?.({});
        });
        return socket;
    };

    publish(message: unknown) {
        for (const socket of [...this.sockets]) {
            if (this.random() < this.dropRate) continue;
            socket.deliver(message);
            if (this.random() < this.duplicateRate) socket.deliver(message);
        }
    }

    dropAll() {
        for (const socket of [...this.sockets]) socket.drop();
    }
}

type Listener = (property: keyof IDocument) => void;

/**
 * An open document as the sync sees it, with `Document`'s save rules: one save at a time, the undo
 * position serialized is the one saved (edits made while saving stay unsaved), `replaceContent`
 * one undo step. Its content is the serialized document; edits change its variables.
 */
export class SyncDoc {
    version?: string;
    private content: Serialized;
    private position = 0;
    private savedPosition = 0;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<Listener>();
    readonly replaced: string[] = [];
    closedWith?: CloseDocumentOptions;
    /** The undo position, as `History.position()` gives it (compared by identity). */
    readonly history = { position: () => this.position as unknown as object };

    constructor(
        readonly application: IApplication,
        data: Serialized,
        public repository: IDocumentRepository,
        version?: string,
    ) {
        this.content = structuredClone(data);
        this.version = version;
        application.documents.add(this as unknown as IDocument);
        PubSub.default.pub("documentOpened", this as unknown as IDocument);
    }

    get id(): string {
        return this.content["id"];
    }

    get name(): string {
        return this.content["name"];
    }
    set name(value: string) {
        this.content["name"] = value;
    }

    get isDirty(): boolean {
        return this.position !== this.savedPosition;
    }

    get undoSteps(): number {
        return this.position;
    }

    /** The variables, `id → expression`. */
    get values(): Record<string, string> {
        return valuesOf(this.content);
    }

    edit(id: string, expression: string) {
        const variables = this.content["variables"] as { id: string; expression: string }[];
        const existing = variables.find((x) => x.id === id);
        if (existing) existing.expression = expression;
        else variables.push({ id, name: id, expression, type: "length" } as never);
        this.moved();
    }

    serialize(): Serialized {
        return structuredClone(this.content);
    }

    replaceContent(data: Serialized, name: string) {
        const migrated = DocumentMigrations.migrate(data);
        if (!migrated.isOk) return Result.err(migrated.error);
        this.content = structuredClone(migrated.value);
        this.replaced.push(name);
        this.moved();
        return Result.ok(undefined);
    }

    markSaved(position: number = this.position) {
        this.savedPosition = position;
        this.notify();
    }

    save(kind: SaveKind = "manual") {
        const run = this.queue.then(() => this.saveNow(kind));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async saveNow(kind: SaveKind) {
        const position = this.position;
        const result = await this.repository.save({
            id: this.id,
            name: this.name,
            data: this.serialize(),
            kind,
            baseVersion: this.version,
        });
        if (result.isOk && result.value.status === "saved") {
            this.version = result.value.version ?? this.version;
            this.savedPosition = position;
            this.notify();
        }
        return result;
    }

    async settled() {
        await this.queue;
    }

    async close(options: CloseDocumentOptions = {}) {
        this.closedWith = options;
        this.application.documents.delete(this as unknown as IDocument);
        PubSub.default.pub("documentClosed", this as unknown as IDocument);
        return true;
    }

    onPropertyChanged(listener: Listener) {
        this.listeners.add(listener);
    }

    removePropertyChanged(listener: Listener) {
        this.listeners.delete(listener);
    }

    dispose() {}

    private moved() {
        this.position++;
        this.notify();
    }

    private notify() {
        for (const listener of [...this.listeners]) listener("isDirty");
    }
}

export function valuesOf(data: Serialized): Record<string, string> {
    return Object.fromEntries(
        (data["variables"] as { id: string; expression: string }[]).map((x) => [x.id, x.expression]),
    );
}

/** A small document whose content is its variables (merged by id, CLOUD-12). */
export function documentData(
    id: string,
    values: Record<string, string>,
    name = "Bracket",
    nodes: Serialized[] = [],
): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: {},
        id,
        name,
        models: { components: [], nodes, materials: [] },
        variables: Object.entries(values).map(([key, expression]) => ({
            id: key,
            name: key,
            expression,
            type: "length",
        })),
        settings: {},
        acts: [],
        userData: {},
    };
}

export interface DeviceOptions {
    store?: ISyncStore;
    cache?: IBlobCache;
    deviceName?: string;
    /** Refreshes the session at the start (default true; `false`: starts from the cached user). */
    refresh?: boolean;
    activity?: UserActivity;
    settings?: CloudDeviceSettings;
    locks?: EditLocks;
    /** More sync engine options (an evaluator, the cache cap…). */
    sync?: Partial<SyncEngineOptions>;
}

/**
 * One browser tab signed in to the fake server through its own {@link FlakyNetwork} and events
 * socket, with the real cloud documents module and sync engine (short backoff for tests).
 */
export class Device {
    readonly app: IApplication;
    readonly account: Account;
    readonly documents: CloudDocuments;
    readonly toasts: [string, unknown[]][] = [];
    readonly store: ISyncStore;
    readonly cache: IBlobCache;
    private readonly onToast = (key: string, ...args: unknown[]) => void this.toasts.push([key, args]);

    private constructor(
        readonly network: FlakyNetwork,
        readonly events: FakeEventsServer,
        options: DeviceOptions,
        account: Account,
    ) {
        this.account = account;
        this.app = createMockApplication();
        this.app.openDocument = async (id: string, repository?: IDocumentRepository) => {
            const target = repository ?? this.app.repositories.local;
            const loaded = await target.load(id);
            if (!loaded.isOk) return undefined;
            return new SyncDoc(
                this.app,
                loaded.value.data,
                target,
                loaded.value.version,
            ) as unknown as IDocument;
        };
        this.store = options.store ?? new MemorySyncStore();
        this.cache = options.cache ?? new MemoryBlobCache();
        const connection = new CloudConnection(CONFIG, account.client);
        (connection as { account: Account }).account = account;
        PubSub.default.sub("showToast", this.onToast);
        this.documents = new CloudDocuments(connection, this.app, {
            cache: this.cache,
            store: this.store,
            locks: options.locks ?? new EditLocks(undefined, undefined),
            titleBar: false,
            // Each tab its own client id (events of the other tabs are not its own).
            repository: { encodeThumbnail: async () => undefined, clientId: crypto.randomUUID() },
            events: new EventsChannel({
                url: CONFIG.eventsSocket,
                baseUrl: BASE,
                account,
                createSocket: events.createSocket,
                heartbeatMs: 60_000,
                initialDelayMs: 5,
                maxDelayMs: 40,
            }),
            sync: {
                initialDelayMs: 5,
                maxDelayMs: 40,
                pushTimeoutMs: 500,
                idleCheckMs: 10,
                pullDelayMs: 10,
                requestPersistence: async () => true,
                activity: options.activity ?? new UserActivity({ isDialogOpen: () => false }),
                ...options.sync,
            },
        });
    }

    static async start(
        server: FakeServer,
        events: FakeEventsServer,
        network: FlakyNetwork = new FlakyNetwork(server),
        options: DeviceOptions = {},
    ): Promise<Device> {
        server.on("GET /api/me", json(200, USER));
        const settings =
            options.settings ??
            new CloudDeviceSettings(new ObjectStorage("spicy3d-test", String(Math.random())));
        if (options.deviceName) settings.deviceName = options.deviceName;
        const account = new Account(new CloudClient({ baseUrl: BASE, fetch: network.fetch }), settings);
        await account.refresh();
        return new Device(network, events, options, account);
    }

    get repository(): CloudDocumentRepository {
        return this.documents.cloud!;
    }

    get engine(): SyncEngine {
        return this.documents.syncEngine!;
    }

    /** Opens a cloud document through the repository (as the home page does). */
    async open(id: string): Promise<SyncDoc> {
        const document = await this.app.openDocument(id, this.repository);
        if (!document) throw new Error(`cannot open ${id}`);
        await this.engine.settle();
        return document as unknown as SyncDoc;
    }

    /** A new document saved to the cloud from this device (created by its first push). */
    async create(id: string, values: Record<string, string>, nodes: Serialized[] = []): Promise<SyncDoc> {
        const document = new SyncDoc(this.app, documentData(id, values, "Bracket", nodes), this.repository);
        await document.save("manual");
        await this.engine.settle();
        return document;
    }

    toasted(key: string): unknown[][] {
        return this.toasts.filter(([k]) => k === key).map(([, args]) => args);
    }

    dispose() {
        PubSub.default.remove("showToast", this.onToast);
        this.documents.dispose();
    }
}

/** Web Locks shared by the "tabs" of one browser: exclusive, `ifAvailable` only. */
export class SharedLocks implements LockManagerLike {
    readonly held = new Set<string>();

    request(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: unknown) => Promise<void> | void,
    ): Promise<unknown> {
        if (this.held.has(name)) {
            if (options.ifAvailable) return Promise.resolve(callback(null));
            return Promise.reject(new DOMException("unsupported in this fake", "NotSupportedError"));
        }
        this.held.add(name);
        return Promise.resolve(callback({ name })).finally(() => this.held.delete(name));
    }
}
