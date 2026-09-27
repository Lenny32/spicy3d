// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** What a redacted value is replaced with. */
export const REDACTED = "•••";

/**
 * A URL as it may appear in a log line, a toast or an error message: scheme, host and path only.
 * The query and the fragment are where secrets travel (`?token=`, a pre-signed download's signature,
 * an account email link's one-time token), so they are replaced as a whole; user info
 * (`user:password@` before the host) goes too. A value that is not a URL goes through
 * {@link redactSecrets} instead.
 */
export function redactUrl(value: string | URL): string {
    let url: URL;
    try {
        url = typeof value === "string" ? new URL(value) : value;
    } catch {
        return redactSecrets(String(value));
    }
    const query = url.search ? `?${REDACTED}` : "";
    const hash = url.hash ? `#${REDACTED}` : "";
    return `${url.protocol}//${url.host}${url.pathname}${query}${hash}`;
}

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`)]+/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** `token=…`, `"password": "…"`, `apiKey: …` and the like (the key is kept, its value is not). */
const SECRET_FIELD_PATTERN =
    /(["']?\b(?:access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key|apikey|authorization|signature|sig)\b["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi;
/** Personal access tokens of the Spicy3D server (SpicySrv `AccessTokenService.SecretPrefix`) anywhere. */
const PAT_PATTERN = /\bspicy_pat_[A-Za-z0-9_-]{8,}/g;

/**
 * Free text (an error message, a server answer) with anything that looks like a credential masked:
 * URLs lose their query (see {@link redactUrl}), `Bearer …` headers, `token=…`/`"password": …`
 * fields and personal access tokens their value.
 */
export function redactSecrets(text: string): string {
    return text
        .replace(URL_PATTERN, (match) => {
            // Punctuation ending a sentence ("…/f.step?sig=x: 403") is not part of the URL.
            const trailing = /[.,:;!?]+$/.exec(match)?.[0] ?? "";
            const url = match.slice(0, match.length - trailing.length);
            try {
                return redactUrl(new URL(url)) + trailing;
            } catch {
                return url.replace(/[?#].*$/, `?${REDACTED}`) + trailing;
            }
        })
        .replace(BEARER_PATTERN, (_, scheme: string) => `${scheme} ${REDACTED}`)
        .replace(SECRET_FIELD_PATTERN, (_, key: string) => `${key}${REDACTED}`)
        .replace(PAT_PATTERN, `spicy_pat_${REDACTED}`);
}
