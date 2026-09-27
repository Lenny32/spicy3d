// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface IDisposable {
    dispose(): void;
}

export function isDisposable(value: unknown): value is IDisposable {
    return (
        value != null &&
        typeof value === "object" &&
        "dispose" in value &&
        typeof (value as IDisposable).dispose === "function" &&
        (value as IDisposable).dispose.length === 0
    );
}
