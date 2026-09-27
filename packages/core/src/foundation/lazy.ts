// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export class Lazy<T> {
    #value?: T;
    readonly #factory: () => T;

    constructor(factory: () => T) {
        this.#factory = factory;
    }

    get value(): T {
        if (this.#value === undefined) {
            this.#value = this.#factory();
        }
        return this.#value;
    }
}
