// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEqualityComparer } from "../equalityComparer";
import { Precision } from "../precision";

export class NumberEqualityComparer implements IEqualityComparer<number> {
    constructor(readonly tolerance: number = Precision.Distance) {}

    equals(left: number, right: number): boolean {
        return Math.abs(left - right) < this.tolerance;
    }
}
