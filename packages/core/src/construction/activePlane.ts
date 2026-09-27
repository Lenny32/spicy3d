// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView } from "../visual";
import type { ConstructionRef } from "./types";

const activePlanes = new WeakMap<IView, ConstructionRef>();

/** Retains the identity of an activated construction or UCS plane for the next sketch. */
export function setActiveConstructionPlane(view: IView, reference: ConstructionRef | undefined): void {
    if (reference) activePlanes.set(view, reference);
    else activePlanes.delete(view);
}

export function getActiveConstructionPlane(view: IView): ConstructionRef | undefined {
    return activePlanes.get(view);
}
