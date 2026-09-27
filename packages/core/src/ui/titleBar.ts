// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObservableCollection } from "../foundation/collection";

/**
 * Elements modules add to the right end of the title bar, e.g. the account menu of the cloud (only
 * once a server answers). The ribbon renders them in order, live: pushing after startup shows them.
 */
export class TitleBar {
    static readonly items = new ObservableCollection<HTMLElement>();
}
