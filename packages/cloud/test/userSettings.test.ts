// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { AutosaveSettings, ObjectStorage } from "@spicy3d/core";
import type { Account } from "../src/account/account";
import { type AutosaveIntervalField, autosaveSection } from "../src/settings/autosaveSection";
import { CloudUserSettings, intervalOf, withInterval } from "../src/settings/userSettings";
import {
    accountOn,
    FakeServer,
    json,
    problem,
    type RecordedRequest,
    signedInAccount,
    TestRequest,
    USER,
} from "./_helpers/fakeServer";

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

/** The server's settings endpoint, in memory: an ETag per change, `"0"` while never saved, If-Match → 412. */
class FakeSettingsServer {
    settings: Record<string, unknown> = {};
    version = 0;

    constructor(readonly server: FakeServer) {
        server.on("GET /api/me/settings", () => this.answer());
        server.on("PUT /api/me/settings", (request) => this.put(request));
    }

    /** Another device saves. */
    saveElsewhere(autosave: { intervalMinutes: number; enabled: boolean }) {
        this.settings = { autosave };
        this.version++;
    }

    private answer() {
        const body = { autosave: { intervalMinutes: 5, enabled: true }, ...this.settings };
        return json(200, body, { ETag: `"${this.version}"` });
    }

    put(request: RecordedRequest) {
        const ifMatch = request.headers["if-match"];
        if (ifMatch !== undefined && ifMatch.replace(/"/g, "") !== String(this.version)) {
            return problem(412, "precondition_failed");
        }
        this.settings = request.body as Record<string, unknown>;
        this.version++;
        return this.answer();
    }

    get puts() {
        return this.server.requests.filter((x) => x.method === "PUT");
    }
}

function localSettings(interval?: 0 | 1 | 2 | 5 | 10 | 15 | 30) {
    const settings = new AutosaveSettings(new ObjectStorage("spicy3d-test", `settings-${Math.random()}`));
    if (interval !== undefined) settings.intervalMinutes = interval;
    return settings;
}

async function signIn(server: FakeServer, account: Account) {
    server.on("GET /api/me", json(200, USER));
    await account.refresh();
}

describe("server settings ↔ autosave interval", () => {
    test.each([
        [undefined, 5],
        [{}, 5],
        [{ autosave: { intervalMinutes: 15, enabled: true } }, 15],
        [{ autosave: { intervalMinutes: "10", enabled: true } }, 10],
        [{ autosave: { intervalMinutes: 15, enabled: false } }, 0],
        [{ autosave: { intervalMinutes: 7, enabled: true } }, 5],
    ])("%o → %d", (settings, interval) => {
        expect(intervalOf(settings as never)).toBe(interval);
    });

    test("off keeps the last interval; other keys are sent back as they were", () => {
        const stored = { autosave: { intervalMinutes: 15, enabled: true }, other: { a: 1 } } as never;
        expect(withInterval(stored, 0)).toEqual({
            autosave: { intervalMinutes: 15, enabled: false },
            other: { a: 1 },
        });
        expect(withInterval(undefined, 2)).toEqual({ autosave: { intervalMinutes: 2, enabled: true } });
    });
});

describe("CloudUserSettings", () => {
    test("on sign-in the server's value wins", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 30, enabled: true });
        const settings = localSettings(10);
        const account = accountOn(server);
        const cloud = new CloudUserSettings(account, { settings });

        await signIn(server, account);
        await cloud.settled();

        expect(settings.intervalMinutes).toBe(30);
        expect(remote.puts).toHaveLength(0);
        // The signed-out value is kept for later.
        expect(settings.localIntervalMinutes).toBe(10);
        cloud.dispose();
    });

    test("an account without settings yet gets this device's value", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        const settings = localSettings(15);
        const account = accountOn(server);
        const cloud = new CloudUserSettings(account, { settings });

        await signIn(server, account);
        await cloud.settled();

        expect(remote.puts.map((x) => x.body)).toEqual([
            { autosave: { intervalMinutes: 15, enabled: true } },
        ]);
        expect(remote.puts[0].headers["if-match"]).toBe('"0"');
        expect(settings.intervalMinutes).toBe(15);
        expect(settings.accountCache?.pending).toBe(false);
        cloud.dispose();
    });

    test("a change while signed in goes to the server with If-Match; Off is `enabled: false`", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 10, enabled: true });
        const settings = localSettings();
        const cloud = new CloudUserSettings(await signedInAccount(server), { settings });
        await cloud.settled();

        settings.intervalMinutes = 0;
        await cloud.settled();

        expect(remote.puts).toHaveLength(1);
        expect(remote.puts[0].headers["if-match"]).toBe('"1"');
        expect(remote.settings).toEqual({ autosave: { intervalMinutes: 10, enabled: false } });
        expect(settings.intervalMinutes).toBe(0);
        expect(settings.localIntervalMinutes).toBe(5);
        cloud.dispose();
    });

    test("changed on another device meanwhile (412): fetched again, this change applied on top", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        const settings = localSettings();
        const cloud = new CloudUserSettings(await signedInAccount(server), { settings });
        await cloud.settled();
        remote.saveElsewhere({ intervalMinutes: 30, enabled: true });

        settings.intervalMinutes = 2;
        await cloud.settled();

        const puts = remote.puts;
        expect(puts.map((x) => x.headers["if-match"])).toEqual(['"0"', '"1"', '"2"']);
        expect(server.calls.filter((x) => x === "GET /api/me/settings")).toHaveLength(2);
        expect(remote.settings).toEqual({ autosave: { intervalMinutes: 2, enabled: true } });
        expect(settings.intervalMinutes).toBe(2);
        cloud.dispose();
    });

    test("offline: the change stays pending and is sent on the next refresh", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 10, enabled: true });
        const settings = localSettings();
        const cloud = new CloudUserSettings(await signedInAccount(server), { settings });
        await cloud.settled();
        server.on("PUT /api/me/settings", () => Promise.reject(new TypeError("Failed to fetch")));

        settings.intervalMinutes = 1;
        await cloud.settled();
        expect(settings.accountCache).toMatchObject({ intervalMinutes: 1, pending: true });
        expect(remote.settings).toEqual({ autosave: { intervalMinutes: 10, enabled: true } });

        server.on("PUT /api/me/settings", (request) => remote.put(request));
        await cloud.refresh();

        expect(remote.settings).toEqual({ autosave: { intervalMinutes: 1, enabled: true } });
        expect(settings.accountCache?.pending).toBe(false);
        cloud.dispose();
    });

    test("device B picks up device A's change on refresh (tab focus, network back, settings opened)", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 10, enabled: true });
        const settings = localSettings();
        const cloud = new CloudUserSettings(await signedInAccount(server), { settings });
        await cloud.settled();
        expect(settings.intervalMinutes).toBe(10);

        remote.saveElsewhere({ intervalMinutes: 1, enabled: true });
        globalThis.dispatchEvent(new Event("online"));
        await cloud.settled();

        expect(settings.intervalMinutes).toBe(1);
        expect(remote.puts).toHaveLength(0);
        cloud.dispose();
    });

    test("signing out brings back this device's value and forgets the account's", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 30, enabled: true });
        const settings = localSettings(2);
        const account = await signedInAccount(server);
        const cloud = new CloudUserSettings(account, { settings });
        await cloud.settled();
        expect(settings.intervalMinutes).toBe(30);

        server.on("POST /api/auth/logout", json(204));
        await account.signOut();

        expect(settings.intervalMinutes).toBe(2);
        expect(settings.accountCache).toBeUndefined();
        expect(settings.hasStore).toBe(false);
        cloud.dispose();
    });

    test("a cached account whose session ended is forgotten at startup (401 → signed out)", async () => {
        const server = new FakeServer();
        new FakeSettingsServer(server);
        const kept = new ObjectStorage("spicy3d-test", `settings-${Math.random()}`);
        const previous = new AutosaveSettings(kept);
        previous.intervalMinutes = 2;
        previous.attach({ save: () => {} }, "user-old");
        previous.applyStoreValue(30);
        // Next startup: the cached account value applies until the session is known.
        const settings = new AutosaveSettings(kept);
        expect(settings.intervalMinutes).toBe(30);
        const account = accountOn(server);
        const cloud = new CloudUserSettings(account, { settings });

        server.on("GET /api/me", problem(401, "unauthorized"));
        await account.refresh();

        expect(account.status).toBe("signedOut");
        expect(settings.intervalMinutes).toBe(2);
        expect(settings.accountCache).toBeUndefined();
        settings.intervalMinutes = 10;
        expect(settings.accountCache).toBeUndefined();
        expect(settings.localIntervalMinutes).toBe(10);
        cloud.dispose();
    });

    test("another user signing in starts from this device's value, not the previous user's", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 30, enabled: true });
        const settings = localSettings(2);
        const account = await signedInAccount(server);
        const cloud = new CloudUserSettings(account, { settings });
        await cloud.settled();
        expect(settings.intervalMinutes).toBe(30);

        // The other user's server has no settings yet: this device's value is uploaded for them.
        const other = { ...USER, id: "0190a0c2-0000-7000-8000-00000000000b", email: "grace@example.test" };
        remote.settings = {};
        remote.version = 0;
        server.on("GET /api/me", json(200, other));
        await account.refresh();
        await cloud.settled();

        expect(settings.accountCache?.userId).toBe(other.id);
        expect(settings.intervalMinutes).toBe(2);
        expect(remote.settings).toEqual({ autosave: { intervalMinutes: 2, enabled: true } });
        cloud.dispose();
    });

    test("the account settings section shows the value, changes it and re-reads the server", async () => {
        const server = new FakeServer();
        const remote = new FakeSettingsServer(server);
        remote.saveElsewhere({ intervalMinutes: 15, enabled: true });
        const settings = localSettings();
        const cloud = new CloudUserSettings(await signedInAccount(server), { settings });
        await cloud.settled();
        const gets = () => server.calls.filter((x) => x === "GET /api/me/settings").length;
        const before = gets();

        const section = autosaveSection(cloud);
        const root = section.render({} as never);
        document.body.append(root);
        await cloud.settled();
        expect(gets()).toBe(before + 1);
        const field = root.querySelector("spicy-cloud-autosave-interval") as AutosaveIntervalField;
        expect(field).not.toBeNull();
        expect(field.select.value).toBe("15");

        field.select.value = "0";
        field.select.dispatchEvent(new Event("change"));
        await cloud.settled();
        expect(remote.settings).toEqual({ autosave: { intervalMinutes: 15, enabled: false } });

        remote.saveElsewhere({ intervalMinutes: 5, enabled: true });
        await cloud.refresh();
        expect(field.select.value).toBe("5");
        root.remove();
        cloud.dispose();
    });
});
