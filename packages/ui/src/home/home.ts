// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DialogButton,
    DOCUMENT_FILE_EXTENSION,
    type DocumentMeta,
    type DocumentPage,
    type DocumentRepositoryError,
    download,
    type ExistingDocument,
    type ExistingDocumentChoice,
    encodeDocumentFile,
    formatDateTime,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocumentRepository,
    Localize,
    Logger,
    ObservableCollection,
    PubSub,
    Result,
    relativeTimeParts,
    repositoryErrorMessage,
    setRelativeTime,
    transferDocument,
    watchRelativeTimes,
} from "@spicy3d/core";
import { a, button, collection, div, img, input, label, span, svg } from "@spicy3d/element";
import { AutosaveSelector } from "./autosaveSelector";
import style from "./home.module.css";
import { LanguageSelector } from "./languageSelector";
import { Navigation3DSelector } from "./navigation3DSelector";
import { ThemeSelector } from "./themeSelector";

interface ApplicationCommand {
    display: I18nKeys;
    icon: string;
    onclick: () => void;
}

const applicationCommands = new ObservableCollection<ApplicationCommand>(
    {
        display: "command.doc.new",
        icon: "icon-plus",
        onclick: () => PubSub.default.pub("executeCommand", "doc.new"),
    },
    {
        display: "command.doc.open",
        icon: "icon-folder",
        onclick: () => PubSub.default.pub("executeCommand", "doc.open"),
    },
);

export class Home extends HTMLElement {
    private readonly lists = div({ className: style.lists });
    private readonly toolbar = div({ className: style.toolbar });
    private readonly searchInput = input({
        type: "search",
        className: style.search,
        placeholder: I18n.translate("home.search"),
    });
    private showTrash = false;
    private searchTimer?: number;
    private stopRelativeTimes?: () => void;
    /** Bumped on every refresh: an older listing that answers late is dropped. */
    private generation = 0;

    constructor(readonly app: IApplication) {
        super();
        this.className = style.root;
        this.searchInput.setAttribute("aria-label", I18n.translate("home.search"));
        this.searchInput.oninput = () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => void this.refresh(), 250);
        };
    }

    connectedCallback() {
        this.app.repositories.onPropertyChanged(this.onRepositoriesChanged);
        this.stopRelativeTimes?.();
        this.stopRelativeTimes = watchRelativeTimes(this.lists);
    }

    disconnectedCallback() {
        this.app.repositories.removePropertyChanged(this.onRepositoriesChanged);
        clearTimeout(this.searchTimer);
        this.stopRelativeTimes?.();
        this.stopRelativeTimes = undefined;
    }

    private readonly onRepositoriesChanged = (property: string | number | symbol) => {
        if (property !== "cloud") return;
        if (!this.app.repositories.cloud) this.showTrash = false;
        void this.refresh();
    };

    private hasOpen(item: DocumentMeta) {
        for (const document of this.app.documents) {
            if (document.id === item.id && document.repository.kind === item.location) return true;
        }
        return false;
    }

    async render() {
        this.append(this.leftSection(), this.rightSection());
        this.app.mainWindow?.appendChild(this);
        await this.refresh();
    }

    /** Lists again (search, sign-in or sign-out, a move or a deletion). */
    async refresh(): Promise<void> {
        const generation = ++this.generation;
        const cloud = this.app.repositories.cloud;
        const search = this.searchInput.value.trim() || undefined;
        this.renderToolbar(cloud);
        let sections: HTMLElement[];
        if (cloud && this.showTrash) {
            sections = [await this.trashSection(cloud, search)];
        } else if (cloud) {
            sections = await Promise.all([
                this.documentSection("home.section.cloud", cloud, search),
                this.documentSection("home.section.device", this.app.repositories.local, search),
            ]);
        } else {
            sections = [await this.documentSection("home.recent", this.app.repositories.local, search)];
        }
        if (generation === this.generation) this.lists.replaceChildren(...sections);
    }

    private leftSection() {
        return div(
            { className: style.left },
            div(
                { className: style.top },
                this.logoSection(),
                this.applicationCommands(),
                this.currentDocument(),
            ),

            this.settings(),
            this.links(),
        );
    }

    private logoSection() {
        return div(
            { className: style.logo },
            svg({ icon: "icon-spicy" }),
            div(
                { className: style.logoText },
                span({ className: style.wordmark, textContent: "SPICY3D" }),
                span({ className: style.version, textContent: `v${__APP_VERSION__}` }),
            ),
        );
    }

    private applicationCommands() {
        return collection({
            className: style.buttons,
            sources: applicationCommands,
            template: (item) =>
                button(
                    {
                        className: style.button,
                        onclick: item.onclick,
                    },
                    svg({ icon: item.icon }),
                    span({ textContent: new Localize(item.display) }),
                ),
        });
    }

    private currentDocument() {
        return this.app.activeView?.document
            ? button(
                  {
                      className: `${style.button} ${style.back}`,
                      onclick: () => {
                          PubSub.default.pub("displayHome", false);
                      },
                  },
                  svg({ icon: "icon-back" }),
                  span({ textContent: new Localize("common.back") }),
              )
            : "";
    }

    private settings() {
        return div(
            { className: style.settingsPanel },
            div(
                { className: style.settingItem },
                span({
                    className: style.settingLabel,
                    textContent: new Localize("common.language"),
                }),
                div({ className: style.settingControl }, LanguageSelector({})),
            ),
            div(
                { className: style.settingItem },
                span({
                    className: style.settingLabel,
                    textContent: new Localize("common.theme"),
                }),
                div({ className: style.settingControl }, ThemeSelector({})),
            ),
            div(
                { className: style.settingItem },
                span({
                    className: style.settingLabel,
                    textContent: new Localize("common.3DNavigation"),
                }),
                div({ className: style.settingControl }, Navigation3DSelector({})),
            ),
            div(
                { className: style.settingItem },
                span({
                    className: style.settingLabel,
                    textContent: new Localize("autosave.setting"),
                }),
                div({ className: style.settingControl }, new AutosaveSelector()),
            ),
        );
    }

    private links() {
        return div(
            { className: style.socialPanel },
            a(
                {
                    className: style.socialItem,
                    href: "https://github.com/Lenny32/spicy3d",
                    target: "_blank",
                    rel: "noopener noreferrer",
                },
                svg({ icon: "icon-github" }),
                label({ textContent: "GitHub" }),
            ),
            a(
                {
                    className: style.socialItem,
                    href: "https://github.com/xiangechen/chili3d",
                    target: "_blank",
                    rel: "noopener noreferrer",
                },
                label({ textContent: new Localize("home.basedOn") }),
            ),
        );
    }

    private rightSection() {
        return div(
            { className: style.right },
            div(
                { className: style.page },
                div(
                    { className: style.header },
                    div({ className: style.welcome, textContent: new Localize("home.welcome") }),
                    div({ className: style.subtitle, textContent: new Localize("home.welcome.subtitle") }),
                ),
                this.toolbar,
                div({ className: style.contentRow }, div({ className: style.recentColumn }, this.lists)),
            ),
        );
    }

    private renderToolbar(cloud: IDocumentRepository | undefined) {
        const buttons: HTMLElement[] = [];
        if (cloud) {
            buttons.push(
                this.toolButton("home.import.button", () => this.showImport(cloud)),
                this.toolButton(this.showTrash ? "home.trash.back" : "home.trash.button", () => {
                    this.showTrash = !this.showTrash;
                    void this.refresh();
                }),
            );
        }
        this.toolbar.replaceChildren(this.searchInput, ...buttons);
    }

    private toolButton(text: I18nKeys, onclick: () => void) {
        return button({ className: style.toolButton, textContent: I18n.translate(text), onclick });
    }

    private async listAll(
        list: (query: {
            cursor?: string;
            search?: string;
        }) => Promise<Result<DocumentPage, DocumentRepositoryError>>,
        search: string | undefined,
    ): Promise<DocumentMeta[] | undefined> {
        const items: DocumentMeta[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const result = await list({ cursor, search });
            if (!result.isOk) {
                Logger.warn(`home: cannot list documents (${JSON.stringify(result.error)})`);
                return page === 0 ? undefined : items;
            }
            items.push(...result.value.items);
            cursor = result.value.nextCursor;
            if (!cursor) break;
        }
        return items;
    }

    private async documentSection(
        title: I18nKeys,
        repository: IDocumentRepository,
        search: string | undefined,
    ): Promise<HTMLElement> {
        const items = await this.listAll((query) => repository.list(query), search);
        const section = div(
            { className: style.section },
            div({ className: style.sectionTitle, textContent: new Localize(title) }),
        );
        section.dataset["location"] = repository.kind;
        if (items === undefined) {
            section.append(div({ className: style.empty, textContent: new Localize("home.list.failed") }));
        } else if (items.length === 0) {
            const empty = search ? "home.search.empty" : "home.recent.empty";
            section.append(div({ className: style.empty, textContent: new Localize(empty) }));
        } else {
            section.append(
                div(
                    { className: style.documents },
                    ...items.map((item) => this.documentCard(item, repository)),
                ),
            );
        }
        return section;
    }

    private async trashSection(cloud: IDocumentRepository, search: string | undefined): Promise<HTMLElement> {
        const items = cloud.listTrash ? await this.listAll((query) => cloud.listTrash!(query), search) : [];
        const section = div(
            { className: style.section },
            div({ className: style.sectionTitle, textContent: new Localize("home.section.trash") }),
        );
        section.dataset["location"] = "trash";
        if (cloud.trashRetentionDays !== undefined) {
            section.append(
                div({
                    className: style.hint,
                    textContent: I18n.translate("home.trash.retention{0}", cloud.trashRetentionDays),
                }),
            );
        }
        if (items === undefined) {
            section.append(div({ className: style.empty, textContent: new Localize("home.list.failed") }));
        } else if (items.length === 0) {
            section.append(div({ className: style.empty, textContent: new Localize("home.trash.empty") }));
        } else {
            section.append(
                div({ className: style.documents }, ...items.map((item) => this.trashCard(item, cloud))),
            );
        }
        return section;
    }

    private thumbnail(item: DocumentMeta, repository: IDocumentRepository) {
        const image = img({ className: style.img, src: item.thumbnail ?? "", alt: "" });
        if (!item.thumbnail && repository.thumbnailUrl) {
            void repository.thumbnailUrl(item).then((url) => {
                if (url) image.src = url;
            });
        }
        return image;
    }

    private documentCard(item: DocumentMeta, repository: IDocumentRepository) {
        const card = div(
            { className: style.document, onclick: () => this.handleDocumentClick(item, repository) },
            this.thumbnail(item, repository),
            this.documentDescription(item),
            this.cardActions(item, repository),
        );
        card.dataset["id"] = item.id;
        return card;
    }

    private trashCard(item: DocumentMeta, cloud: IDocumentRepository) {
        const card = div(
            { className: `${style.document} ${style.trashed}` },
            this.thumbnail(item, cloud),
            this.documentDescription(item, true),
            div(
                { className: style.actions },
                this.actionButton("home.trash.restore", async () => {
                    const restored = await cloud.restore?.(item.id);
                    if (restored?.isOk) {
                        PubSub.default.pub("showToast", "home.toast.restored{0}", item.name);
                    } else {
                        PubSub.default.pub("showToast", "error.repository.restoreFailed{0}", item.name);
                    }
                    await this.refresh();
                }),
            ),
        );
        card.dataset["id"] = item.id;
        return card;
    }

    private documentDescription(item: DocumentMeta, trashed = false) {
        const details: HTMLElement[] = [this.documentDate(item, trashed)];
        if (item.sizeBytes !== undefined) {
            details.push(span({ className: style.size, textContent: formatBytes(item.sizeBytes) }));
        }
        const title = div(
            { className: style.titleRow },
            span({ className: style.title, textContent: item.name, title: item.name }),
        );
        if (item.location === "cloud") {
            title.append(span({ className: style.badge, textContent: I18n.translate("home.badge.cloud") }));
        }
        return div({ className: style.description }, title, div({ className: style.details }, ...details));
    }

    /**
     * Cloud times are relative ("5 minutes ago", full time in the tooltip, refreshed while shown); a
     * trashed document shows when it was deleted. Device documents keep their absolute date and time.
     */
    private documentDate(item: DocumentMeta, trashed: boolean): HTMLElement {
        if (item.location !== "cloud") {
            return span({ className: style.date, textContent: formatDateTime(item.updatedAt) });
        }
        if (trashed && item.deletedAt !== undefined) {
            return span(
                { className: style.date },
                ...relativeTimeParts((time) => I18n.translate("home.trash.deleted{0}", time), item.deletedAt),
            );
        }
        return setRelativeTime(span({ className: style.date }), item.updatedAt);
    }

    private actionButton(text: I18nKeys, run: () => Promise<void>) {
        return button({
            className: style.action,
            textContent: I18n.translate(text),
            onclick: (e: MouseEvent) => {
                e.stopPropagation();
                void run();
            },
        });
    }

    private cardActions(item: DocumentMeta, repository: IDocumentRepository) {
        const cloud = this.app.repositories.cloud;
        const actions: HTMLElement[] = [];
        if (item.location === "local" && cloud) {
            actions.push(
                this.actionButton("cloud.document.saveToCloud", () => this.moveToCloud(item, cloud)),
            );
        } else if (item.location === "cloud") {
            actions.push(
                this.actionButton("home.action.moveToDevice", () =>
                    this.transfer(item, this.app.repositories.local, false, "home.toast.movedToDevice{0}"),
                ),
            );
        }
        actions.push(
            this.actionButton("cloud.document.download", () => this.download(item, repository)),
            this.actionButton("common.delete", () => this.delete(item, repository)),
        );
        return div({ className: style.actions }, ...actions);
    }

    private moveToCloud(item: DocumentMeta, cloud: IDocumentRepository): Promise<void> {
        return new Promise((resolve) => {
            PubSub.default.pub(
                "showDialog",
                "cloud.document.saveToCloud",
                div({ textContent: I18n.translate("cloud.document.saveToCloudHint{0}", item.name) }),
                [
                    {
                        content: "cloud.document.moveToCloud",
                        onclick: () =>
                            this.transfer(item, cloud, false, "home.toast.movedToCloud{0}").then(resolve),
                    },
                    {
                        content: "cloud.document.keepLocalCopy",
                        onclick: () =>
                            this.transfer(item, cloud, true, "home.toast.copiedToCloud{0}").then(resolve),
                    },
                    { content: "common.cancel", onclick: () => resolve() },
                ],
            );
        });
    }

    private async transfer(
        item: DocumentMeta,
        target: IDocumentRepository,
        keepSource: boolean,
        success: I18nKeys,
    ): Promise<void> {
        const result = await transferDocument(this.app, item, target, {
            keepSource,
            resolveExisting: askAboutExisting,
        });
        if (!result.isOk) {
            PubSub.default.pub("showToast", ...repositoryErrorMessage(result.error));
        } else if (result.value.status === "cancelled") {
            // Nothing moved.
        } else if (result.value.status === "conflict") {
            PubSub.default.pub("showToast", "cloud.document.alreadyInCloud");
        } else {
            PubSub.default.pub("showToast", success, item.name);
        }
        await this.refresh();
    }

    private async download(item: DocumentMeta, repository: IDocumentRepository) {
        const open = [...this.app.documents].find((x) => x.id === item.id && x.repository === repository);
        const data = open ? Result.ok({ data: open.serialize() }) : await repository.load(item.id);
        if (!data.isOk) {
            PubSub.default.pub("showToast", ...repositoryErrorMessage(data.error));
            return;
        }
        const blob = await encodeDocumentFile({ ...data.value.data, name: item.name });
        download([blob], `${item.name}${DOCUMENT_FILE_EXTENSION}`);
    }

    private async delete(item: DocumentMeta, repository: IDocumentRepository) {
        const toTrash = repository.restore !== undefined;
        const prompt = toTrash
            ? I18n.translate("prompt.trashDocument{0}{1}", item.name, repository.trashRetentionDays ?? 0)
            : I18n.translate("prompt.deleteDocument{0}", item.name);
        if (!window.confirm(prompt)) return;
        const deleted = await repository.delete(item.id);
        if (!deleted.isOk) {
            PubSub.default.pub("showToast", "error.repository.deleteFailed{0}", item.name);
            return;
        }
        await this.refresh();
        if (toTrash) {
            PubSub.default.pub(
                "showActionToast",
                "home.toast.trashed{0}",
                {
                    label: "common.undo",
                    run: () =>
                        void repository.restore?.(item.id).then(async (restored) => {
                            if (!restored.isOk) {
                                PubSub.default.pub(
                                    "showToast",
                                    "error.repository.restoreFailed{0}",
                                    item.name,
                                );
                            }
                            await this.refresh();
                        }),
                },
                item.name,
            );
        }
    }

    /** "Upload documents from this device…": a checklist of local documents copied to the cloud. */
    private async showImport(cloud: IDocumentRepository) {
        const items =
            (await this.listAll((query) => this.app.repositories.local.list(query), undefined)) ?? [];
        const checks = items.map((item) => {
            const box = input({ type: "checkbox", checked: true });
            box.dataset["id"] = item.id;
            return { item, box };
        });
        const removeLocal = input({ type: "checkbox" });
        const content = div(
            { className: style.importDialog },
            items.length === 0
                ? div({ textContent: I18n.translate("home.import.empty") })
                : div(
                      { className: style.checklist },
                      ...checks.map(({ item, box }) => label({}, box, span({ textContent: item.name }))),
                  ),
            label({}, removeLocal, span({ textContent: I18n.translate("home.import.removeLocal") })),
        );
        PubSub.default.pub("showDialog", "home.import.title", content, [
            {
                content: "home.import.upload",
                onclick: () => {
                    const chosen = checks.filter((x) => x.box.checked).map((x) => x.item);
                    if (chosen.length === 0) return;
                    PubSub.default.pub(
                        "showPermanent",
                        () => this.upload(chosen, cloud, !removeLocal.checked),
                        "home.import.uploading",
                    );
                },
            },
            { content: "common.cancel" },
        ]);
    }

    private async upload(items: DocumentMeta[], cloud: IDocumentRepository, keepSource: boolean) {
        let uploaded = 0;
        for (const item of items) {
            const result = await transferDocument(this.app, item, cloud, {
                keepSource,
                resolveExisting: askAboutExisting,
            });
            if (result.isOk && result.value.status === "saved") uploaded++;
            else Logger.warn(`home: upload of ${item.id} failed (${JSON.stringify(result)})`);
        }
        PubSub.default.pub("showToast", "home.import.done{0}{1}", uploaded, items.length);
        await this.refresh();
    }

    private handleDocumentClick(item: DocumentMeta, repository: IDocumentRepository) {
        if (this.hasOpen(item)) {
            PubSub.default.pub("displayHome", false);
        } else {
            PubSub.default.pub(
                "showPermanent",
                async () => {
                    const document = await this.app.openDocument(item.id, repository);
                    document?.application.activeView?.cameraController.fitContent();
                },
                "toast.excuting{0}",
                I18n.translate("command.doc.open"),
            );
        }
    }
}

/**
 * The target already has a document with the moved id (a copy kept earlier, or one in the trash):
 * replace it, keep both (the moved one gets a new id), or cancel.
 */
export function askAboutExisting({ name, canReplace }: ExistingDocument): Promise<ExistingDocumentChoice> {
    return new Promise((resolve) => {
        const buttons: DialogButton[] = [
            { content: "cloud.document.keepBoth", onclick: () => resolve("keepBoth") },
            { content: "common.cancel", onclick: () => resolve("cancel") },
        ];
        if (canReplace)
            buttons.unshift({ content: "cloud.document.replace", onclick: () => resolve("replace") });
        PubSub.default.pub(
            "showDialog",
            "cloud.document.existsTitle",
            div({ textContent: I18n.translate("cloud.document.exists{0}", name) }),
            buttons,
        );
    });
}

/** Stops listing if a repository keeps returning pages. */
const MAX_PAGES = 100;

/** "1.2 MB" (decimal units, like file managers). */
export function formatBytes(bytes: number): string {
    if (bytes < 1000) return `${bytes} B`;
    const units = ["kB", "MB", "GB", "TB"];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

customElements.define("spicy-home", Home);
