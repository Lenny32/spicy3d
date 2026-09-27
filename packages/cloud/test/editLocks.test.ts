// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type ChannelLike, EditLocks, type LockManagerLike } from "../src/documents/editLocks";

interface Holder {
    release: () => void;
    reject: (error: unknown) => void;
}

/** Web Locks semantics the tabs rely on: exclusive, `ifAvailable`, waiting with a signal, `steal`. */
class FakeLockManager implements LockManagerLike {
    private readonly holders = new Map<string, Holder>();
    private readonly waiting = new Map<string, (() => void)[]>();

    request(
        name: string,
        options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
        callback: (lock: unknown) => Promise<void> | void,
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const grant = () => {
                let release!: () => void;
                const held = new Promise<void>((r) => {
                    release = r;
                });
                this.holders.set(name, { release, reject });
                Promise.resolve(callback({ name })).then(() => {
                    if (this.holders.get(name)?.reject === reject) this.free(name);
                    resolve(undefined);
                });
                void held;
            };
            const holder = this.holders.get(name);
            if (!holder) return grant();
            if (options.steal) {
                this.holders.delete(name);
                holder.reject(new DOMException("stolen", "AbortError"));
                return grant();
            }
            if (options.ifAvailable) {
                Promise.resolve(callback(null)).then(resolve);
                return;
            }
            const queue = this.waiting.get(name) ?? [];
            queue.push(grant);
            this.waiting.set(name, queue);
            options.signal?.addEventListener("abort", () => {
                const index = queue.indexOf(grant);
                if (index >= 0) queue.splice(index, 1);
                reject(new DOMException("aborted", "AbortError"));
            });
        });
    }

    private free(name: string) {
        this.holders.delete(name);
        this.waiting.get(name)?.shift()?.();
    }

    isHeld(name: string) {
        return this.holders.has(name);
    }
}

/** A BroadcastChannel between tabs: a message reaches every other member. */
class FakeChannelHub {
    readonly members: FakeChannel[] = [];
    channel(): FakeChannel {
        const channel = new FakeChannel(this);
        this.members.push(channel);
        return channel;
    }
}

class FakeChannel implements ChannelLike {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(private readonly hub: FakeChannelHub) {}
    postMessage(message: unknown) {
        for (const other of this.hub.members) {
            if (other !== this) queueMicrotask(() => other.onmessage?.({ data: message } as MessageEvent));
        }
    }
    close() {}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function twoTabs() {
    const locks = new FakeLockManager();
    const hub = new FakeChannelHub();
    return { locks, first: new EditLocks(locks, hub.channel()), second: new EditLocks(locks, hub.channel()) };
}

describe("EditLocks", () => {
    test("the first tab edits, the second opens the same document read-only", async () => {
        const { first, second } = twoTabs();

        expect(await first.acquire("doc")).toBe("editing");
        expect(await second.acquire("doc")).toBe("readOnly");
        expect(first.isReadOnly("doc")).toBe(false);
        expect(second.isReadOnly("doc")).toBe(true);
        expect(await second.acquire("other")).toBe("editing");
    });

    test("closing lets the next tab edit", async () => {
        const { locks, first, second } = twoTabs();
        await first.acquire("doc");

        first.release("doc");
        await flush();

        expect(locks.isHeld("spicy3d.document.doc")).toBe(false);
        second.release("doc");
        expect(await second.acquire("doc")).toBe("editing");
    });

    test("edit here instead: the editing tab saves first, lets go and becomes read-only", async () => {
        const { first, second } = twoTabs();
        await first.acquire("doc");
        await second.acquire("doc");
        const saved = rs.fn(async (_id: string) => {});
        first.handoverHandler = saved;
        const modes: string[] = [];
        first.onChanged((id, mode) => modes.push(`${id}:${mode}`));

        const took = await second.takeOver("doc");

        expect(took).toBe(true);
        expect(saved).toHaveBeenCalledWith("doc");
        expect(second.isReadOnly("doc")).toBe(false);
        expect(first.isReadOnly("doc")).toBe(true);
        expect(modes).toEqual(["doc:readOnly"]);
    });

    test("a tab that doesn't answer has its lock stolen after the timeout", async () => {
        const locks = new FakeLockManager();
        const hub = new FakeChannelHub();
        const silent = new EditLocks(locks, undefined);
        const taker = new EditLocks(locks, hub.channel());
        await silent.acquire("doc");
        await taker.acquire("doc");

        const took = await taker.takeOver("doc", 10);
        await flush();

        expect(took).toBe(true);
        expect(taker.isReadOnly("doc")).toBe(false);
        expect(silent.isReadOnly("doc")).toBe(true);
    });

    test("without Web Locks every tab edits", async () => {
        const locks = new EditLocks(undefined, undefined);

        expect(await locks.acquire("doc")).toBe("editing");
        expect(await locks.takeOver("doc")).toBe(true);
        expect(locks.isReadOnly("doc")).toBe(false);
    });
});
