// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { XYZ, type XYZLike } from "../math";
import type { ConstructionGeometry } from "./types";

export type UcsGeometry = Extract<ConstructionGeometry, { kind: "ucs" }>;

export function ucsLocalToWorld(frame: UcsGeometry, local: XYZLike): XYZ {
    return frame.origin
        .add(frame.x.multiply(local.x))
        .add(frame.y.multiply(local.y))
        .add(frame.z.multiply(local.z));
}

export function ucsWorldToLocal(frame: UcsGeometry, world: XYZLike): XYZ {
    const delta = new XYZ(world).sub(frame.origin);
    return new XYZ(delta.dot(frame.x), delta.dot(frame.y), delta.dot(frame.z));
}
