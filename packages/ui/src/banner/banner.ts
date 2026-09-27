// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type BannerOptions, I18n } from "@spicy3d/core";
import { button, div, span } from "@spicy3d/element";
import style from "./banner.module.css";

/** Non-blocking messages pinned to the top of the window (`showBanner` / `hideBanner`). */
export class Banner {
    private static host: HTMLElement | undefined;
    private static readonly shown = new Map<string, HTMLElement>();

    static readonly show = (options: BannerOptions) => {
        Banner.hide(options.id);

        const banner = div(
            { className: `${style.banner} ${style[options.level]}` },
            span({
                className: style.message,
                textContent: I18n.translate(options.message, ...(options.args ?? [])),
            }),
        );
        banner.dataset["bannerId"] = options.id;
        banner.setAttribute("role", "status");
        const actions = [...(options.action ? [options.action] : []), ...(options.actions ?? [])];
        for (const action of actions) {
            banner.append(
                button({
                    className: style.action,
                    textContent: I18n.translate(action.label),
                    onclick: () => action.run(),
                }),
            );
        }
        if (options.dismissible !== false) {
            banner.append(
                button({
                    className: style.close,
                    textContent: "×",
                    title: I18n.translate("common.close"),
                    onclick: () => Banner.hide(options.id),
                }),
            );
        }

        Banner.shown.set(options.id, banner);
        Banner.ensureHost().append(banner);
    };

    static readonly hide = (id: string) => {
        Banner.shown.get(id)?.remove();
        Banner.shown.delete(id);
        if (Banner.shown.size === 0) {
            Banner.host?.remove();
            Banner.host = undefined;
        }
    };

    private static ensureHost() {
        if (!Banner.host) {
            Banner.host = div({ className: style.host });
            document.body.append(Banner.host);
        }
        return Banner.host;
    }
}
