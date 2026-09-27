// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, PubSub } from "@spicy3d/core";
import { div } from "@spicy3d/element";
import type { Account } from "../account/account";
import { PASSWORD_MAX_LENGTH } from "../account/passwordStrength";
import type { ApiSchema } from "../api";
import { type AccountLink, isCompleteAccountLink } from "../links";
import { cloudErrorMessage } from "../problem";
import style from "./account.module.css";
import {
    checkbox,
    type Field,
    linkButton,
    newPasswordField,
    notice,
    noticeText,
    paragraph,
    requireFilled,
    showCloudError,
    textField,
} from "./forms";
import { Modal } from "./modal";

export type FeatureFlags = ApiSchema<"FeatureFlags">;

/** What the account dialogs need: the account and what the server can do. */
export interface AccountUiContext {
    account: Account;
    features: FeatureFlags;
    /** The relay's MCP endpoint when the server has it on: a new token then shows client configs. */
    mcpEndpoint?: string;
}

function welcome(ctx: AccountUiContext) {
    const user = ctx.account.user;
    if (!user) return;
    // One toast: a second one would replace the first at once.
    if (!user.emailVerified && ctx.features.emailVerification) {
        PubSub.default.pub("showToast", "account.welcomeUnverified{0}", user.displayName);
    } else {
        PubSub.default.pub("showToast", "account.welcome{0}", user.displayName);
    }
}

// ---- Sign in ---------------------------------------------------------------------------------

export function showSignIn(ctx: AccountUiContext, email = ""): Modal {
    const emailField = textField({
        label: "account.field.email",
        name: "email",
        type: "email",
        autocomplete: "username",
        value: email,
    });
    const passwordField = textField({
        label: "account.field.password",
        name: "password",
        type: "password",
        autocomplete: "current-password",
    });

    const extras: HTMLElement[] = [];
    if (ctx.features.email) {
        extras.push(
            div(
                { className: style.row },
                linkButton("account.signIn.forgot", () => {
                    modal.close();
                    showForgotPassword(ctx, emailField.value);
                }),
            ),
        );
    } else {
        extras.push(paragraph("account.signIn.forgotNoEmail"));
    }
    if (ctx.features.signup) {
        extras.push(
            div(
                { className: style.row },
                paragraph("account.signIn.noAccount"),
                linkButton("account.signIn.createAccount", () => {
                    modal.close();
                    showSignUp(ctx, emailField.value);
                }),
            ),
        );
    }

    const modal: Modal = new Modal({
        title: "account.signIn.title",
        content: [emailField.root, passwordField.root, ...extras],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.signIn.submit",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(emailField, passwordField)) return false;
                    const result = await ctx.account.signIn(emailField.value.trim(), passwordField.value);
                    if (!result.isOk) {
                        passwordField.input.value = "";
                        return showCloudError(modal, result.error, {
                            email: emailField,
                            password: passwordField,
                        });
                    }
                    welcome(ctx);
                    return undefined;
                },
            },
        ],
    });
    return modal.open();
}

// ---- Sign up ---------------------------------------------------------------------------------

export function showSignUp(ctx: AccountUiContext, email = ""): Modal {
    const emailField = textField({
        label: "account.field.email",
        name: "email",
        type: "email",
        autocomplete: "email",
        value: email,
    });
    const nameField = textField({
        label: "account.field.displayName",
        name: "displayName",
        autocomplete: "name",
        maxLength: 100,
    });
    const passwordField = newPasswordField({ label: "account.field.password", name: "password" }, () => [
        emailField.value,
        nameField.value,
    ]);
    const privacy = checkbox("account.signUp.acceptPrivacy");
    const fields: Record<string, Field> = {
        email: emailField,
        displayName: nameField,
        password: passwordField,
    };

    const modal: Modal = new Modal({
        title: "account.signUp.title",
        content: [
            emailField.root,
            nameField.root,
            passwordField.root,
            notice("account.signUp.privacy"),
            privacy.root,
            div(
                { className: style.row },
                paragraph("account.signUp.haveAccount"),
                linkButton("account.signIn.submit", () => {
                    modal.close();
                    showSignIn(ctx, emailField.value);
                }),
            ),
        ],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.signUp.submit",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(emailField, nameField, passwordField)) return false;
                    if (!privacy.input.checked) {
                        modal.showError(I18n.translate("account.signUp.privacyRequired"));
                        return false;
                    }
                    const request = {
                        email: emailField.value.trim(),
                        displayName: nameField.value.trim(),
                        password: passwordField.value,
                    };
                    const result = await ctx.account.signUp(request);
                    if (!result.isOk) return showCloudError(modal, result.error, fields);
                    if (result.value.status === "signedIn") {
                        welcome(ctx);
                        return undefined;
                    }
                    showCheckInbox(ctx, modal, request.email, request.password);
                    return false;
                },
            },
        ],
    });
    return modal.open();
}

/**
 * After a sign-up that needs a verified email. Unverified users can sign in (cloud storage waits for
 * the verification), which is what resending needs: the server resends to the signed-in user only.
 */
function showCheckInbox(ctx: AccountUiContext, modal: Modal, email: string, password: string) {
    const status = div({});
    const actions: ConstructorParameters<typeof Modal>[0]["actions"] = [{ label: "common.close" }];
    if (ctx.features.email) {
        actions.unshift({
            label: "account.signUp.resend",
            run: async () => {
                if (!ctx.account.isSignedIn) {
                    const signedIn = await ctx.account.signIn(email, password);
                    if (!signedIn.isOk) return showCloudError(modal, signedIn.error);
                }
                const resent = await ctx.account.resendVerification();
                if (!resent.isOk) return showCloudError(modal, resent.error);
                modal.showError(undefined);
                status.replaceChildren(notice("account.signUp.resent"));
                return false;
            },
        });
    }
    const content = [paragraph("account.signUp.checkInbox{0}", email), status];
    // Verification required but no email to send it with: only the administrator can help.
    if (!ctx.features.email) content.push(notice("error.cloud.emailDisabled"));
    modal.show({ title: "account.signUp.checkInbox.title", content, actions });
}

/** From the account menu: a signed-in, unverified user asks for a new link. */
export async function resendVerification(ctx: AccountUiContext): Promise<void> {
    const result = await ctx.account.resendVerification();
    if (result.isOk) {
        PubSub.default.pub("showToast", "account.verificationSent{0}", ctx.account.user?.email ?? "");
    } else {
        PubSub.default.pub("displayError", cloudErrorMessage(result.error));
    }
}

// ---- Forgot / reset password -----------------------------------------------------------------

export function showForgotPassword(ctx: AccountUiContext, email = ""): Modal {
    const emailField = textField({
        label: "account.field.email",
        name: "email",
        type: "email",
        autocomplete: "username",
        value: email,
    });
    const modal: Modal = new Modal({
        title: "account.forgot.title",
        content: [paragraph("account.forgot.intro"), emailField.root],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.forgot.submit",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(emailField)) return false;
                    const address = emailField.value.trim();
                    const result = await ctx.account.forgotPassword(address);
                    if (!result.isOk) return showCloudError(modal, result.error, { email: emailField });
                    modal.show({
                        title: "account.forgot.title",
                        content: [notice("account.forgot.sent{0}", address)],
                        actions: [{ label: "common.close" }],
                    });
                    return false;
                },
            },
        ],
    });
    return modal.open();
}

function invalidLinkModal(title: I18nKeys): Modal {
    return new Modal({
        title,
        content: [notice("error.cloud.invalidToken")],
        actions: [{ label: "common.close" }],
    }).open();
}

export function showResetPassword(
    ctx: AccountUiContext,
    link: Extract<AccountLink, { kind: "resetPassword" }>,
) {
    if (!isCompleteAccountLink(link)) return invalidLinkModal("account.reset.title");

    const passwordField = newPasswordField({ label: "account.field.newPassword", name: "newPassword" });
    const repeatField = textField({
        label: "account.field.confirmPassword",
        name: "confirmPassword",
        type: "password",
        autocomplete: "new-password",
        maxLength: PASSWORD_MAX_LENGTH,
    });
    const modal: Modal = new Modal({
        title: "account.reset.title",
        content: [passwordField.root, repeatField.root],
        actions: [
            { label: "common.cancel" },
            {
                label: "account.reset.submit",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(passwordField, repeatField)) return false;
                    if (passwordField.value !== repeatField.value) {
                        repeatField.setError(I18n.translate("account.passwordMismatch"));
                        return false;
                    }
                    const result = await ctx.account.resetPassword(
                        link.userId,
                        link.token,
                        passwordField.value,
                    );
                    if (!result.isOk)
                        return showCloudError(modal, result.error, { newPassword: passwordField });
                    modal.show({
                        title: "account.reset.title",
                        content: [notice("account.reset.done")],
                        actions: [
                            { label: "common.close" },
                            {
                                label: "account.signIn.submit",
                                kind: "primary",
                                submit: true,
                                run: () => {
                                    showSignIn(ctx);
                                    return undefined;
                                },
                            },
                        ],
                    });
                    return false;
                },
            },
        ],
    });
    return modal.open();
}

// ---- Verify email / confirm email change (links) ---------------------------------------------

/** A link that works without input: the request runs at once, the dialog shows its outcome. */
function linkOutcomeModal(
    ctx: AccountUiContext,
    title: "account.verify.title" | "account.emailChange.title",
    run: () => Promise<HTMLElement>,
    signInEmail: () => string | undefined,
): Modal {
    const modal: Modal = new Modal({
        title,
        content: [paragraph("account.link.working")],
        actions: [{ label: "common.close" }],
    }).open();
    void run().then((outcome) => {
        const email = signInEmail();
        modal.show({
            title,
            content: [outcome],
            actions:
                email === undefined
                    ? [{ label: "common.close" }]
                    : [
                          { label: "common.close" },
                          {
                              label: "account.signIn.submit",
                              kind: "primary",
                              submit: true,
                              run: () => {
                                  showSignIn(ctx, email);
                                  return undefined;
                              },
                          },
                      ],
        });
    });
    return modal;
}

export function showVerifyEmail(ctx: AccountUiContext, link: Extract<AccountLink, { kind: "verifyEmail" }>) {
    if (!isCompleteAccountLink(link)) return invalidLinkModal("account.verify.title");
    let verified = false;
    return linkOutcomeModal(
        ctx,
        "account.verify.title",
        async () => {
            const result = await ctx.account.verifyEmail(link.userId, link.token);
            if (!result.isOk) return noticeText(cloudErrorMessage(result.error));
            verified = true;
            return notice(ctx.account.isSignedIn ? "account.verify.done" : "account.verify.doneSignIn");
        },
        () => (verified && !ctx.account.isSignedIn ? "" : undefined),
    );
}

export function showConfirmEmailChange(
    ctx: AccountUiContext,
    link: Extract<AccountLink, { kind: "confirmEmailChange" }>,
) {
    if (!isCompleteAccountLink(link)) return invalidLinkModal("account.emailChange.title");
    let changed = false;
    return linkOutcomeModal(
        ctx,
        "account.emailChange.title",
        async () => {
            const result = await ctx.account.confirmEmailChange(link.userId, link.email, link.token);
            if (!result.isOk) return noticeText(cloudErrorMessage(result.error));
            changed = true;
            return notice("account.emailChange.done{0}", link.email);
        },
        () => (changed ? link.email : undefined),
    );
}

export function showAccountLink(ctx: AccountUiContext, link: AccountLink): Modal {
    switch (link.kind) {
        case "verifyEmail":
            return showVerifyEmail(ctx, link);
        case "resetPassword":
            return showResetPassword(ctx, link);
        case "confirmEmailChange":
            return showConfirmEmailChange(ctx, link);
    }
}

// ---- Session expired -------------------------------------------------------------------------

/**
 * The re-login dialog after the session expired while signed in. It never touches open documents:
 * signing in resumes whatever was waiting (a pending save retries), "Not now" signs out on this
 * device only and the documents stay open with their changes.
 */
export function showReauthentication(ctx: AccountUiContext): Modal {
    const email = ctx.account.user?.email ?? "";
    const emailField = textField({
        label: "account.field.email",
        name: "email",
        type: "email",
        autocomplete: "username",
        value: email,
        readOnly: email !== "",
    });
    const passwordField = textField({
        label: "account.field.password",
        name: "password",
        type: "password",
        autocomplete: "current-password",
    });
    const modal: Modal = new Modal({
        title: "account.reauth.title",
        content: [paragraph("account.reauth.intro"), emailField.root, passwordField.root],
        onCancel: () => void ctx.account.cancelReauthentication(),
        actions: [
            { label: "account.reauth.later", cancel: true },
            {
                label: "account.signIn.submit",
                kind: "primary",
                submit: true,
                run: async () => {
                    if (!requireFilled(emailField, passwordField)) return false;
                    const result = await ctx.account.signIn(emailField.value.trim(), passwordField.value);
                    if (!result.isOk) {
                        passwordField.input.value = "";
                        return showCloudError(modal, result.error, { password: passwordField });
                    }
                    return undefined;
                },
            },
        ],
    });
    // Resolved elsewhere (signed in from another dialog, signed out from the menu): nothing to ask.
    const onStatus = (property: string | number | symbol) => {
        if (property === "status" && ctx.account.status !== "expired") modal.close();
    };
    ctx.account.onPropertyChanged(onStatus);
    modal.onClosed(() => ctx.account.removePropertyChanged(onStatus));
    return modal.open();
}
