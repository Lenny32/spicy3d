// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { featureHandler } from "../src/features/feature";
import "../src/features/sweep";
import "../src/features/loft";
import "../src/features/revolve";
import "../src/features/thicken";

test.each([
    "sweep",
    "loft",
    "revolve",
    "thicken",
])("%s refuses structural and unknown parameter edits", (type) => {
    const feature = { id: "stable", type };
    const handler = featureHandler(type)!;
    for (const key of ["id", "type", "path", "section", "guided", "unknown"]) {
        expect(handler.setParameter(feature, key, "corrupt")).toBe(feature);
    }
});
test.each([
    ["sweep", "solid"],
    ["sweep", "roundCorner"],
    ["loft", "solid"],
    ["loft", "ruled"],
])("%s accepts only boolean %s values", (type, key) => {
    const feature = { id: "stable", type };
    const handler = featureHandler(type)!;
    expect(handler.setParameter(feature, key, "true")).toBe(feature);
    expect(handler.setParameter(feature, key, true)).toEqual({ ...feature, [key]: true });
});

test("guided lofts hide and reject the ruled option", () => {
    const feature = { id: "stable", type: "loft", guided: { spine: {}, boundary: {} } };
    const handler = featureHandler("loft")!;
    expect(handler.parameters(feature).map((parameter) => parameter.key)).toEqual(["solid"]);
    expect(handler.setParameter(feature, "ruled", true)).toBe(feature);
});
