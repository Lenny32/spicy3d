// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView } from "./visual";

export interface IEditor {
    active(): boolean;
    deactive(): boolean;
    onPointerMove(view: IView, e: PointerEvent): void;
    onPointerDown(view: IView, e: PointerEvent): void;
    onPointerUp(view: IView, e: PointerEvent): void;
}
