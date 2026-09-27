// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    download,
    formatDateTime,
    I18n,
    type I18nKeys,
    PubSub,
    parseUtc,
    relativeTimeParts,
    watchRelativeTimes,
} from "@spicy3d/core";
import { button, div, h3, li, option, select, span, ul } from "@spicy3d/element";
import type { AccessToken, AccountSession } from "../account/account";
import { DEVICE_NAME_MAX_LENGTH, defaultDeviceName } from "../account/deviceSettings";
import { describeUserAgent } from "../account/userAgent";
import { type CloudError, cloudErrorMessage, fieldErrorMessages } from "../problem";
import style from "./account.module.css";
import type { AccountUiContext } from "./authDialogs";
import { resendVerification } from "./authDialogs";
import {
    checkbox,
    type Field,
    newPasswordField,
    notice,
    paragraph,
    requireFilled,
    showCloudError,
    textField,
} from "./forms";
import { confirmModal, Modal } from "./modal";

/** The scopes a personal access token can have (SpicySrv `AccessTokenScopes`). */
export const TOKEN_SCOPES: { scope: string; label: I18nKeys }[] = [
    { scope: "mcp:read", label: "account.token.scope.mcpRead" },
    { scope: "mcp:write", label: "account.token.scope.mcpWrite" },
    { scope: "documents:read", label: "account.token.scope.documentsRead" },
];

/** The expiries the server accepts, in days; 0 = never. */
export const TOKEN_EXPIRIES = [30, 90, 365, 0] as const;

/**
 * Sections other modules add to the account settings, between the account's own sections and the
 * privacy zone — e.g. the autosave interval (CLOUD-07). Rendered each time the dialog opens.
 */
export interface AccountSettingsSection {
    id: string;
    title: I18nKeys;
    render(ctx: AccountUiContext): HTMLElement;
}

export const AccountSettingsSections: AccountSettingsSection[] = [];

function section(title: I18nKeys, ...content: Node[]): HTMLElement {
    return div({ className: style.section }, h3({ textContent: I18n.translate(title) }), ...content);
}

function smallButton(label: I18nKeys, onclick: () => void | Promise<void>, kind?: "primary" | "danger") {
    const b = button({
        type: "button",
        className: kind ? `${style.button} ${style[kind]}` : style.button,
        textContent: I18n.translate(label),
    });
    b.onclick = async (e) => {
        e.preventDefault();
        b.disabled = true;
        try {
            await onclick();
        } finally {
            b.disabled = false;
        }
    };
    return b;
}

/**
 * Enter in `input` runs its section's button instead of submitting the settings dialog (which
 * holds every section in one form).
 */
function submitOnEnter(input: HTMLInputElement, action: HTMLButtonElement) {
    input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (!action.disabled) action.click();
    });
}

/** An inline status line under a section (success notice or error). */
function statusLine() {
    const el = div({});
    return {
        el,
        ok(key: I18nKeys, ...args: unknown[]) {
            el.replaceChildren(notice(key, ...args));
        },
        error(error: CloudError) {
            const message = div({ className: style.error, textContent: cloudErrorMessage(error) });
            message.setAttribute("role", "alert");
            el.replaceChildren(message);
        },
        clear() {
            el.replaceChildren();
        },
    };
}

/** `2026-09-27T14:05:00Z` → local date and time; empty when the server sent no usable time. */
export function formatServerTime(iso: string | null | undefined): string {
    return iso ? formatDateTime(parseUtc(iso)) : "";
}

export function describeSession(session: AccountSession): string {
    const device = describeUserAgent(session.userAgent);
    if (device.browser && device.os)
        return I18n.translate("account.session.device{0}{1}", device.browser, device.os);
    return device.browser ?? device.os ?? I18n.translate("account.session.unknownDevice");
}

// ---- The dialog ------------------------------------------------------------------------------

export function showAccountSettings(ctx: AccountUiContext): Modal {
    const modal: Modal = new Modal({
        title: "account.settings.title",
        wide: true,
        content: [
            profileSection(ctx),
            emailSection(ctx),
            passwordSection(ctx),
            sessionsSection(ctx, () => modal),
            tokensSection(ctx),
            deviceSection(ctx),
            ...AccountSettingsSections.map((extra) => {
                const el = section(extra.title, extra.render(ctx));
                el.dataset["section"] = extra.id;
                return el;
            }),
            privacyZone(ctx, () => modal),
        ],
        // Not a submit action: Enter in a section's field submits that section (see submitOnEnter),
        // never the whole dialog, so it can't close with the typed value unsaved.
        actions: [{ label: "common.close" }],
    });
    // Signed out meanwhile (another tab, revoked session, deletion): nothing here applies anymore.
    const onStatus = (property: string | number | symbol) => {
        if (property === "status" && !ctx.account.isSignedIn && ctx.account.status !== "expired")
            modal.close();
    };
    ctx.account.onPropertyChanged(onStatus);
    const stopRelativeTimes = watchRelativeTimes(modal.body);
    modal.onClosed(() => {
        ctx.account.removePropertyChanged(onStatus);
        stopRelativeTimes();
    });
    return modal.open();
}

function profileSection(ctx: AccountUiContext) {
    const nameField = textField({
        label: "account.field.displayName",
        name: "displayName",
        autocomplete: "name",
        value: ctx.account.user?.displayName ?? "",
        maxLength: 100,
    });
    const status = statusLine();
    const save = smallButton("common.save", async () => {
        status.clear();
        if (!requireFilled(nameField)) return;
        const result = await ctx.account.updateDisplayName(nameField.value.trim());
        if (result.isOk) {
            nameField.setError(undefined);
            status.ok("account.settings.displayNameSaved");
        } else {
            const field = fieldError(result.error, "displayName");
            if (field) nameField.setError(field);
            else status.error(result.error);
        }
    });
    submitOnEnter(nameField.input, save);
    return section(
        "account.settings.profile",
        nameField.root,
        div({ className: style.row }, save),
        status.el,
    );
}

/** The translated validation errors of one field, if the server rejected that field. */
function fieldError(error: CloudError, name: string): string | undefined {
    return fieldErrorMessages(error)[name]?.join(" ");
}

function emailSection(ctx: AccountUiContext) {
    const user = ctx.account.user;
    const verified = user?.emailVerified ?? false;
    const badge = span({
        className: style.badge,
        textContent: I18n.translate(
            verified ? "account.settings.emailVerified" : "account.settings.emailUnverified",
        ),
    });
    const row = div({ className: style.row }, span({ textContent: user?.email ?? "" }), badge);
    const buttons = div({ className: style.row });
    if (!verified && ctx.features.email) {
        buttons.append(smallButton("account.menu.resend", () => resendVerification(ctx)));
    }
    buttons.append(smallButton("account.settings.changeEmail", () => void showChangeEmail(ctx)));
    return section("account.settings.email", row, buttons);
}

function showChangeEmail(ctx: AccountUiContext): Modal {
    const emailField = textField({ label: "account.field.newEmail", name: "newEmail", type: "email" });
    const passwordField = textField({
        label: "account.field.currentPassword",
        name: "currentPassword",
        type: "password",
        autocomplete: "current-password",
    });
    const modal: Modal = new Modal({
        title: "account.settings.changeEmail",
        content: [paragraph("account.settings.emailChangeNotice"), emailField.root, passwordField.root],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.settings.changeEmail",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(emailField, passwordField)) return false;
                    const newEmail = emailField.value.trim();
                    const result = await ctx.account.changeEmail(newEmail, passwordField.value);
                    if (!result.isOk) {
                        return showCloudError(modal, result.error, {
                            newEmail: emailField,
                            email: emailField,
                            currentPassword: passwordField,
                        });
                    }
                    modal.show({
                        title: "account.settings.changeEmail",
                        content: [
                            result.value.status === "applied"
                                ? notice("account.settings.emailApplied")
                                : notice("account.settings.emailConfirmationSent{0}", newEmail),
                        ],
                        actions: [{ label: "common.close", submit: true }],
                    });
                    return false;
                },
            },
        ],
    });
    return modal.open();
}

function passwordSection(ctx: AccountUiContext) {
    return section(
        "account.settings.password",
        div(
            { className: style.row },
            smallButton("account.settings.changePassword", () => void showChangePassword(ctx)),
        ),
    );
}

function showChangePassword(ctx: AccountUiContext): Modal {
    const currentField = textField({
        label: "account.field.currentPassword",
        name: "currentPassword",
        type: "password",
        autocomplete: "current-password",
    });
    const newField = newPasswordField({ label: "account.field.newPassword", name: "newPassword" }, () => [
        ctx.account.user?.email ?? "",
        ctx.account.user?.displayName ?? "",
    ]);
    const repeatField = textField({
        label: "account.field.confirmPassword",
        name: "confirmPassword",
        type: "password",
        autocomplete: "new-password",
    });
    const modal: Modal = new Modal({
        title: "account.settings.changePassword",
        content: [
            paragraph("account.settings.passwordChangeNotice"),
            currentField.root,
            newField.root,
            repeatField.root,
        ],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.settings.changePassword",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(currentField, newField, repeatField)) return false;
                    if (newField.value !== repeatField.value) {
                        repeatField.setError(I18n.translate("account.passwordMismatch"));
                        return false;
                    }
                    const result = await ctx.account.changePassword(currentField.value, newField.value);
                    if (!result.isOk) {
                        return showCloudError(modal, result.error, {
                            currentPassword: currentField,
                            newPassword: newField,
                        });
                    }
                    PubSub.default.pub("showToast", "account.settings.passwordChanged");
                    return undefined;
                },
            },
        ],
    });
    return modal.open();
}

// ---- Sessions --------------------------------------------------------------------------------

function sessionsSection(ctx: AccountUiContext, settings: () => Modal) {
    const list = ul({ className: style.list });
    const status = statusLine();
    const load = async () => {
        const result = await ctx.account.listSessions();
        if (!result.isOk) {
            status.error(result.error);
            return;
        }
        status.clear();
        list.replaceChildren(...result.value.map((session) => sessionItem(session)));
    };
    const sessionItem = (session: AccountSession) => {
        const title = div({ className: style.itemTitle, textContent: describeSession(session) });
        if (session.current) {
            title.append(
                " ",
                span({ className: style.badge, textContent: I18n.translate("account.session.current") }),
            );
        }
        const item = li(
            { className: style.item },
            div(
                {},
                title,
                span(
                    { className: style.muted },
                    ...relativeTimeParts(
                        (time) => I18n.translate("account.session.lastSeen{0}", time),
                        parseUtc(session.lastSeenAt),
                    ),
                ),
                span({
                    className: style.muted,
                    textContent: I18n.translate(
                        "account.session.signedIn{0}",
                        formatServerTime(session.createdAt),
                    ),
                }),
            ),
            smallButton("account.session.revoke", async () => {
                const result = await ctx.account.revokeSession(session);
                if (!result.isOk) {
                    status.error(result.error);
                    return;
                }
                if (session.current) settings().close();
                else item.remove();
            }),
        );
        item.dataset["sessionId"] = session.id;
        return item;
    };
    void load();
    return section("account.settings.sessions", list, status.el);
}

// ---- Access tokens ---------------------------------------------------------------------------

function tokensSection(ctx: AccountUiContext) {
    const list = ul({ className: style.list });
    const status = statusLine();
    const load = async () => {
        const result = await ctx.account.listAccessTokens();
        if (!result.isOk) {
            status.error(result.error);
            return;
        }
        status.clear();
        list.replaceChildren(
            ...(result.value.length === 0
                ? [li({ className: style.muted, textContent: I18n.translate("account.token.empty") })]
                : result.value.map((token) => tokenItem(token))),
        );
    };
    const tokenItem = (token: AccessToken) => {
        const expiresAt = token.expiresAt ? parseUtc(token.expiresAt) : undefined;
        const expired = expiresAt !== undefined && expiresAt <= Date.now();
        const title = div({ className: style.itemTitle, textContent: token.name });
        if (expired)
            title.append(
                " ",
                span({ className: style.badge, textContent: I18n.translate("account.token.expired") }),
            );
        const item = li(
            { className: style.item },
            div(
                {},
                title,
                span({
                    className: style.muted,
                    textContent: `${token.prefix}… · ${token.scopes.join(", ")}`,
                }),
                span(
                    { className: style.muted },
                    I18n.translate("account.token.createdAt{0}", formatServerTime(token.createdAt)),
                    " · ",
                    ...(token.lastUsedAt
                        ? relativeTimeParts(
                              (time) => I18n.translate("account.token.lastUsed{0}", time),
                              parseUtc(token.lastUsedAt),
                          )
                        : [I18n.translate("account.token.neverUsed")]),
                    " · ",
                    token.expiresAt
                        ? I18n.translate("account.token.expires{0}", formatServerTime(token.expiresAt))
                        : I18n.translate("account.token.noExpiry"),
                ),
            ),
            smallButton("account.token.revoke", async () => {
                const confirmed = await confirmModal(
                    "account.token.revoke",
                    I18n.translate("account.token.revokeConfirm{0}", token.name),
                    "account.token.revoke",
                    "danger",
                );
                if (!confirmed) return;
                const result = await ctx.account.revokeAccessToken(token.id);
                if (result.isOk) item.remove();
                else status.error(result.error);
            }),
        );
        item.dataset["tokenId"] = token.id;
        return item;
    };
    void load();
    return section(
        "account.settings.tokens",
        paragraph("account.settings.tokensIntro"),
        list,
        div(
            { className: style.row },
            smallButton("account.token.create", () => void showCreateToken(ctx, load)),
        ),
        status.el,
    );
}

export function showCreateToken(ctx: AccountUiContext, onCreated: () => void): Modal {
    const nameField = textField({ label: "account.token.name", name: "name", maxLength: 100 });
    const scopes = TOKEN_SCOPES.map((s) => ({ ...s, box: checkbox(s.label, s.scope === "mcp:read") }));
    const expiry = select(
        {},
        ...TOKEN_EXPIRIES.map((days) =>
            option({
                value: String(days),
                textContent:
                    days === 0
                        ? I18n.translate("account.token.expiry.never")
                        : I18n.translate("account.token.expiry.days{0}", days),
                selected: days === 90,
            }),
        ),
    );
    const scopesError = span({ className: style.fieldError });
    const passwordField = textField({
        label: "account.field.currentPassword",
        name: "currentPassword",
        type: "password",
        autocomplete: "current-password",
    });
    const scopesField: Field = {
        root: scopesError,
        input: document.createElement("input"),
        value: "",
        setError: (message) => {
            scopesError.textContent = message ?? "";
        },
    };

    const modal: Modal = new Modal({
        title: "account.token.create",
        content: [
            nameField.root,
            div(
                { className: style.field },
                span({ textContent: I18n.translate("account.token.scopes") }),
                ...scopes.map((s) => s.box.root),
                scopesError,
            ),
            div(
                { className: style.field },
                span({ textContent: I18n.translate("account.token.expiry") }),
                expiry,
            ),
            passwordField.root,
        ],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.token.create",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(nameField, passwordField)) return false;
                    const chosen = scopes.filter((s) => s.box.input.checked).map((s) => s.scope);
                    scopesField.setError(
                        chosen.length === 0 ? I18n.translate("error.cloud.field.scopesRequired") : undefined,
                    );
                    if (chosen.length === 0) return false;
                    const result = await ctx.account.createAccessToken({
                        name: nameField.value.trim(),
                        scopes: chosen,
                        expiresInDays: Number(expiry.value),
                        currentPassword: passwordField.value,
                    });
                    if (!result.isOk) {
                        return showCloudError(modal, result.error, {
                            name: nameField,
                            scopes: scopesField,
                            currentPassword: passwordField,
                        });
                    }
                    onCreated();
                    showSecret(modal, result.value.token);
                    return false;
                },
            },
        ],
    });
    return modal.open();
}

/** The one time the secret is visible: the server keeps only its hash. */
function showSecret(modal: Modal, secret: string) {
    const copied = div({});
    const secretEl = div({ className: style.secret, textContent: secret });
    secretEl.dataset["secret"] = "";
    modal.show({
        title: "account.token.create",
        content: [
            notice("account.token.createdOnce"),
            secretEl,
            div(
                { className: style.row },
                smallButton("account.token.copy", async () => {
                    try {
                        await navigator.clipboard.writeText(secret);
                        copied.replaceChildren(paragraph("account.token.copied"));
                    } catch {
                        copied.replaceChildren(paragraph("account.token.copyFailed"));
                    }
                }),
                copied,
            ),
        ],
        actions: [{ label: "common.close", submit: true }],
    });
}

// ---- This device -----------------------------------------------------------------------------

function deviceSection(ctx: AccountUiContext) {
    const settings = ctx.account.deviceSettings;
    const deviceName = textField({
        label: "account.settings.deviceName",
        name: "deviceName",
        value: settings.deviceName,
        maxLength: DEVICE_NAME_MAX_LENGTH,
    });
    deviceName.input.placeholder = defaultDeviceName();
    deviceName.input.onchange = () => {
        settings.deviceName = deviceName.input.value;
    };
    deviceName.input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        settings.deviceName = deviceName.input.value;
    });
    const newInCloud = checkbox(
        "account.settings.newDocumentsInCloud",
        settings.newDocumentLocation === "cloud",
    );
    newInCloud.input.onchange = () => {
        settings.newDocumentLocation = newInCloud.input.checked ? "cloud" : "local";
    };
    const keep = checkbox("account.settings.keepOfflineCopies", settings.keepOfflineCopies);
    keep.input.onchange = () => {
        settings.keepOfflineCopies = keep.input.checked;
    };
    return section(
        "account.settings.device",
        deviceName.root,
        paragraph("account.settings.deviceNameHint"),
        newInCloud.root,
        keep.root,
        paragraph("account.settings.keepOfflineCopiesHint"),
    );
}

// ---- Privacy / danger zone -------------------------------------------------------------------

function privacyZone(ctx: AccountUiContext, settings: () => Modal) {
    const details = document.createElement("details");
    details.className = style.dangerZone;
    const summary = document.createElement("summary");
    summary.textContent = I18n.translate("account.privacy.title");
    details.append(summary, div({}, exportBlock(ctx), deleteBlock(ctx, settings)));
    return details;
}

function exportBlock(ctx: AccountUiContext) {
    const history = checkbox("account.export.history");
    const status = statusLine();
    const run = smallButton("account.export.submit", async () => {
        status.ok("account.export.preparing");
        const result = await ctx.account.exportData(history.input.checked);
        if (!result.isOk) {
            status.error(result.error);
            return;
        }
        download([result.value.data], result.value.fileName);
        status.ok("account.export.done");
    });
    return div(
        { className: style.section },
        h3({ textContent: I18n.translate("account.export.title") }),
        paragraph("account.export.intro"),
        history.root,
        div({ className: style.row }, run),
        status.el,
    );
}

function deleteBlock(ctx: AccountUiContext, settings: () => Modal) {
    return div(
        { className: style.section },
        h3({ textContent: I18n.translate("account.delete.title") }),
        paragraph("account.delete.intro"),
        div(
            { className: style.row },
            smallButton("account.delete.title", () => void showDeleteAccount(ctx, settings), "danger"),
        ),
    );
}

export function showDeleteAccount(ctx: AccountUiContext, settings?: () => Modal): Modal {
    const email = ctx.account.user?.email ?? "";
    const emailField = textField({
        label: "account.delete.typeEmail{0}",
        labelArgs: [email],
        name: "confirmEmail",
        type: "email",
        autocomplete: "off",
    });
    const passwordField = textField({
        label: "account.field.currentPassword",
        name: "currentPassword",
        type: "password",
        autocomplete: "current-password",
    });
    const modal: Modal = new Modal({
        title: "account.delete.title",
        content: [notice("account.delete.intro"), emailField.root, passwordField.root],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.delete.submit",
                kind: "danger",
                submit: true,
                run: async () => {
                    if (!requireFilled(emailField, passwordField)) return false;
                    if (emailField.value.trim().toLowerCase() !== email.toLowerCase()) {
                        emailField.setError(I18n.translate("account.delete.emailMismatch"));
                        return false;
                    }
                    const result = await ctx.account.deleteAccount(passwordField.value);
                    if (!result.isOk)
                        return showCloudError(modal, result.error, { currentPassword: passwordField });
                    settings?.().close();
                    PubSub.default.pub("showToast", "account.delete.done");
                    return undefined;
                },
            },
        ],
    });
    return modal.open();
}
