// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Constants,
    I18n,
    type I18nKeys,
    type IApplication,
    Localize,
    ObservableCollection,
    PubSub,
    type RecentDocumentDTO,
} from "@spicy3d/core";
import { a, button, collection, div, img, label, span, svg } from "@spicy3d/element";
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
    constructor(readonly app: IApplication) {
        super();
        this.className = style.root;
    }

    private hasOpen(documentId: string) {
        for (const document of this.app.documents) {
            if (document.id === documentId) return true;
        }
        return false;
    }

    private async getDocuments() {
        return new ObservableCollection(
            ...(await this.app.storage.page(Constants.DBName, Constants.RecentTable, 0)),
        );
    }

    async render() {
        const documents = await this.getDocuments();
        this.append(this.leftSection(), this.rightSection(documents));
        this.app.mainWindow?.appendChild(this);
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

    private rightSection(documents: ObservableCollection<RecentDocumentDTO>) {
        return div(
            { className: style.right },
            div(
                { className: style.page },
                div(
                    { className: style.header },
                    div({ className: style.welcome, textContent: new Localize("home.welcome") }),
                    div({ className: style.subtitle, textContent: new Localize("home.welcome.subtitle") }),
                ),
                div(
                    { className: style.contentRow },
                    div(
                        { className: style.recentColumn },
                        div({ className: style.sectionTitle, textContent: new Localize("home.recent") }),
                        this.documentCollection(documents),
                    ),
                ),
            ),
        );
    }

    private documentCollection(documents: ObservableCollection<RecentDocumentDTO>) {
        if (documents.length === 0) {
            return div({
                className: style.empty,
                textContent: new Localize("home.recent.empty"),
            });
        }
        return collection({
            className: style.documents,
            sources: documents,
            template: (item) => this.recentDocument(item, documents),
        });
    }

    private recentDocument(item: RecentDocumentDTO, documents: ObservableCollection<RecentDocumentDTO>) {
        return div(
            {
                className: style.document,
                onclick: () => this.handleDocumentClick(item),
            },
            img({ className: style.img, src: item.image }),
            this.documentDescription(item),
            this.deleteIcon(item, documents),
        );
    }

    private documentDescription(item: RecentDocumentDTO) {
        return div(
            { className: style.description },
            span({ className: style.title, textContent: item.name }),
            span({
                className: style.date,
                textContent: new Date(item.date).toLocaleDateString(),
            }),
        );
    }

    private deleteIcon(item: RecentDocumentDTO, documents: ObservableCollection<RecentDocumentDTO>) {
        return svg({
            className: style.delete,
            icon: "icon-times",
            onclick: async (e) => {
                e.stopPropagation();
                if (window.confirm(I18n.translate("prompt.deleteDocument{0}", item.name))) {
                    await Promise.all([
                        this.app.storage.delete(Constants.DBName, Constants.DocumentTable, item.id),
                        this.app.storage.delete(Constants.DBName, Constants.RecentTable, item.id),
                    ]);
                    documents.remove(item);
                }
            },
        });
    }

    private handleDocumentClick(item: RecentDocumentDTO) {
        if (this.hasOpen(item.id)) {
            PubSub.default.pub("displayHome", false);
        } else {
            PubSub.default.pub(
                "showPermanent",
                async () => {
                    const document = await this.app.openDocument(item.id);
                    document?.application.activeView?.cameraController.fitContent();
                },
                "toast.excuting{0}",
                I18n.translate("command.doc.open"),
            );
        }
    }
}

customElements.define("spicy-home", Home);
