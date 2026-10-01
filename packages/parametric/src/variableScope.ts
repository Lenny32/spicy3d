// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Scope } from "@spicy3d/core";

/** Records resolved variable reads without parsing feature payloads or invoking geometry twice. */
export function trackVariableScope(source: Scope): {
    scope: Scope;
    dependencies(): readonly string[] | undefined;
} {
    const names = new Set<string>();
    let entireScope = false;
    const scope = new Proxy(source, {
        get(target, property) {
            if (property === "get" || property === "has") {
                return (name: string) => {
                    names.add(name);
                    return target[property](name);
                };
            }
            // Iteration, forEach and size can inspect arbitrary names or observe additions.
            // Custom handlers using them conservatively depend on the entire scope.
            if (
                property === "size" ||
                property === "entries" ||
                property === "keys" ||
                property === "values" ||
                property === "forEach" ||
                property === Symbol.iterator
            ) {
                entireScope = true;
            }
            if (property === "forEach") {
                return (callback: Parameters<Scope["forEach"]>[0], thisArg?: unknown) =>
                    target.forEach((value, key) => callback.call(thisArg, value, key, scope));
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return { scope, dependencies: () => (entireScope ? undefined : [...names].sort()) };
}
