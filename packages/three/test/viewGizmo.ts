// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IViewGizmo } from "@spicy3d/core";

export class ViewGizmo extends HTMLElement implements IViewGizmo {
    update(): void {}
    dispose(): void {}
    setDom(dom: HTMLElement) {}
}

// The real `src/viewGizmo` module also registers the "view-gizmo" tag. Depending on the
// test-file evaluation order in a worker, either module may run first, so guard the
// registration and fall back to a distinct tag to keep this stub class constructable.
const tag = customElements.get("view-gizmo") ? "view-gizmo-stub" : "view-gizmo";
if (!customElements.get(tag)) {
    customElements.define(tag, ViewGizmo);
}
