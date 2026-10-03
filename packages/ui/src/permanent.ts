// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, PubSub } from "@spicy3d/core";
import { div, span } from "@spicy3d/element";
import style from "./permanent.module.css";

export class Permanent {
    static async show(action: () => Promise<void>, message: I18nKeys, ...args: any[]) {
        const dialog = document.createElement("dialog");
        const progress = span({ role: "status" });
        const jobs = new Map<string, { completed: number; total: number }>();
        const onProgress: Parameters<typeof PubSub.default.sub<"rebuildProgress">>[1] = (
            document,
            nodeId,
            value,
        ) => {
            const id = `${document.id}:${nodeId}`;
            if (value) jobs.set(id, value);
            else jobs.delete(id);
            progress.textContent = jobs.size
                ? I18n.translate(
                      "model.rebuilding{0}{1}",
                      [...jobs.values()].reduce((sum, job) => sum + job.completed, 0),
                      [...jobs.values()].reduce((sum, job) => sum + job.total, 0),
                  )
                : "";
        };
        dialog.appendChild(
            div(
                { className: style.container },
                div({
                    className: style.loading,
                    style: {
                        animation: `${style.circle} infinite 0.75s linear`,
                    },
                }),
                span({
                    className: style.message,
                    textContent: I18n.translate(message, ...args),
                }),
                progress,
            ),
        );
        document.body.appendChild(dialog);
        dialog.showModal();

        PubSub.default.sub("rebuildProgress", onProgress);
        try {
            await action();
        } finally {
            PubSub.default.remove("rebuildProgress", onProgress);
            dialog.remove();
        }
    }
}
