// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * `text` without the run of `chars` at its end (`trimEndChars("a//", "/")` → `"a"`). A linear scan:
 * an anchored `/[…]+$/` retries from every start position, quadratic on a long run of those chars.
 */
export function trimEndChars(text: string, chars: string): string {
    let end = text.length;
    while (end > 0 && chars.includes(text[end - 1])) end--;
    return text.slice(0, end);
}

/** `url` without trailing slashes (`https://host/app//` → `https://host/app`). */
export function trimTrailingSlashes(url: string): string {
    return trimEndChars(url, "/");
}
