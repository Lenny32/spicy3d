// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS, type Scope } from "@spicy3d/core";
import { trackVariableScope } from "../src/variableScope";

function source(): Scope {
    return new Map([
        ["width", { value: 10, unit: LENGTH_UNITS }],
        ["unused", { value: 20, unit: LENGTH_UNITS }],
    ]);
}

describe("feature variable scope tracking", () => {
    test("tracks get and has, including missing names, and ignores unread variables", () => {
        const tracked = trackVariableScope(source());
        expect(tracked.scope.get("width")).toEqual({ value: 10, unit: LENGTH_UNITS });
        expect(tracked.scope.has("optional")).toBe(false);
        expect(tracked.scope.get("missing")).toBeUndefined();
        expect(tracked.dependencies()).toEqual(["missing", "optional", "width"]);
    });

    test("a literal-only feature has no variable dependencies", () => {
        expect(trackVariableScope(source()).dependencies()).toEqual([]);
    });

    test.each([
        "entries",
        "keys",
        "values",
    ] as const)("%s conservatively tracks the entire scope", (method) => {
        const tracked = trackVariableScope(source());
        expect([...tracked.scope[method]()].length).toBe(2);
        expect(tracked.dependencies()).toBeUndefined();
    });

    test("size and default iteration depend on the entire scope", () => {
        const counted = trackVariableScope(source());
        expect(counted.scope.size).toBe(2);
        expect(counted.dependencies()).toBeUndefined();
        const iterated = trackVariableScope(source());
        expect([...iterated.scope].map(([name]) => name)).toEqual(["width", "unused"]);
        expect(iterated.dependencies()).toBeUndefined();
    });

    test("forEach preserves its map and this argument while tracking the entire scope", () => {
        const tracked = trackVariableScope(source());
        const receiver = { names: [] as string[], maps: [] as Scope[] };
        tracked.scope.forEach(function (this: typeof receiver, _value, name, map) {
            this.names.push(name);
            this.maps.push(map);
        }, receiver);
        expect(receiver.names).toEqual(["width", "unused"]);
        expect(receiver.maps).toHaveLength(2);
        expect(receiver.maps[0]).toBe(tracked.scope);
        expect(receiver.maps[1]).toBe(tracked.scope);
        expect(tracked.dependencies()).toBeUndefined();
    });
});
