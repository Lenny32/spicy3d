// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ObjectSnapType, ObjectSnapTypes, ObjectSnapTypeUtils } from "../src";

test("should check combined snap types with hasType", () => {
    const ts = (ObjectSnapTypes.endPoint | ObjectSnapTypes.midPoint) as ObjectSnapType;
    expect(ObjectSnapTypeUtils.hasType(ts, ObjectSnapTypes.center)).toBe(false);
    expect(ObjectSnapTypeUtils.hasType(ts, ObjectSnapTypes.midPoint)).toBe(true);
});
