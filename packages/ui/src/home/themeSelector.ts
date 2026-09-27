// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type I18nKeys, Localize } from "@spicy3d/core";
import { type HTMLProps, option, select } from "@spicy3d/element";

export const ThemeSelector = (props: HTMLProps<HTMLElement>) => {
    const themes = [
        { value: "light", key: "common.theme.light" },
        { value: "dark", key: "common.theme.dark" },
        { value: "system", key: "common.theme.system" },
    ];

    const themeOptions: HTMLOptionElement[] = [];
    themes.forEach((theme) =>
        themeOptions.push(
            option({
                selected: theme.value === Config.instance.themeMode,
                textContent: new Localize(theme.key as I18nKeys),
                value: theme.value,
            }),
        ),
    );
    return select(
        {
            onchange: (e) => {
                const themeMode = (e.target as HTMLSelectElement).value as "light" | "dark" | "system";
                Config.instance.themeMode = themeMode;
            },
            ...props,
        },
        ...themeOptions,
    );
};
