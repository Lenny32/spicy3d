// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys } from "../command";

/**
 * Lets a module take `file.importSvg` over while it has a better target: the sketch module sends
 * it into the open sketch (`sketch.importSvg`) instead of a separate shape on the XY plane.
 */
export const SvgImportRoute: { redirect?: () => CommandKeys | undefined } = {};
