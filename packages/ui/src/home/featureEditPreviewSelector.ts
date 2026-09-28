// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, FEATURE_EDIT_PREVIEW_MODES, type FeatureEditPreviewMode, I18n } from "@spicy3d/core";
import { type HTMLProps, option, select } from "@spicy3d/element";

/**
 * What editing a feature with its handles previews (`Config.featureEditPreview`): the whole
 * model live, only the edited step, or automatically whichever keeps up.
 */
export const FeatureEditPreviewSelector = (props: HTMLProps<HTMLElement>) => {
    const el = select(
        {
            onchange: (e) => {
                Config.instance.featureEditPreview = (e.target as HTMLSelectElement)
                    .value as FeatureEditPreviewMode;
            },
            ...props,
        },
        ...FEATURE_EDIT_PREVIEW_MODES.map((mode) =>
            option({ value: mode, textContent: I18n.translate(`featureEdit.preview.${mode}`) }),
        ),
    ) as HTMLSelectElement;
    el.setAttribute("aria-label", I18n.translate("featureEdit.preview"));
    el.value = Config.instance.featureEditPreview;
    return el;
};
