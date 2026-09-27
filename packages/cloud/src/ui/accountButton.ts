// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@spicy3d/core";
import { button, div, span } from "@spicy3d/element";
import style from "./account.module.css";
import { showAccountSettings } from "./accountSettings";
import { type AccountUiContext, resendVerification, showReauthentication, showSignIn } from "./authDialogs";
import { initials } from "./forms";

/**
 * The account entry of the title bar: a discreet "Sign in" while signed out, the user's initials
 * with a menu (name, email, settings, sign out) while signed in. Only mounted when a server answers.
 */
export class AccountButton extends HTMLElement {
    private menu?: HTMLElement;

    constructor(readonly ctx: AccountUiContext) {
        super();
        this.className = style.accountButton;
    }

    connectedCallback(): void {
        this.ctx.account.onPropertyChanged(this.render);
        document.addEventListener("pointerdown", this.onDocumentPointerDown);
        this.render();
    }

    disconnectedCallback(): void {
        this.ctx.account.removePropertyChanged(this.render);
        document.removeEventListener("pointerdown", this.onDocumentPointerDown);
    }

    private readonly render = () => {
        this.closeMenu();
        const { status, user } = this.ctx.account;
        if ((status === "signedIn" || status === "expired") && user) {
            const avatar = button({
                type: "button",
                className: style.avatar,
                textContent: initials(user.displayName || user.email),
                title: I18n.translate(status === "expired" ? "account.menu.expired" : "account.menu.title"),
                onclick: () => this.toggleMenu(),
            });
            avatar.dataset["status"] = status;
            avatar.setAttribute("aria-haspopup", "menu");
            this.replaceChildren(avatar);
        } else if (status === "unknown") {
            // Not known yet (startup, or the server can't be reached): nothing to offer.
            this.replaceChildren();
        } else {
            this.replaceChildren(
                button({
                    type: "button",
                    className: style.signInButton,
                    textContent: I18n.translate("account.signIn"),
                    title: I18n.translate("account.signInHint"),
                    onclick: () => showSignIn(this.ctx),
                }),
            );
        }
    };

    private toggleMenu() {
        if (this.menu) this.closeMenu();
        else this.openMenu();
    }

    private openMenu() {
        const { account, features } = this.ctx;
        const user = account.user;
        if (!user) return;
        const item = (label: I18nKeys, run: () => void) =>
            button({
                type: "button",
                textContent: I18n.translate(label),
                onclick: () => {
                    this.closeMenu();
                    run();
                },
            });

        const items: HTMLElement[] = [
            div(
                { className: style.menuHeader },
                span({ textContent: user.displayName }),
                span({ textContent: user.email }),
            ),
        ];
        if (account.status === "expired") {
            items.push(item("account.menu.expired", () => void account.reauthenticate()));
        } else if (!user.emailVerified && features.emailVerification) {
            items.push(
                div({ className: style.menuWarning, textContent: I18n.translate("account.menu.unverified") }),
            );
            if (features.email)
                items.push(item("account.menu.resend", () => void resendVerification(this.ctx)));
        }
        if (account.status === "signedIn") {
            items.push(item("account.menu.settings", () => showAccountSettings(this.ctx)));
        }
        items.push(item("account.menu.signOut", () => void account.signOut()));

        this.menu = div({ className: style.menu }, ...items);
        this.menu.setAttribute("role", "menu");
        this.append(this.menu);
    }

    private closeMenu() {
        this.menu?.remove();
        this.menu = undefined;
    }

    private readonly onDocumentPointerDown = (e: PointerEvent) => {
        if (this.menu && !this.contains(e.target as Node)) this.closeMenu();
    };
}

customElements.define("spicy-account-button", AccountButton);

/** The re-login dialog, opened by the account whenever a session expires while signed in. */
export function reauthenticationHandler(ctx: AccountUiContext) {
    return () => {
        showReauthentication(ctx);
    };
}
