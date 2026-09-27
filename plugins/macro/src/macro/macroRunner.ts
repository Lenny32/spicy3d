// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, type IApplication, PubSub } from "@spicy3d/core";

export async function runMacro(app: IApplication, code: string) {
    if (!code.trim()) {
        PubSub.default.pub("showToast", "macro.editor.emptyCode" as I18nKeys);
        return;
    }

    const fn = new Function("app", code);
    await Promise.try(fn as any, app)
        .then(() => {
            PubSub.default.pub("showToast", "macro.editor.executed" as I18nKeys);
        })
        .catch((error: Error) => {
            console.error("Macro execution error:", error);
            alert(`macro.editor.error: ${(error as Error).message}`);
        });
}
