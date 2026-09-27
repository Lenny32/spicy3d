// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The part of IndexedDB the cloud cache and the sync store use (happy-dom has none): `open` with
 * an upgrade, one object store per name with out-of-line keys, `get` / `put` / `delete` / `clear`
 * / `getAll` / `getAllKeys`. Values are structured-cloned in and out, like the real thing, so a
 * second "session" over the same factory sees what the first wrote (a reload). Requests succeed on
 * a microtask. `failWrites` makes every write fail (a full disk).
 */
class FakeRequest<T> {
    result!: T;
    error: unknown = null;
    onsuccess: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onupgradeneeded: (() => void) | null = null;

    succeed(value: T) {
        this.result = value;
        queueMicrotask(() => this.onsuccess?.());
    }

    fail(error: unknown) {
        this.error = error;
        queueMicrotask(() => this.onerror?.());
    }
}

class FakeStore {
    constructor(
        readonly records: Map<string, unknown>,
        private readonly factory: FakeIndexedDbFactory,
    ) {}

    private run<T>(write: boolean, work: () => T): FakeRequest<T> {
        const request = new FakeRequest<T>();
        if (write && this.factory.failWrites) {
            request.fail(Object.assign(new Error("quota"), { name: "QuotaExceededError" }));
        } else {
            request.succeed(work());
        }
        return request;
    }

    get(key: string) {
        return this.run(false, () => structuredClone(this.records.get(key)));
    }

    put(value: unknown, key: string) {
        return this.run(true, () => {
            this.records.set(key, structuredClone(value));
            return key;
        });
    }

    delete(key: string) {
        return this.run(true, () => {
            this.records.delete(key);
            return undefined;
        });
    }

    clear() {
        return this.run(true, () => {
            this.records.clear();
            return undefined;
        });
    }

    getAll() {
        return this.run(false, () => [...this.records.values()].map((x) => structuredClone(x)));
    }

    getAllKeys() {
        return this.run(false, () => [...this.records.keys()]);
    }
}

class FakeDatabase {
    readonly stores = new Map<string, Map<string, unknown>>();
    version = 0;
    onversionchange: (() => void) | null = null;
    readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };

    constructor(private readonly factory: FakeIndexedDbFactory) {}

    createObjectStore(name: string) {
        this.stores.set(name, new Map());
    }

    transaction(names: string | string[], _mode?: string) {
        const wanted = typeof names === "string" ? [names] : names;
        return {
            objectStore: (name: string) => {
                const records = this.stores.get(name);
                if (!records || !wanted.includes(name)) throw new Error(`no object store ${name}`);
                return new FakeStore(records, this.factory);
            },
        };
    }

    close() {}
}

export class FakeIndexedDbFactory {
    readonly databases = new Map<string, FakeDatabase>();
    failWrites = false;
    opens = 0;

    open(name: string, version = 1) {
        this.opens++;
        const request = new FakeRequest<FakeDatabase>();
        queueMicrotask(() => {
            let db = this.databases.get(name);
            if (!db) {
                db = new FakeDatabase(this);
                this.databases.set(name, db);
            }
            request.result = db;
            if (version > db.version) {
                db.version = version;
                request.onupgradeneeded?.();
            }
            request.onsuccess?.();
        });
        return request;
    }

    /** The records of one store, e.g. to inspect or damage them. */
    store(database: string, store: string): Map<string, unknown> | undefined {
        return this.databases.get(database)?.stores.get(store);
    }

    asFactory(): IDBFactory {
        return this as unknown as IDBFactory;
    }
}
