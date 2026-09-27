// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import style from "./ribbonStack.module.css";

export class RibbonStack extends HTMLElement {
    constructor() {
        super();
        this.className = style.root;
    }
}

customElements.define("ribbon-stack", RibbonStack);
