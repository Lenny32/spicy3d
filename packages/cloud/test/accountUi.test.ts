// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { formatDateTime, formatRelative, PubSub, parseUtc, TitleBar } from "@spicy3d/core";
import type { Account } from "../src/account/account";
import type { ConfigResponse } from "../src/api";
import { CloudConnection } from "../src/cloud";
import { startAccountUi } from "../src/ui";
import { AccountButton } from "../src/ui/accountButton";
import { showAccountSettings, showCreateToken, showDeleteAccount } from "../src/ui/accountSettings";
import {
    type AccountUiContext,
    type FeatureFlags,
    showAccountLink,
    showSignIn,
    showSignUp,
} from "../src/ui/authDialogs";
import {
    accountOn,
    FakeServer,
    json,
    problem,
    signedInAccount,
    TestRequest,
    USER,
} from "./_helpers/fakeServer";

const FEATURES: FeatureFlags = { signup: true, emailVerification: false, email: true, mcp: true };

let published: [string, unknown[]][];

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

beforeEach(() => {
    published = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation((event: string, ...args: unknown[]) => {
        published.push([event, args]);
    });
});

afterEach(() => {
    rs.restoreAllMocks();
    for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
});

function context(account: Account, features: Partial<FeatureFlags> = {}): AccountUiContext {
    return { account, features: { ...FEATURES, ...features } };
}

/** The dialogs open right now, last opened last. */
const dialogs = () => Array.from(document.querySelectorAll("dialog"));

function top(): HTMLDialogElement {
    const all = dialogs();
    expect(all.length).toBeGreaterThan(0);
    return all[all.length - 1];
}

/** In tests, translations are their keys: buttons and texts are found by key. */
function buttonOf(root: ParentNode, key: string): HTMLButtonElement {
    const found = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === key);
    expect(found).toBeInstanceOf(HTMLButtonElement);
    return found!;
}

function inputOf(root: ParentNode, name: string): HTMLInputElement {
    const found = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    expect(found).not.toBeNull();
    return found!;
}

function type(root: ParentNode, name: string, value: string) {
    const field = inputOf(root, name);
    field.value = value;
    field.dispatchEvent(new Event("input"));
}

function submit(dialog: HTMLDialogElement) {
    const form = dialog.querySelector("form");
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { cancelable: true }));
}

/** Waits until the dialog's running action has finished. */
const idle = (dialog: HTMLDialogElement) =>
    rs.waitFor(() => expect(dialog.hasAttribute("aria-busy")).toBe(false));

const alertText = (dialog: HTMLElement) => dialog.querySelector('[role="alert"]')?.textContent ?? "";
const titleOf = (dialog: HTMLElement) => dialog.querySelector("h2")?.textContent;

describe("sign in dialog", () => {
    test("signs in with the typed credentials and closes", async () => {
        const server = new FakeServer().on("POST /api/auth/login", json(200, USER));
        const account = accountOn(server);
        const dialog = showSignIn(context(account)).dialog;

        type(dialog, "email", ` ${USER.email} `);
        type(dialog, "password", "secret-password");
        submit(dialog);

        await rs.waitFor(() => expect(dialog.isConnected).toBe(false));
        expect(server.requests[0].body).toEqual({ email: USER.email, password: "secret-password" });
        expect(account.status).toBe("signedIn");
        expect(published).toContainEqual(["showToast", ["account.welcome{0}", USER.displayName]]);
    });

    test("an unverified user gets one welcome toast that also asks to verify", async () => {
        const unverified = { ...USER, emailVerified: false };
        const server = new FakeServer().on("POST /api/auth/login", json(200, unverified));
        const dialog = showSignIn(context(accountOn(server), { emailVerification: true })).dialog;

        type(dialog, "email", USER.email);
        type(dialog, "password", "secret-password");
        submit(dialog);

        await rs.waitFor(() => expect(dialog.isConnected).toBe(false));
        expect(published.filter(([event]) => event === "showToast")).toEqual([
            ["showToast", ["account.welcomeUnverified{0}", USER.displayName]],
        ]);
    });

    test("wrong credentials: the message stays in the dialog, the password is cleared", async () => {
        const server = new FakeServer().on("POST /api/auth/login", problem(401, "invalid_credentials"));
        const dialog = showSignIn(context(accountOn(server))).dialog;

        type(dialog, "email", USER.email);
        type(dialog, "password", "wrong");
        submit(dialog);

        await rs.waitFor(() => expect(alertText(dialog)).toBe("error.cloud.invalidCredentials"));
        expect(dialog.isConnected).toBe(true);
        expect(inputOf(dialog, "password").value).toBe("");
    });

    test("rate limited: says when to try again", async () => {
        const server = new FakeServer().on(
            "POST /api/auth/login",
            new Response(null, { status: 429, headers: { "Retry-After": "600" } }),
        );
        const dialog = showSignIn(context(accountOn(server))).dialog;

        type(dialog, "email", USER.email);
        type(dialog, "password", "pw");
        submit(dialog);

        await rs.waitFor(() => expect(alertText(dialog)).toBe("error.cloud.retryInMinutes10"));
    });

    test("empty fields are not sent", () => {
        const server = new FakeServer();
        const dialog = showSignIn(context(accountOn(server))).dialog;

        submit(dialog);

        expect(server.requests).toEqual([]);
        expect(dialog.textContent).toContain("account.field.required");
    });

    test("'forgot password' only when the server can send email; otherwise: ask the administrator", () => {
        const server = new FakeServer();
        const withEmail = showSignIn(context(accountOn(server), { email: true })).dialog;
        expect(buttonOf(withEmail, "account.signIn.forgot")).not.toBeNull();
        withEmail.remove();

        const withoutEmail = showSignIn(context(accountOn(server), { email: false })).dialog;
        expect(Array.from(withoutEmail.querySelectorAll("button")).map((b) => b.textContent)).not.toContain(
            "account.signIn.forgot",
        );
        expect(withoutEmail.textContent).toContain("account.signIn.forgotNoEmail");
    });

    test("'create account' only when sign-up is open", () => {
        const server = new FakeServer();
        const closed = showSignIn(context(accountOn(server), { signup: false })).dialog;

        expect(closed.textContent).not.toContain("account.signIn.createAccount");
    });

    test("forgot password: sends the link request and confirms without revealing the account", async () => {
        const server = new FakeServer().on("POST /api/auth/forgot-password", json(202));
        const signIn = showSignIn(context(accountOn(server)), USER.email).dialog;

        buttonOf(signIn, "account.signIn.forgot").click();
        const forgot = top();
        expect(inputOf(forgot, "email").value).toBe(USER.email);
        submit(forgot);

        await rs.waitFor(() => expect(forgot.textContent).toContain(`account.forgot.sent${USER.email}`));
        expect(server.requests[0].body).toEqual({ email: USER.email });
    });
});

describe("sign up dialog", () => {
    function fill(dialog: HTMLDialogElement) {
        type(dialog, "email", "new@example.test");
        type(dialog, "displayName", "New User");
        type(dialog, "password", "correct horse battery staple");
    }

    test("the privacy notice must be accepted", () => {
        const server = new FakeServer();
        const dialog = showSignUp(context(accountOn(server))).dialog;
        fill(dialog);

        submit(dialog);

        expect(alertText(dialog)).toBe("account.signUp.privacyRequired");
        expect(server.requests).toEqual([]);
    });

    test("shows a strength hint while typing the password", () => {
        const dialog = showSignUp(context(accountOn(new FakeServer()))).dialog;

        type(dialog, "password", "short");
        expect(dialog.textContent).toContain("account.password.tooShort10");

        type(dialog, "password", "correct horse battery staple");
        expect(dialog.textContent).toContain("account.password.strong");
    });

    test("with email verification: 'check your inbox', and resend signs in to ask for a new link", async () => {
        const server = new FakeServer()
            .on("POST /api/auth/signup", json(202))
            .on("POST /api/auth/login", json(200, { ...USER, emailVerified: false }))
            .on("POST /api/auth/resend-verification", json(202));
        const account = accountOn(server);
        const dialog = showSignUp(context(account, { emailVerification: true })).dialog;
        fill(dialog);
        dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;

        submit(dialog);
        await rs.waitFor(() => expect(titleOf(dialog)).toBe("account.signUp.checkInbox.title"));
        buttonOf(dialog, "account.signUp.resend").click();

        await rs.waitFor(() => expect(dialog.textContent).toContain("account.signUp.resent"));
        expect(server.calls).toEqual([
            "POST /api/auth/signup",
            "POST /api/auth/login",
            "POST /api/auth/resend-verification",
        ]);
        expect(server.requests[1].body).toEqual({
            email: "new@example.test",
            password: "correct horse battery staple",
        });
    });

    test("verification required but the server can't send email: no resend, ask the administrator", async () => {
        const server = new FakeServer().on("POST /api/auth/signup", json(202));
        const dialog = showSignUp(
            context(accountOn(server), { emailVerification: true, email: false }),
        ).dialog;
        fill(dialog);
        dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;

        submit(dialog);

        await rs.waitFor(() => expect(titleOf(dialog)).toBe("account.signUp.checkInbox.title"));
        expect(dialog.textContent).toContain("error.cloud.emailDisabled");
        expect(dialog.textContent).not.toContain("account.signUp.resend");
    });

    test("validation errors land under their field", async () => {
        const server = new FakeServer().on(
            "POST /api/auth/signup",
            json(422, { status: 422, errors: { password: ["password_common"] } }),
        );
        const dialog = showSignUp(context(accountOn(server))).dialog;
        fill(dialog);
        dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;

        submit(dialog);

        await rs.waitFor(() => expect(dialog.textContent).toContain("error.cloud.field.passwordCommon"));
        expect(alertText(dialog)).toBe("");
        expect(inputOf(dialog, "password").hasAttribute("aria-invalid")).toBe(true);
    });
});

describe("account email links", () => {
    test("reset password: new password twice, then offers to sign in", async () => {
        const server = new FakeServer().on("POST /api/auth/reset-password", json(204));
        const ctx = context(accountOn(server));
        const dialog = showAccountLink(ctx, { kind: "resetPassword", userId: USER.id, token: "tok" }).dialog;

        type(dialog, "newPassword", "a brand new passphrase");
        type(dialog, "confirmPassword", "a different one");
        submit(dialog);
        expect(dialog.textContent).toContain("account.passwordMismatch");
        expect(server.requests).toEqual([]);
        await idle(dialog);

        type(dialog, "confirmPassword", "a brand new passphrase");
        submit(dialog);

        await rs.waitFor(() => expect(dialog.textContent).toContain("account.reset.done"));
        expect(server.requests[0].body).toEqual({
            userId: USER.id,
            token: "tok",
            newPassword: "a brand new passphrase",
        });
    });

    test("verify email runs at once and shows the outcome", async () => {
        const server = new FakeServer().on("POST /api/auth/verify-email", json(204));
        const dialog = showAccountLink(context(accountOn(server)), {
            kind: "verifyEmail",
            userId: USER.id,
            token: "tok",
        }).dialog;

        await rs.waitFor(() => expect(dialog.textContent).toContain("account.verify.doneSignIn"));
        expect(buttonOf(dialog, "account.signIn.submit")).not.toBeNull();
    });

    test("an expired link says so", async () => {
        const server = new FakeServer().on(
            "POST /api/auth/confirm-email-change",
            problem(400, "invalid_token"),
        );
        const dialog = showAccountLink(context(accountOn(server)), {
            kind: "confirmEmailChange",
            userId: USER.id,
            email: "new@example.test",
            token: "old",
        }).dialog;

        await rs.waitFor(() => expect(dialog.textContent).toContain("error.cloud.invalidToken"));
    });

    test("an incomplete link is invalid without asking the server", () => {
        const server = new FakeServer();
        const dialog = showAccountLink(context(accountOn(server)), {
            kind: "verifyEmail",
            userId: "",
            token: "",
        }).dialog;

        expect(dialog.textContent).toContain("error.cloud.invalidToken");
        expect(server.requests).toEqual([]);
    });
});

describe("startAccountUi", () => {
    const config = { version: "0.0.1", apiVersion: 1, features: FEATURES } as unknown as ConfigResponse;

    test("asks who is signed in, adds the account button, removes it on teardown", async () => {
        const server = new FakeServer().on("GET /api/me", problem(401, "unauthorized"));
        const connection = new CloudConnection(config, server.client());

        const stop = await startAccountUi(connection);
        try {
            expect(connection.account.status).toBe("signedOut");
            expect(TitleBar.items.items().some((item) => item instanceof AccountButton)).toBe(true);
        } finally {
            stop();
        }
        expect(TitleBar.items.items().some((item) => item instanceof AccountButton)).toBe(false);
    });

    test("opens the dialog of the link the app was opened with", async () => {
        const server = new FakeServer()
            .on("GET /api/me", problem(401, "unauthorized"))
            .on("POST /api/auth/verify-email", json(204));
        const stop = await startAccountUi(new CloudConnection(config, server.client()), {
            kind: "verifyEmail",
            userId: USER.id,
            token: "tok",
        });
        try {
            await rs.waitFor(() => expect(server.calls).toContain("POST /api/auth/verify-email"));
            expect(titleOf(top())).toBe("account.verify.title");
        } finally {
            stop();
        }
    });

    test("session expiry: the re-login dialog resumes the pending request after signing in", async () => {
        const server = new FakeServer().on("GET /api/me", json(200, USER));
        const connection = new CloudConnection(config, server.client());
        const stop = await startAccountUi(connection);
        try {
            server
                .on("GET /api/me/sessions", problem(401, "unauthorized"), json(200, []))
                .on("POST /api/auth/login", json(200, USER));
            const pending = connection.account.listSessions();

            await rs.waitFor(() => expect(titleOf(top())).toBe("account.reauth.title"));
            const dialog = top();
            expect(inputOf(dialog, "email").value).toBe(USER.email);
            expect(inputOf(dialog, "email").readOnly).toBe(true);
            type(dialog, "password", "secret-password");
            submit(dialog);

            expect((await pending).isOk).toBe(true);
            expect(connection.account.status).toBe("signedIn");
        } finally {
            stop();
        }
    });

    test("session expiry: 'not now' signs out on this device only", async () => {
        const server = new FakeServer().on("GET /api/me", json(200, USER));
        const connection = new CloudConnection(config, server.client());
        const stop = await startAccountUi(connection);
        try {
            server.on("GET /api/me/tokens", problem(401, "unauthorized"));
            const pending = connection.account.listAccessTokens();

            await rs.waitFor(() => expect(titleOf(top())).toBe("account.reauth.title"));
            buttonOf(top(), "account.reauth.later").click();

            expect((await pending).isOk).toBe(false);
            expect(connection.account.status).toBe("signedOut");
            expect(server.calls).not.toContain("POST /api/auth/logout");
        } finally {
            stop();
        }
    });
});

describe("AccountButton", () => {
    test("signed out: a discreet 'Sign in' that opens the dialog", async () => {
        const server = new FakeServer().on("GET /api/me", problem(401, "unauthorized"));
        const account = accountOn(server);
        await account.refresh();
        const button = new AccountButton(context(account));
        document.body.append(button);
        try {
            buttonOf(button, "account.signIn").click();
            expect(titleOf(top())).toBe("account.signIn.title");
        } finally {
            button.remove();
        }
    });

    test("signed in: initials, and a menu with name, email, settings and sign out", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/auth/logout", json(204));
        const button = new AccountButton(context(account));
        document.body.append(button);
        try {
            const avatar = button.querySelector("button");
            expect(avatar?.textContent).toBe("AL");
            avatar!.click();

            const menu = button.querySelector('[role="menu"]');
            expect(menu).not.toBeNull();
            expect(menu!.textContent).toContain(USER.displayName);
            expect(menu!.textContent).toContain(USER.email);
            expect(buttonOf(menu!, "account.menu.settings")).not.toBeNull();
            buttonOf(menu!, "account.menu.signOut").click();

            await rs.waitFor(() => expect(account.status).toBe("signedOut"));
            expect(server.calls).toEqual(["POST /api/auth/logout"]);
            expect(buttonOf(button, "account.signIn")).not.toBeNull();
        } finally {
            button.remove();
        }
    });

    test("unverified with verification required: says so and offers to resend", async () => {
        const server = new FakeServer().on("GET /api/me", json(200, { ...USER, emailVerified: false }));
        const account = accountOn(server);
        await account.refresh();
        const button = new AccountButton(context(account, { emailVerification: true }));
        document.body.append(button);
        try {
            button.querySelector("button")!.click();
            expect(button.textContent).toContain("account.menu.unverified");
            expect(buttonOf(button, "account.menu.resend")).not.toBeNull();
        } finally {
            button.remove();
        }
    });
});

describe("account settings", () => {
    const SESSION = {
        id: "s1",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
        ipAddress: "10.0.0.2",
        createdAt: "2026-09-20T08:00:00Z",
        lastSeenAt: "2026-09-27T12:34:00Z",
        expiresAt: "2026-10-27T12:34:00Z",
        current: true,
    };

    async function openSettings() {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server
            .on(
                "GET /api/me/sessions",
                json(200, [SESSION, { ...SESSION, id: "s2", current: false, userAgent: null }]),
            )
            .on("GET /api/me/tokens", json(200, []));
        const dialog = showAccountSettings(context(account)).dialog;
        await rs.waitFor(() => expect(dialog.querySelectorAll("[data-session-id]")).toHaveLength(2));
        return { server, account, dialog };
    }

    test("lists the sessions with the device and local times; revokes another one", async () => {
        const { server, dialog } = await openSettings();
        server.on("DELETE /api/me/sessions/s2", json(204));

        const current = dialog.querySelector('[data-session-id="s1"]')!;
        expect(current.textContent).toContain("account.session.deviceFirefoxLinux");
        expect(current.textContent).toContain("account.session.current");
        const lastSeenAt = parseUtc(SESSION.lastSeenAt);
        const time = current.querySelector<HTMLElement>("[data-relative-time]");
        expect(time).not.toBeNull();
        expect(time!.textContent).toBe(formatRelative(lastSeenAt));
        expect(time!.title).toBe(formatDateTime(lastSeenAt));
        expect(time!.title).not.toBe("");
        expect(current.textContent).toContain(`account.session.lastSeen${formatRelative(lastSeenAt)}`);
        expect(dialog.querySelector('[data-session-id="s2"]')!.textContent).toContain(
            "account.session.unknownDevice",
        );

        buttonOf(dialog.querySelector('[data-session-id="s2"]')!, "account.session.revoke").click();

        await rs.waitFor(() => expect(dialog.querySelector('[data-session-id="s2"]')).toBeNull());
        expect(server.calls).toContain("DELETE /api/me/sessions/s2");
    });

    test("the danger zone is collapsed", async () => {
        const { dialog } = await openSettings();

        const details = dialog.querySelector("details");
        expect(details).not.toBeNull();
        expect(details!.open).toBe(false);
        expect(details!.textContent).toContain("account.delete.title");
    });

    test("'keep offline copies' is a device setting", async () => {
        const { account, dialog } = await openSettings();
        const box = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
            (b) => b.parentElement?.textContent?.includes("account.settings.keepOfflineCopies"),
        );
        expect(box).toBeInstanceOf(HTMLInputElement);
        expect(box!.checked).toBe(false);

        box!.checked = true;
        box!.dispatchEvent(new Event("change"));

        expect(account.deviceSettings.keepOfflineCopies).toBe(true);
    });

    test("Enter in the display name saves that section and keeps the settings open", async () => {
        const { server, account, dialog } = await openSettings();
        server.on("PATCH /api/me", json(200, { ...USER, displayName: "Ada L." }));
        const name = inputOf(dialog, "displayName");
        name.value = "Ada L.";

        const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true });
        name.dispatchEvent(enter);
        submit(dialog);

        expect(enter.defaultPrevented).toBe(true);
        await rs.waitFor(() => expect(account.user?.displayName).toBe("Ada L."));
        expect(server.requests.find((r) => r.method === "PATCH")?.body).toEqual({ displayName: "Ada L." });
        expect(dialog.isConnected).toBe(true);
        const close = Array.from(dialog.querySelectorAll("button")).find(
            (b) => b.textContent === "common.close",
        );
        expect(close?.type).toBe("button");
    });

    test("the device name and where new documents go are device settings", async () => {
        const { account, dialog } = await openSettings();
        const name = inputOf(dialog, "deviceName");
        expect(name.placeholder).not.toBe("");

        name.value = "Desk – Firefox";
        name.dispatchEvent(new Event("change"));
        const box = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
            (b) => b.parentElement?.textContent?.includes("account.settings.newDocumentsInCloud"),
        );
        expect(box).toBeInstanceOf(HTMLInputElement);
        expect(box!.checked).toBe(true);
        box!.checked = false;
        box!.dispatchEvent(new Event("change"));

        expect(account.deviceSettings.deviceName).toBe("Desk – Firefox");
        expect(account.deviceSettings.newDocumentLocation).toBe("local");
    });

    test("download my data saves the ZIP", async () => {
        const { server, dialog } = await openSettings();
        server.on("GET /api/me/export", new Response(new Blob(["PK"]), { status: 200 }));
        const created = rs
            .spyOn(URL, "createObjectURL")
            .mockImplementation((_blob: Blob | MediaSource) => "blob:export");
        rs.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const clicked = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

        buttonOf(dialog, "account.export.submit").click();

        await rs.waitFor(() => expect(clicked).toHaveBeenCalledTimes(1));
        expect(created).toHaveBeenCalledTimes(1);
        expect(dialog.textContent).toContain("account.export.done");
    });

    test("an access token's secret is shown once after creating it", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on(
            "POST /api/me/tokens",
            json(201, {
                token: "spicy_pat_s3cret",
                id: "t1",
                name: "Laptop",
                prefix: "spicy_pat_s3",
                scopes: ["mcp:read"],
                createdAt: "2026-09-27T10:00:00Z",
                expiresAt: "2026-12-26T10:00:00Z",
            }),
        );
        const created = rs.fn(() => {});
        const dialog = showCreateToken(context(account), created).dialog;

        type(dialog, "name", "Laptop");
        type(dialog, "currentPassword", "pw");
        submit(dialog);

        await rs.waitFor(() =>
            expect(dialog.querySelector("[data-secret]")?.textContent).toBe("spicy_pat_s3cret"),
        );
        expect(server.requests[0].body).toEqual({
            name: "Laptop",
            scopes: ["mcp:read"],
            expiresInDays: 90,
            currentPassword: "pw",
        });
        expect(created).toHaveBeenCalledTimes(1);
        expect(dialog.textContent).toContain("account.token.createdOnce");
        // No relay endpoint in this context: no MCP configs.
        expect(dialog.querySelector("[data-mcp-config]")).toBeNull();
    });

    test("an MCP token created with the relay on shows the client configs filled in", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on(
            "POST /api/me/tokens",
            json(201, {
                token: "spicy_pat_s3cret",
                id: "t1",
                name: "Laptop",
                prefix: "spicy_pat_s3",
                scopes: ["mcp:read", "mcp:write"],
                createdAt: "2026-09-27T10:00:00Z",
                expiresAt: null,
            }),
        );
        const ctx = { ...context(account), mcpEndpoint: "https://spicy.lan/mcp" };
        const dialog = showCreateToken(ctx, () => {}, { scopes: ["mcp:read", "mcp:write"] }).dialog;

        type(dialog, "name", "Laptop");
        type(dialog, "currentPassword", "pw");
        submit(dialog);

        await rs.waitFor(() => expect(dialog.querySelector("[data-mcp-config]")).not.toBeNull());
        expect(server.requests[0].body).toMatchObject({ scopes: ["mcp:read", "mcp:write"] });
        const configs = Array.from(dialog.querySelectorAll<HTMLElement>("[data-mcp-config]"));
        expect(configs.map((c) => c.dataset["mcpConfig"])).toEqual(["claudeCode", "http", "stdio"]);
        // The command reads the token from the environment: it never enters the shell history.
        expect(configs[0].textContent).toBe(
            'claude mcp add --transport http spicy3d https://spicy.lan/mcp --header "Authorization: Bearer $SPICY3D_TOKEN"',
        );
        expect(dialog.textContent).toContain("mcp.remote.shellHistoryHint");
        expect(JSON.parse(configs[1].textContent ?? "").mcpServers.spicy3d.headers).toEqual({
            Authorization: "Bearer spicy_pat_s3cret",
        });
        expect(JSON.parse(configs[2].textContent ?? "").mcpServers.spicy3d.env).toEqual({
            SPICY3D_TOKEN: "spicy_pat_s3cret",
        });
        // Shown once, kept nowhere (CLOUD-17): no browser storage holds the secret.
        const stored = (storage: Storage) =>
            Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i)!) ?? "").join(
                "\n",
            );
        expect(stored(localStorage)).not.toContain("spicy_pat_s3cret");
        expect(stored(sessionStorage)).not.toContain("spicy_pat_s3cret");
        // Closing the dialog removes it from the page.
        dialog.close();
        dialog.remove();
        expect(document.body.textContent).not.toContain("spicy_pat_s3cret");
    });

    test("delete account: the typed email must match; then the account is deleted and signed out", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        server.on("POST /api/me/delete", json(204));
        const dialog = showDeleteAccount(context(account)).dialog;

        type(dialog, "confirmEmail", "someone@else.test");
        type(dialog, "currentPassword", "pw");
        submit(dialog);
        expect(dialog.textContent).toContain("account.delete.emailMismatch");
        expect(server.requests).toEqual([]);
        await idle(dialog);

        type(dialog, "confirmEmail", USER.email.toUpperCase());
        submit(dialog);

        await rs.waitFor(() => expect(dialog.isConnected).toBe(false));
        expect(server.requests[0].body).toEqual({ currentPassword: "pw" });
        expect(account.status).toBe("signedOut");
        expect(published).toContainEqual(["showToast", ["account.delete.done"]]);
    });
});
