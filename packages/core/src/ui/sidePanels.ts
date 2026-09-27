// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObservableCollection } from "../foundation/collection";

/**
 * Panels modules dock at the right of the viewport, e.g. the version history of a cloud document.
 * The editor renders them in order, live: pushing one shows it, removing it hides it.
 */
export class SidePanels {
    static readonly items = new ObservableCollection<HTMLElement>();
}
