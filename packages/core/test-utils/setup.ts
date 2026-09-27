// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { initializeI18n } from "./i18n";

// Rstest global setup file — loaded once per worker via `setupFiles` in rstest.config.ts.
// Registers the identity locale so tests never log "No translation for ... in undefined"
// without each test file having to call `initializeI18n()` itself.
initializeI18n();
