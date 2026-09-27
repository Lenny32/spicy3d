// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The pages the server's emails link to (SpicySrv `AccountLinks`): `<publicUrl>/<route>?userId=…&token=…`.
// Dependency-free, so the web entry can recognize a link before anything else loads.

/** A link from an account email, opened in the app. */
export type AccountLink =
    | { kind: "verifyEmail"; userId: string; token: string }
    | { kind: "resetPassword"; userId: string; token: string }
    | { kind: "confirmEmailChange"; userId: string; email: string; token: string };

const ROUTES: Record<string, AccountLink["kind"]> = {
    "verify-email": "verifyEmail",
    "reset-password": "resetPassword",
    "confirm-email-change": "confirmEmailChange",
};

export interface AccountLinkRoute {
    link: AccountLink;
    /** The app's own path (the folder the route is in), e.g. `/` for `/reset-password`. */
    appPath: string;
}

/**
 * Recognizes an account email link from the page's path and query. Missing parameters are kept as
 * empty strings: the dialog then says the link is invalid instead of the app ignoring it.
 */
export function parseAccountLink(pathname: string, search: string): AccountLinkRoute | undefined {
    const match = /^(.*\/)([^/]+?)\/?$/.exec(pathname);
    if (!match) return undefined;
    const kind = Object.hasOwn(ROUTES, match[2]) ? ROUTES[match[2]] : undefined;
    if (!kind) return undefined;

    const params = new URLSearchParams(search);
    const userId = params.get("userId") ?? "";
    const token = params.get("token") ?? "";
    const link: AccountLink =
        kind === "confirmEmailChange"
            ? { kind, userId, email: params.get("email") ?? "", token }
            : { kind, userId, token };
    return { link, appPath: match[1] };
}

/** Whether the link carries what the server needs; an incomplete one is reported as invalid. */
export function isCompleteAccountLink(link: AccountLink): boolean {
    return (
        link.userId !== "" && link.token !== "" && (link.kind !== "confirmEmailChange" || link.email !== "")
    );
}
