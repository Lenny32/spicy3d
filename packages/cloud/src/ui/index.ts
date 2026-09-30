// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { HomeBar, Logger, TitleBar } from "@spicy3d/core";
import type { CloudConnection } from "../cloud";
import type { AccountLink } from "../links";
import { AccountButton, reauthenticationHandler } from "./accountButton";
import { type AccountUiContext, showAccountLink } from "./authDialogs";

export * from "./accountButton";
export * from "./accountSettings";
export * from "./authDialogs";
export * from "./forms";
export * from "./modal";

/** Re-checks the session when the tab comes back, at most this often (sign-out elsewhere, expiry). */
const REFRESH_ON_FOCUS_MS = 60_000;

/**
 * Shows the account UI of a connected server: asks who is signed in, puts the account button in the
 * title bar and in the home page's corner, handles session expiry with the re-login dialog, and opens
 * the dialog of an account email link the app was opened with. Returns the teardown.
 */
export function accountUiContext(connection: CloudConnection): AccountUiContext {
    const { features, mcp } = connection.config;
    return {
        account: connection.account,
        features,
        mcpEndpoint: features.mcp && mcp ? mcp.endpoint : undefined,
    };
}

export async function startAccountUi(connection: CloudConnection, link?: AccountLink): Promise<() => void> {
    const ctx = accountUiContext(connection);
    const result = await ctx.account.refresh();
    if (!result.isOk) Logger.warn(`[cloud] could not read the session: ${result.error.kind}`);

    ctx.account.setReauthenticationHandler(reauthenticationHandler(ctx));
    const button = new AccountButton(ctx);
    const homeButton = new AccountButton(ctx);
    TitleBar.items.push(button);
    HomeBar.items.push(homeButton);

    let lastRefresh = Date.now();
    const onVisible = () => {
        if (document.visibilityState !== "visible" || Date.now() - lastRefresh < REFRESH_ON_FOCUS_MS) return;
        if (ctx.account.status === "signedOut") return;
        lastRefresh = Date.now();
        void ctx.account.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    if (link) showAccountLink(ctx, link);

    return () => {
        document.removeEventListener("visibilitychange", onVisible);
        TitleBar.items.remove(button);
        HomeBar.items.remove(homeButton);
        ctx.account.setReauthenticationHandler(undefined);
    };
}
