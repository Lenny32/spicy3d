// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { ObjectStorage } from "@spicy3d/core";
import { Account, exportFileName, type SignOutEvent } from "../src/account/account";
import {
    CloudDeviceSettings,
    DEVICE_NAME_MAX_LENGTH,
    defaultDeviceName,
    LAST_USER_MAX_AGE_MS,
} from "../src/account/deviceSettings";
import {
    accountOn,
    FakeServer,
    json,
    problem,
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

function recordSignOuts(account: Account): SignOutEvent[] {
    const events: SignOutEvent[] = [];
    account.addSignOutHandler((event) => {
        events.push(event);
    });
    return events;
}

describe("Account session state", () => {
    test("starts unknown; refresh with a session signs in", async () => {
        const server = new FakeServer().on("GET /api/me", json(200, USER));
        const account = accountOn(server);
        expect(account.status).toBe("unknown");

        const result = await account.refresh();

        expect(result.isOk).toBe(true);
        expect(result.value).toEqual(USER);
        expect(account.status).toBe("signedIn");
        expect(account.user).toEqual(USER);
    });

    test("refresh without a session: signed out, not an error", async () => {
        const server = new FakeServer().on("GET /api/me", problem(401, "unauthorized"));
        const account = accountOn(server);

        const result = await account.refresh();

        expect(result.isOk).toBe(true);
        expect(result.value).toBeUndefined();
        expect(account.status).toBe("signedOut");
    });

    test("refresh offline keeps the status unknown and reports the error", async () => {
        const server = new FakeServer();
        server.fetch.mockImplementation(async () => {
            throw new TypeError("Failed to fetch");
        });
        const account = accountOn(server);

        const result = await account.refresh();

        expect(result.isOk).toBe(false);
        expect(result.error).toEqual({ kind: "offline" });
        expect(account.status).toBe("unknown");
    });

    test("offline at startup, the user last signed in here stays signed in; signing out forgets them", async () => {
        const server = new FakeServer().on("GET /api/me", json(200, USER));
        const first = accountOn(server);
        await first.refresh();
        expect(first.deviceSettings.lastUser()?.id).toBe(USER.id);
        server.fetch.mockImplementation(async () => {
            throw new TypeError("Failed to fetch");
        });
        const account = new Account(server.client(), first.deviceSettings);

        const result = await account.refresh();

        expect(result.isOk).toBe(false);
        expect(account.status).toBe("signedIn");
        expect(account.user?.id).toBe(USER.id);
        await account.signOut();
        expect(account.deviceSettings.lastUser()).toBeUndefined();
    });

    test("a cached user is not signed in again once 30 days old, nor after any 401", async () => {
        const settings = accountOn(new FakeServer()).deviceSettings;
        settings.rememberUser(USER, 1000);
        expect(settings.lastUser(1000 + LAST_USER_MAX_AGE_MS)?.id).toBe(USER.id);
        expect(settings.lastUser(1001 + LAST_USER_MAX_AGE_MS)).toBeUndefined();

        const server = new FakeServer().on("GET /api/me", json(200, USER));
        const account = accountOn(server);
        await account.refresh();
        server.on("GET /api/me", json(401, { status: 401, code: "unauthorized" }));
        await account.refresh();
        expect(account.deviceSettings.lastUser()).toBeUndefined();
    });

    test("status and user changes are observable", async () => {
        const server = new FakeServer().on("GET /api/me", json(200, USER));
        const account = accountOn(server);
        const changed: string[] = [];
        account.onPropertyChanged((property) => changed.push(String(property)));

        await account.refresh();

        expect(changed).toEqual(["user", "status"]);
    });
});

describe("sign up, in, out", () => {
    test("sign up without email verification signs in (201)", async () => {
        const server = new FakeServer().on("POST /api/auth/signup", json(201, USER));
        const account = accountOn(server);
        const request = {
            email: USER.email,
            displayName: USER.displayName,
            password: "correct horse battery",
        };

        const result = await account.signUp(request);

        expect(result.value).toEqual({ status: "signedIn", user: USER });
        expect(account.status).toBe("signedIn");
        expect(server.requests[0].body).toEqual(request);
    });

    test("sign up with email verification (202): a link was sent, not signed in", async () => {
        const server = new FakeServer().on("POST /api/auth/signup", json(202));
        const account = accountOn(server);

        const result = await account.signUp({
            email: "a@b.test",
            displayName: "A",
            password: "0123456789ab",
        });

        expect(result.value).toEqual({ status: "verificationRequired" });
        expect(account.status).toBe("unknown");
    });

    test("sign in with wrong credentials stays signed out, with the server's code", async () => {
        const server = new FakeServer().on("POST /api/auth/login", problem(401, "invalid_credentials"));
        const account = accountOn(server);

        const result = await account.signIn(USER.email, "nope");

        expect(result.isOk).toBe(false);
        expect(result.error).toMatchObject({
            kind: "problem",
            status: 401,
            problem: { code: "invalid_credentials" },
        });
        expect(account.status).toBe("unknown");
        expect(account.user).toBeUndefined();
    });

    test("sign in sends the credentials and keeps the user", async () => {
        const server = new FakeServer().on("POST /api/auth/login", json(200, USER));
        const account = accountOn(server);

        const result = await account.signIn(USER.email, "secret-password");

        expect(result.value).toEqual(USER);
        expect(account.status).toBe("signedIn");
        expect(server.requests[0].body).toEqual({ email: USER.email, password: "secret-password" });
    });

    test("sign out ends the session and removes cached cloud copies by default", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/auth/logout", json(204));
        const events = recordSignOuts(account);

        await account.signOut();

        expect(server.calls).toEqual(["POST /api/auth/logout"]);
        expect(account.status).toBe("signedOut");
        expect(account.user).toBeUndefined();
        expect(events).toEqual([{ reason: "signOut", removeCachedDocuments: true }]);
    });

    test("sign out keeps cached copies when the user keeps offline copies", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server, true);
        server.on("POST /api/auth/logout", json(204));
        const events = recordSignOuts(account);

        await account.signOut();

        expect(events).toEqual([{ reason: "signOut", removeCachedDocuments: false }]);
    });

    test("sign out offline still signs out on this device", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.fetch.mockImplementationOnce(async () => {
            throw new TypeError("Failed to fetch");
        });

        await account.signOut();

        expect(account.status).toBe("signedOut");
    });

    test("a failing sign-out handler doesn't stop the others", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/auth/logout", json(204));
        account.addSignOutHandler(() => {
            throw new Error("boom");
        });
        const events = recordSignOuts(account);

        await account.signOut();

        expect(events).toHaveLength(1);
    });

    test("an unregistered handler is not called", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/auth/logout", json(204));
        const handler = rs.fn((_event: SignOutEvent) => {});
        const unregister = account.addSignOutHandler(handler);
        unregister();

        await account.signOut();

        expect(handler).not.toHaveBeenCalled();
    });
});

describe("another user signing in on this device", () => {
    const OTHER = { ...USER, id: "0190a0c2-0000-7000-8000-00000000000b", email: "bob@example.test" };

    test("signing in as someone else while signed in signs the previous user out first, cache removed", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server, true);
        const events = recordSignOuts(account);
        const statuses: string[] = [];
        account.onPropertyChanged((p) => {
            if (p === "status") statuses.push(account.status);
        });
        server.on("POST /api/auth/login", json(200, OTHER));

        await account.signIn(OTHER.email, "pw");

        // keepOfflineCopies is on, but the next user must never inherit the cache.
        expect(events).toEqual([{ reason: "switchUser", removeCachedDocuments: true }]);
        expect(statuses).toEqual(["signedOut", "signedIn"]);
        expect(account.user).toEqual(OTHER);
    });

    test("a refresh that finds another user while a re-login is pending never retries under their session", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        const events = recordSignOuts(account);
        account.setReauthenticationHandler(() => {});
        server.on("GET /api/me/sessions", problem(401, "unauthorized"), json(200, []));

        const pending = account.listSessions();
        await rs.waitFor(() => expect(account.status).toBe("expired"));
        server.on("GET /api/me", json(200, OTHER));
        await account.refresh();
        const result = await pending;

        expect(result.isOk).toBe(false);
        expect(server.calls.filter((c) => c === "GET /api/me/sessions")).toHaveLength(1);
        expect(events).toEqual([{ reason: "switchUser", removeCachedDocuments: true }]);
        expect(account.user).toEqual(OTHER);
    });

    test("the same user again is not a switch", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        const events = recordSignOuts(account);
        server.on("GET /api/me", json(200, { ...USER, displayName: "Ada L." }));

        await account.refresh();

        expect(events).toEqual([]);
        expect(account.user?.displayName).toBe("Ada L.");
    });
});

describe("session expiry", () => {
    test("a 401 while signed in asks to sign in again, then retries the request once", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server
            .on("GET /api/me/sessions", problem(401, "unauthorized"), json(200, []))
            .on("POST /api/auth/login", json(200, USER));
        const asked = rs.fn((_account: Account) => {});
        account.setReauthenticationHandler(asked);

        const pending = account.listSessions();
        await rs.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
        expect(account.status).toBe("expired");
        expect(account.user).toEqual(USER);

        await account.signIn(USER.email, "secret-password");
        const result = await pending;

        expect(result.value).toEqual([]);
        expect(account.status).toBe("signedIn");
        expect(server.calls).toEqual([
            "GET /api/me/sessions",
            "POST /api/auth/login",
            "GET /api/me/sessions",
        ]);
    });

    test("concurrent requests share one prompt", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server
            .on("GET /api/me/sessions", problem(401, "unauthorized"), json(200, []))
            .on("GET /api/me/tokens", problem(401, "unauthorized"), json(200, []))
            .on("POST /api/auth/login", json(200, USER));
        const asked = rs.fn((_account: Account) => {});
        account.setReauthenticationHandler(asked);

        const sessions = account.listSessions();
        const tokens = account.listAccessTokens();
        await rs.waitFor(() => expect(server.requests).toHaveLength(2));
        await account.signIn(USER.email, "secret-password");

        expect((await sessions).isOk).toBe(true);
        expect((await tokens).isOk).toBe(true);
        expect(asked).toHaveBeenCalledTimes(1);
    });

    test("declining signs out on this device and returns the 401; nothing else is touched", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server, true);
        server.on("GET /api/me/tokens", problem(401, "unauthorized"));
        const events = recordSignOuts(account);
        account.setReauthenticationHandler((a) => void a.cancelReauthentication());

        const result = await account.listAccessTokens();

        expect(result.isOk).toBe(false);
        expect(result.error).toMatchObject({ kind: "problem", status: 401 });
        expect(account.status).toBe("signedOut");
        expect(events).toEqual([{ reason: "expired", removeCachedDocuments: false }]);
        expect(server.calls).toEqual(["GET /api/me/tokens"]);
    });

    test("without a handler the expiry resolves as not signed in", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);

        expect(await account.reauthenticate()).toBe(false);
        expect(account.status).toBe("signedOut");
    });

    test("a 401 when never signed in is returned as is, without a prompt", async () => {
        const server = new FakeServer().on("GET /api/me/tokens", problem(401, "unauthorized"));
        const account = accountOn(server);
        const asked = rs.fn((_account: Account) => {});
        account.setReauthenticationHandler(asked);

        const result = await account.listAccessTokens();

        expect(result.isOk).toBe(false);
        expect(asked).not.toHaveBeenCalled();
    });

    test("refresh noticing the expiry marks it without prompting", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("GET /api/me", problem(401, "unauthorized"));
        const asked = rs.fn((_account: Account) => {});
        account.setReauthenticationHandler(asked);

        await account.refresh();

        expect(account.status).toBe("expired");
        expect(asked).not.toHaveBeenCalled();
    });

    test("someone else signing in after an expiry signs the previous user out first", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        const other = { ...USER, id: "0190a0c2-0000-7000-8000-00000000000b", email: "bob@example.test" };
        server.on("GET /api/me", problem(401, "unauthorized")).on("POST /api/auth/login", json(200, other));
        await account.refresh();
        const events = recordSignOuts(account);

        await account.signIn(other.email, "pw");

        expect(events).toEqual([{ reason: "switchUser", removeCachedDocuments: true }]);
        expect(account.user).toEqual(other);
        expect(account.status).toBe("signedIn");
    });
});

describe("email links", () => {
    test("verifying the signed-in user's email refreshes the profile", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server
            .on("POST /api/auth/verify-email", json(204))
            .on("GET /api/me", json(200, { ...USER, emailVerified: true }));

        const result = await account.verifyEmail(USER.id, "tok");

        expect(result.isOk).toBe(true);
        expect(server.calls).toEqual(["POST /api/auth/verify-email", "GET /api/me"]);
        expect(server.requests[0].body).toEqual({ userId: USER.id, token: "tok" });
    });

    test("an invalid link reports invalid_token", async () => {
        const server = new FakeServer().on("POST /api/auth/verify-email", problem(400, "invalid_token"));
        const account = accountOn(server);

        const result = await account.verifyEmail(USER.id, "old");

        expect(result.error).toMatchObject({ problem: { code: "invalid_token" } });
    });

    test("resetting the password of the signed-in user signs this device out (the server revoked all)", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/auth/reset-password", json(204));

        const result = await account.resetPassword(USER.id, "tok", "a new long password");

        expect(result.isOk).toBe(true);
        expect(server.requests[0].body).toEqual({
            userId: USER.id,
            token: "tok",
            newPassword: "a new long password",
        });
        expect(account.status).toBe("signedOut");
    });

    test("confirming an email change sends the link's fields", async () => {
        const server = new FakeServer().on("POST /api/auth/confirm-email-change", json(204));
        const account = accountOn(server);

        const result = await account.confirmEmailChange(USER.id, "new@example.test", "tok");

        expect(result.isOk).toBe(true);
        expect(server.requests[0].body).toEqual({ userId: USER.id, email: "new@example.test", token: "tok" });
    });

    test("forgot password without email on the server: email_disabled", async () => {
        const server = new FakeServer().on("POST /api/auth/forgot-password", problem(503, "email_disabled"));
        const account = accountOn(server);

        const result = await account.forgotPassword(USER.email);

        expect(result.error).toMatchObject({ problem: { code: "email_disabled" } });
    });
});

describe("profile, sessions, tokens", () => {
    test("changing the display name updates the user", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("PATCH /api/me", json(200, { ...USER, displayName: "Countess" }));

        const result = await account.updateDisplayName("Countess");

        expect(result.value.displayName).toBe("Countess");
        expect(account.user?.displayName).toBe("Countess");
        expect(server.requests[0].body).toEqual({ displayName: "Countess" });
    });

    test("an email change with email enabled waits for the confirmation (202)", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/me/change-email", json(202));

        const result = await account.changeEmail("new@example.test", "pw");

        expect(result.value).toEqual({ status: "confirmationSent" });
        expect(account.user?.email).toBe(USER.email);
    });

    test("an email change without email applies at once (200)", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        const changed = { ...USER, email: "new@example.test", emailVerified: false };
        server.on("POST /api/me/change-email", json(200, changed));

        const result = await account.changeEmail("new@example.test", "pw");

        expect(result.value).toEqual({ status: "applied", user: changed });
        expect(account.user).toEqual(changed);
    });

    test("change password sends both passwords", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/me/change-password", json(204));

        const result = await account.changePassword("old password", "new long password");

        expect(result.isOk).toBe(true);
        expect(server.requests[0].body).toEqual({
            currentPassword: "old password",
            newPassword: "new long password",
        });
    });

    test("a wrong current password: invalid_password (403), still signed in", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/me/change-password", problem(403, "invalid_password"));

        const result = await account.changePassword("wrong", "new long password");

        expect(result.error).toMatchObject({ status: 403, problem: { code: "invalid_password" } });
        expect(account.status).toBe("signedIn");
    });

    test("revoking another session keeps this one", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("DELETE /api/me/sessions/s2", json(204));

        const result = await account.revokeSession({ id: "s2", current: false });

        expect(result.isOk).toBe(true);
        expect(account.status).toBe("signedIn");
    });

    test("revoking the current session signs out", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("DELETE /api/me/sessions/s1", json(204));
        const events = recordSignOuts(account);

        await account.revokeSession({ id: "s1", current: true });

        expect(account.status).toBe("signedOut");
        expect(events).toEqual([{ reason: "signOut", removeCachedDocuments: true }]);
    });

    test("creating a token returns the secret; revoking deletes it", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        const created = {
            token: "spicy_pat_secret",
            id: "t1",
            name: "Laptop",
            prefix: "spicy_pat_se",
            scopes: ["mcp:read"],
            createdAt: "2026-09-27T10:00:00Z",
            expiresAt: null,
        };
        server.on("POST /api/me/tokens", json(201, created)).on("DELETE /api/me/tokens/t1", json(204));
        const request = { name: "Laptop", scopes: ["mcp:read"], expiresInDays: 90, currentPassword: "pw" };

        const result = await account.createAccessToken(request);
        const revoked = await account.revokeAccessToken("t1");

        expect(result.value.token).toBe("spicy_pat_secret");
        expect(server.requests[0].body).toEqual(request);
        expect(revoked.isOk).toBe(true);
        expect(server.calls).toEqual(["POST /api/me/tokens", "DELETE /api/me/tokens/t1"]);
    });
});

describe("privacy", () => {
    test("export downloads the ZIP as a blob, with or without history", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on(
            "GET /api/me/export",
            new Response(new Blob(["PK"]), { status: 200, headers: { "Content-Type": "application/zip" } }),
        );

        const result = await account.exportData(true);

        expect(result.isOk).toBe(true);
        expect(await result.value.data.text()).toBe("PK");
        expect(result.value.fileName).toMatch(/^spicy3d-export-\d{4}-\d{2}-\d{2}T\d{6}Z\.zip$/);
        expect(server.requests[0].search).toBe("?history=true");
    });

    test("export once per hour: 429 with Retry-After", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on(
            "GET /api/me/export",
            new Response(null, { status: 429, headers: { "Retry-After": "1800" } }),
        );

        const result = await account.exportData(false);

        expect(result.error).toMatchObject({ kind: "problem", status: 429, retryAfterSeconds: 1800 });
    });

    test("deleting the account signs out and always removes cached cloud copies", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server, true);
        server.on("POST /api/me/delete", json(204));
        const events = recordSignOuts(account);

        const result = await account.deleteAccount("pw");

        expect(result.isOk).toBe(true);
        expect(server.requests[0].body).toEqual({ currentPassword: "pw" });
        expect(account.status).toBe("signedOut");
        expect(events).toEqual([{ reason: "deleted", removeCachedDocuments: true }]);
    });

    test("a wrong password deletes nothing", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/me/delete", problem(403, "invalid_password"));
        const events = recordSignOuts(account);

        const result = await account.deleteAccount("wrong");

        expect(result.isOk).toBe(false);
        expect(account.status).toBe("signedIn");
        expect(events).toEqual([]);
    });

    test("exportFileName follows the server's pattern, in UTC", () => {
        expect(exportFileName(new Date(Date.UTC(2026, 8, 27, 14, 5, 9, 123)))).toBe(
            "spicy3d-export-2026-09-27T140509Z.zip",
        );
    });
});

describe("CloudDeviceSettings", () => {
    test("keeps 'keep offline copies' in local storage, off by default", () => {
        const storage = new ObjectStorage("spicy3d-test", "device-settings");
        storage.clear();
        const first = new CloudDeviceSettings(storage);
        expect(first.keepOfflineCopies).toBe(false);

        first.keepOfflineCopies = true;

        expect(new CloudDeviceSettings(storage).keepOfflineCopies).toBe(true);
        storage.clear();
    });

    test("the device name is user-editable, trimmed and capped; empty means the default", () => {
        const storage = new ObjectStorage("spicy3d-test", "device-name");
        storage.clear();
        const settings = new CloudDeviceSettings(storage);
        expect(settings.deviceName).toBe("");
        expect(settings.effectiveDeviceName).toBe(defaultDeviceName());

        settings.deviceName = `  Desk ${"x".repeat(200)}`;

        expect(settings.deviceName).toHaveLength(DEVICE_NAME_MAX_LENGTH);
        expect(settings.deviceName.startsWith("Desk x")).toBe(true);
        expect(new CloudDeviceSettings(storage).deviceName).toBe(settings.deviceName);
        storage.clear();
    });

    test("new documents go to the cloud unless the device says otherwise", () => {
        const storage = new ObjectStorage("spicy3d-test", "new-location");
        storage.clear();
        const settings = new CloudDeviceSettings(storage);
        expect(settings.newDocumentLocation).toBe("cloud");

        settings.newDocumentLocation = "local";

        expect(new CloudDeviceSettings(storage).newDocumentLocation).toBe("local");
        storage.clear();
    });

    test.each([
        ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Linux – Firefox"],
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
            "Windows – Chrome",
        ],
        ["", "This device"],
    ])("default device name of %s is %s", (userAgent, expected) => {
        expect(defaultDeviceName(userAgent)).toBe(expected);
    });
});
