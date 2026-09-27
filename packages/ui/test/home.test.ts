// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    type DialogButton,
    type DocumentListQuery,
    type DocumentMeta,
    type DocumentPage,
    type DocumentRepositoryError,
    formatDateTime,
    formatRelative,
    type IApplication,
    PubSub,
    Result,
    type SaveRequest,
    type Serialized,
    type ToastAction,
} from "@spicy3d/core";
import { createMockApplication, MemoryDocumentRepository } from "@spicy3d/core/test-utils";
import { closeContextMenu } from "../src/contextMenu";
import { formatBytes, Home } from "../src/home/home";

const UPDATED_AT = Date.parse("2026-09-27T12:00:00Z");
const DELETED_AT = Date.parse("2026-09-20T08:00:00Z");

/** A cloud-like repository: sizes, a trash and restore. */
class TrashRepository extends MemoryDocumentRepository {
    readonly trash = new Map<string, SaveRequest>();
    readonly queries: DocumentListQuery[] = [];
    readonly trashRetentionDays = 30;
    /** What the offline sync reports per document (CLOUD-10). */
    readonly syncStates = new Map<string, DocumentMeta["syncState"]>();

    constructor() {
        super("cloud");
    }

    override async list(
        query: DocumentListQuery = {},
    ): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        this.queries.push(query);
        const page = await super.list(query);
        return Result.ok({
            items: page.value!.items.map((x) => ({
                ...x,
                updatedAt: UPDATED_AT,
                sizeBytes: 1_500_000,
                ...(this.syncStates.has(x.id) ? { syncState: this.syncStates.get(x.id) } : {}),
            })),
        });
    }

    async listTrash(): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        return Result.ok({
            items: [...this.trash.values()].map((x) => ({
                id: x.id,
                name: x.name,
                updatedAt: 0,
                location: "cloud" as const,
                deletedAt: DELETED_AT,
            })),
        });
    }

    override async delete(id: string) {
        const doc = this.documents.get(id);
        if (doc) this.trash.set(id, doc);
        return super.delete(id);
    }

    async restore(id: string) {
        const doc = this.trash.get(id);
        this.trash.delete(id);
        if (doc) this.documents.set(id, doc);
        return Result.ok(undefined);
    }
}

const data = (id: string, name: string) => ({ __cla$$__: "Document", id, name }) as unknown as Serialized;

async function add(repository: MemoryDocumentRepository, id: string, name: string) {
    await repository.save({ id, name, data: data(id, name), kind: "manual" });
}

let published: [string, unknown[]][];
let app: IApplication;
let local: MemoryDocumentRepository;
let home: Home;

beforeEach(async () => {
    published = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation((event: string, ...args: unknown[]) => {
        published.push([event, args]);
    });
    local = new MemoryDocumentRepository("local");
    app = createMockApplication({ localRepository: local });
    await add(local, "l1", "Bracket");
});

afterEach(() => {
    home?.remove();
    rs.restoreAllMocks();
});

async function render() {
    home = new Home(app);
    document.body.append(home);
    await home.render();
    return home;
}

const sections = () =>
    Array.from(home.querySelectorAll<HTMLElement>("[data-location]"), (s) => s.dataset["location"]);
const cards = (location: string) =>
    Array.from(home.querySelectorAll<HTMLElement>(`[data-location="${location}"] [data-id]`));
const buttonIn = (root: ParentNode, text: string) => {
    const found = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text);
    expect(found).toBeDefined();
    return found!;
};
const lastDialogButtons = () => {
    const dialog = published.filter(([event]) => event === "showDialog").at(-1);
    expect(dialog).toBeDefined();
    return dialog![1] as [string, HTMLElement, DialogButton[]];
};

describe("home without the cloud", () => {
    test("lists this device's documents only, without cloud actions", async () => {
        await render();

        expect(sections()).toEqual(["local"]);
        expect(cards("local").map((c) => c.dataset["id"])).toEqual(["l1"]);
        const texts = Array.from(home.querySelectorAll("button"), (b) => b.textContent);
        expect(texts).not.toContain("home.import.button");
        expect(texts).not.toContain("cloud.document.saveToCloud");
        expect(texts).toContain("cloud.document.download");
    });
});

describe("home with the cloud", () => {
    let cloud: TrashRepository;

    beforeEach(async () => {
        cloud = new TrashRepository();
        app.repositories.cloud = cloud;
        await add(cloud, "c1", "Gear");
    });

    test("shows a Cloud and a This device section; cloud cards have a badge, relative time and size", async () => {
        await render();

        expect(sections()).toEqual(["cloud", "local"]);
        const [card] = cards("cloud");
        expect(card.textContent).toContain("Gear");
        expect(card.textContent).toContain("home.badge.cloud");
        const time = card.querySelector<HTMLElement>("[data-relative-time]");
        expect(time).not.toBeNull();
        expect(time!.textContent).toBe(formatRelative(UPDATED_AT));
        expect(time!.title).toBe(formatDateTime(UPDATED_AT));
        expect(card.textContent).toContain(formatBytes(1_500_000));
        const [localCard] = cards("local");
        expect(localCard.textContent).not.toContain("home.badge.cloud");
        expect(localCard.querySelector("[data-relative-time]")).toBeNull();
    });

    test.each([
        ["pending", "home.sync.pending"],
        ["offline", "home.sync.pending"],
        ["conflict", "home.sync.conflict"],
    ] as const)("a document the sync reports %s has a badge", async (state, label) => {
        cloud.syncStates.set("c1", state);
        await render();

        const badge = cards("cloud")[0].querySelector<HTMLElement>("[data-sync]");
        expect(badge).not.toBeNull();
        expect(badge!.dataset["sync"]).toBe(state);
        expect(badge!.textContent).toBe(label);
    });

    test("a synced document has no sync badge", async () => {
        cloud.syncStates.set("c1", "synced");
        await render();

        expect(cards("cloud")[0].querySelector("[data-sync]")).toBeNull();
    });

    test("local documents keep their absolute date and time", async () => {
        await render();

        const meta = (await local.list()).value!.items[0];
        expect(cards("local")[0].textContent).toContain(formatDateTime(meta.updatedAt));
    });

    test("relative times refresh every minute while the home page shows", async () => {
        rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        try {
            await render();
            const time = cards("cloud")[0].querySelector<HTMLElement>("[data-relative-time]")!;
            time.textContent = "stale";

            rs.advanceTimersByTime(60_000);

            expect(time.textContent).toBe(formatRelative(UPDATED_AT));
        } finally {
            rs.useRealTimers();
        }
    });

    test("signing out while the home page shows removes the cloud section", async () => {
        await render();

        app.repositories.cloud = undefined;
        (home as unknown as { onRepositoriesChanged(p: string): void }).onRepositoriesChanged("cloud");

        await rs.waitFor(() => expect(sections()).toEqual(["local"]));
    });

    test("search filters by name", async () => {
        await render();
        const search = home.querySelector<HTMLInputElement>("input[type=search]");
        expect(search).not.toBeNull();

        search!.value = "gea";
        await home.refresh();

        expect(cloud.queries.at(-1)).toEqual({ cursor: undefined, search: "gea" });
        expect(cards("cloud")).toHaveLength(1);
        expect(cards("local")).toHaveLength(0);
        expect(home.textContent).toContain("home.search.empty");
    });

    test("delete moves to the trash after confirming, with an Undo toast that restores", async () => {
        rs.spyOn(window, "confirm").mockReturnValue(true);
        await render();

        buttonIn(cards("cloud")[0], "common.delete").click();
        await rs.waitFor(() => expect(cards("cloud")).toHaveLength(0));

        expect(window.confirm).toHaveBeenCalledWith(
            "prompt.trashDocument{0}{1}".replace("{0}", "Gear").replace("{1}", "30"),
        );
        expect(cloud.trash.has("c1")).toBe(true);
        const toast = published.find(([event]) => event === "showActionToast");
        expect(toast).toBeDefined();
        const action = toast![1][1] as ToastAction;
        expect(action.label).toBe("common.undo");

        action.run();

        await rs.waitFor(() => expect(cards("cloud")).toHaveLength(1));
        expect(cloud.trash.has("c1")).toBe(false);
    });

    test("the trash lists deleted documents, which can be restored", async () => {
        await cloud.delete("c1");
        await render();

        buttonIn(home, "home.trash.button").click();
        await rs.waitFor(() => expect(sections()).toEqual(["trash"]));
        expect(home.textContent).toContain("home.trash.retention30");
        const deleted = cards("trash")[0].querySelector<HTMLElement>("[data-relative-time]");
        expect(deleted).not.toBeNull();
        expect(deleted!.parentElement!.textContent).toBe(`home.trash.deleted${formatRelative(DELETED_AT)}`);
        expect(deleted!.title).toBe(formatDateTime(DELETED_AT));

        buttonIn(cards("trash")[0], "home.trash.restore").click();

        await rs.waitFor(() => expect(cloud.documents.has("c1")).toBe(true));
        expect(published).toContainEqual(["showToast", ["home.toast.restored{0}", "Gear"]]);
    });

    test("save to cloud moves a local document, or copies it when keeping the local one", async () => {
        await add(local, "l2", "Plate");
        await render();

        buttonIn(
            home.querySelector('[data-location="local"] [data-id="l1"]')!,
            "cloud.document.saveToCloud",
        ).click();
        await lastDialogButtons()[2].find((b) => b.content === "cloud.document.moveToCloud")!.onclick!();
        expect(cloud.documents.has("l1")).toBe(true);
        expect(local.documents.has("l1")).toBe(false);

        buttonIn(
            home.querySelector('[data-location="local"] [data-id="l2"]')!,
            "cloud.document.saveToCloud",
        ).click();
        await lastDialogButtons()[2].find((b) => b.content === "cloud.document.keepLocalCopy")!.onclick!();
        // A copy gets its own id: the two never overwrite each other.
        const copies = [...cloud.documents.values()].filter((x) => x.name === "Plate");
        expect(copies).toHaveLength(1);
        expect(copies[0].id).not.toBe("l2");
        expect(local.documents.has("l2")).toBe(true);
    });

    test("move to this device asks before touching a local document with the same id", async () => {
        await add(local, "c1", "Gear (kept copy)");
        await render();

        buttonIn(cards("cloud")[0], "home.action.moveToDevice").click();
        await rs.waitFor(() => expect(lastDialogButtons()[0]).toBe("cloud.document.existsTitle"));
        const choices = lastDialogButtons()[2].map((b) => b.content);
        expect(choices).toEqual(["cloud.document.replace", "cloud.document.keepBoth", "common.cancel"]);
        lastDialogButtons()[2].find((b) => b.content === "cloud.document.keepBoth")!.onclick!();

        await rs.waitFor(() => expect(cloud.documents.has("c1")).toBe(false));
        expect(local.documents.get("c1")?.name).toBe("Gear (kept copy)");
        expect([...local.documents.values()].filter((x) => x.name === "Gear")).toHaveLength(1);
    });

    test("move to this device brings a cloud document back", async () => {
        await render();

        buttonIn(cards("cloud")[0], "home.action.moveToDevice").click();

        await rs.waitFor(() => expect(local.documents.has("c1")).toBe(true));
        expect(cloud.documents.has("c1")).toBe(false);
        expect(published).toContainEqual(["showToast", ["home.toast.movedToDevice{0}", "Gear"]]);
    });

    test("upload from this device: a checklist, only the checked ones go", async () => {
        await add(local, "l2", "Plate");
        await render();

        buttonIn(home, "home.import.button").click();
        await rs.waitFor(() => expect(lastDialogButtons()[0]).toBe("home.import.title"));
        const [, content, buttons] = lastDialogButtons();
        const boxes = Array.from(content.querySelectorAll<HTMLInputElement>("input[data-id]"));
        expect(boxes.map((b) => [b.dataset["id"], b.checked])).toEqual([
            ["l1", true],
            ["l2", true],
        ]);
        boxes[1].checked = false;
        buttons.find((b) => b.content === "home.import.upload")!.onclick!();
        const permanent = published.find(([event]) => event === "showPermanent");
        expect(permanent).toBeDefined();
        await (permanent![1][0] as () => Promise<void>)();

        const uploaded = [...cloud.documents.values()].map((x) => x.name);
        expect(uploaded).toContain("Bracket");
        expect(uploaded).not.toContain("Plate");
        // Copied: the local documents stay unless asked otherwise.
        expect(local.documents.has("l1")).toBe(true);
        expect(published).toContainEqual(["showToast", ["home.import.done{0}{1}", 1, 1]]);
    });

    test("cloud thumbnails are fetched from the repository", async () => {
        const thumbnailUrl = rs.fn(async (_meta: DocumentMeta) => "blob:thumb");
        (cloud as unknown as { thumbnailUrl: typeof thumbnailUrl }).thumbnailUrl = thumbnailUrl;
        await render();

        const image = cards("cloud")[0].querySelector("img");
        expect(image).not.toBeNull();
        await rs.waitFor(() => expect(image!.getAttribute("src")).toBe("blob:thumb"));
        expect(thumbnailUrl).toHaveBeenCalledTimes(1);
    });
});

describe("card context menu", () => {
    afterEach(() => closeContextMenu());

    const openMenu = (card: HTMLElement) => {
        const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 1,
            clientY: 1,
        });
        card.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    };
    const labels = (items: HTMLButtonElement[]) => items.map((x) => x.textContent);
    const itemIn = (items: HTMLButtonElement[], text: string) => {
        const found = items.find((x) => x.textContent === text);
        expect(found).toBeDefined();
        return found!;
    };

    test("a device card offers open, rename, duplicate, download and delete (rename only where supported)", async () => {
        await render();
        const items = openMenu(cards("local")[0]);

        expect(labels(items)).toEqual([
            "command.doc.open",
            "common.rename",
            "home.menu.duplicate",
            "cloud.document.download",
            "common.delete",
        ]);
        expect(itemIn(items, "common.rename").disabled).toBe(true);
    });

    test("duplicate saves a copy under a new id next to the original", async () => {
        await render();
        itemIn(openMenu(cards("local")[0]), "home.menu.duplicate").click();

        await rs.waitFor(() => expect(local.documents.size).toBe(2));
        const copy = [...local.documents.values()].find((x) => x.id !== "l1");
        expect(copy!.name).toBe("home.menu.copyNameBracket");
        expect(local.documents.get("l1")!.name).toBe("Bracket");
        expect(published).toContainEqual(["showToast", ["home.toast.duplicated{0}", "Bracket"]]);
        await rs.waitFor(() => expect(cards("local")).toHaveLength(2));
    });

    test("rename asks for the name and renames the stored and the open document", async () => {
        const rename = rs.fn(async (id: string, name: string) => {
            const stored = local.documents.get(id)!;
            local.documents.set(id, { ...stored, name });
            return Result.ok(undefined);
        });
        (local as unknown as { rename: typeof rename }).rename = rename;
        const open = { id: "l1", repository: local, name: "Bracket" };
        (app as unknown as { documents: Set<unknown> }).documents = new Set([open]);
        await render();

        itemIn(openMenu(cards("local")[0]), "common.rename").click();
        const [title, box, buttons] = lastDialogButtons();
        expect(title).toBe("common.rename");
        (box as HTMLInputElement).value = "  Bracket v2 ";
        await buttons.find((b) => b.content === "common.rename")!.onclick!();

        expect(rename).toHaveBeenCalledWith("l1", "Bracket v2");
        expect(open.name).toBe("Bracket v2");
        await rs.waitFor(() => expect(home.textContent).toContain("Bracket v2"));
    });

    test("delete from the menu asks like the card's button", async () => {
        const confirm = rs.spyOn(window, "confirm").mockReturnValue(false);
        await render();

        itemIn(openMenu(cards("local")[0]), "common.delete").click();

        await rs.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        expect(local.documents.has("l1")).toBe(true);
    });

    test("signed in: device cards can go to the cloud, cloud cards to this device; trash cards restore", async () => {
        const cloud = new TrashRepository();
        app.repositories.cloud = cloud;
        await add(cloud, "c1", "Gear");
        await add(cloud, "c2", "Old");
        await cloud.delete("c2");
        await render();

        expect(labels(openMenu(cards("local")[0]))).toContain("cloud.document.saveToCloud");
        expect(labels(openMenu(cards("cloud")[0]))).toContain("home.action.moveToDevice");

        buttonIn(home, "home.trash.button").click();
        await rs.waitFor(() => expect(sections()).toEqual(["trash"]));
        itemIn(openMenu(cards("trash")[0]), "home.trash.restore").click();
        await rs.waitFor(() => expect(cloud.documents.has("c2")).toBe(true));
    });
});

test.each([
    [512, "512 B"],
    [1500, "1.5 kB"],
    [1_500_000, "1.5 MB"],
    [25_000_000, "25 MB"],
])("formatBytes(%d) is %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
});
