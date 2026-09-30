// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, PubSub } from "@spicy3d/core";

/** A separate indicator so rebuilding does not replace the sketch's solve status or pick prompt. */
export class RebuildIndicator extends HTMLElement {
    private readonly jobs = new Map<IDocument, Map<string, { completed: number; total: number }>>();

    connectedCallback(): void {
        this.setAttribute("role", "status");
        PubSub.default.sub("rebuildProgress", this.onProgress);
        PubSub.default.sub("documentClosed", this.onClosed);
    }

    disconnectedCallback(): void {
        PubSub.default.remove("rebuildProgress", this.onProgress);
        PubSub.default.remove("documentClosed", this.onClosed);
        this.jobs.clear();
    }

    private readonly onClosed = (document: IDocument) => {
        this.jobs.delete(document);
        this.render();
    };

    private readonly onProgress = (
        document: IDocument,
        nodeId: string,
        progress: { completed: number; total: number } | undefined,
    ) => {
        let jobs = this.jobs.get(document);
        if (!jobs) {
            jobs = new Map();
            this.jobs.set(document, jobs);
        }
        if (progress) jobs.set(nodeId, progress);
        else jobs.delete(nodeId);
        if (!jobs.size) this.jobs.delete(document);
        this.render();
    };

    private render(): void {
        const jobs = [...this.jobs.values()].flatMap((jobs) => [...jobs.values()]);
        this.textContent = jobs.length
            ? I18n.translate(
                  "model.rebuilding{0}{1}",
                  jobs.reduce((sum, job) => sum + job.completed, 0),
                  jobs.reduce((sum, job) => sum + job.total, 0),
              )
            : "";
    }
}

customElements.define("spicy-rebuild-status", RebuildIndicator);
