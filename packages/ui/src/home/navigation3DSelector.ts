// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, Navigation3DTypes } from "@spicy3d/core";
import { type HTMLProps, option, select } from "@spicy3d/element";

export const Navigation3DSelector = (props: HTMLProps<HTMLElement>) => {
    const nav3DTypes: HTMLOptionElement[] = [];
    Navigation3DTypes.forEach((nav3DType) =>
        nav3DTypes.push(
            option({
                selected: nav3DType === Config.instance.navigation3D,
                textContent: nav3DType,
            }),
        ),
    );
    const el = select(
        {
            onchange: (e) => {
                const index = (e.target as HTMLSelectElement).selectedIndex;
                Config.instance.navigation3D = Navigation3DTypes[index];
            },
            ...props,
        },
        ...nav3DTypes,
    ) as HTMLSelectElement;
    // `selected` set before insertion is not honoured everywhere; pin the index explicitly
    el.selectedIndex = Navigation3DTypes.indexOf(Config.instance.navigation3D);
    return el;
};
