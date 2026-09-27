// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type Locale } from "../src";

/**
 * Registers a deterministic identity locale so `I18n.translate(key)` returns the key
 * itself instead of logging "No translation for ... in undefined". Tests assert
 * against raw i18n keys, so echoing keys keeps every existing expectation valid no
 * matter which key (including custom test keys) is translated. Idempotent — safe to
 * call from multiple test files in the same worker.
 */
export function initializeI18n() {
    if (I18n.getLanguages().length > 0) return;

    const identityTranslation = new Proxy({} as Locale["translation"], {
        get: (_, key) => String(key),
    });
    I18n.addLanguage({ display: "English", language: "en", translation: identityTranslation });
}
