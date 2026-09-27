// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    AnalysisManager,
    Constants,
    DOCUMENT_FORMAT_VERSION,
    type DocumentFormatError,
    DocumentMigrations,
    History,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    Id,
    InternalClassName,
    type IPicker,
    type ISelection,
    type IVariableTable,
    type IVisual,
    Logger,
    ModelManager,
    Observable,
    ObservableCollection,
    ProjectSettings,
    PubSub,
    type Serialized,
    Serializer,
    VariableTable,
} from "@spicy3d/core";
import { registerAdvancedInspectAnalyses } from "./analysis/advanced";
import { registerBasicInspectAnalyses } from "./analysis/basic";
import { registerPrerequisiteInspectAnalyses } from "./analysis/prerequisites";
import { Picker } from "./picker";
import { SelectionManager } from "./selectionManager";

export class Document extends Observable implements IDocument {
    readonly analyses: AnalysisManager;
    readonly visual: IVisual;
    readonly history: History;
    readonly selection: ISelection;
    readonly picker: IPicker;
    readonly acts = new ObservableCollection<Act>();
    readonly modelManager: ModelManager;
    /** Document-wide parameters shared by every body and sketch. */
    readonly variables: IVariableTable;
    readonly settings: ProjectSettings;
    userData: Record<string, unknown> = {};
    /**
     * Versions the loaded file recorded for modules this build does not register (a plugin that
     * is not loaded), written back unchanged so their payloads keep the version they were saved at.
     */
    private foreignModuleVersions: Record<string, number> = {};

    get name(): string {
        return this.getPrivateValue("name");
    }
    set name(name: string) {
        if (this.name === name) return;
        this.setProperty("name", name);
        if (this.modelManager.rootNode) this.modelManager.rootNode.name = name;
    }

    constructor(
        readonly application: IApplication,
        name: string,
        readonly id: string = Id.generate(),
    ) {
        super();
        this.setPrivateValue("name", name);
        this.modelManager = new ModelManager(this);
        this.history = new History();
        this.variables = new VariableTable(this);
        this.settings = new ProjectSettings(this);
        this.selection = new SelectionManager(this);
        this.picker = new Picker(this);
        this.visual = application.visualFactory.create(this);
        this.analyses = new AnalysisManager(this);
        registerBasicInspectAnalyses(this.analyses);
        registerAdvancedInspectAnalyses(this.analyses);
        registerPrerequisiteInspectAnalyses(this.analyses);

        application.documents.add(this);
        PubSub.default.pub("documentOpened", this);
    }

    serialize(): Serialized {
        const serialized = {
            [InternalClassName]: "Document",
            formatVersion: DOCUMENT_FORMAT_VERSION,
            moduleVersions: { ...this.foreignModuleVersions, ...DocumentMigrations.moduleVersions() },
            id: this.id,
            name: this.name,
            models: this.modelManager.serialize(),
            variables: this.variables.items,
            settings: this.settings.toData(),
            acts: this.acts.map((x) => Serializer.serializeObject(x)),
            userData: this.userData,
        };
        return serialized;
    }

    override disposeInternal(): void {
        super.disposeInternal();

        this.analyses.dispose();
        this.modelManager.dispose();
        this.visual.dispose();
        this.history.dispose();
        this.variables.dispose();
        this.settings.dispose();
        this.selection.dispose();
        this.acts.forEach((x) => x.dispose());
        this.acts.clear();
    }

    async save() {
        const data = this.serialize();
        await this.application.storage.put(Constants.DBName, Constants.DocumentTable, this.id, data);
        const image = this.application.activeView?.toImage();
        await this.application.storage.put(Constants.DBName, Constants.RecentTable, this.id, {
            id: this.id,
            name: this.name,
            date: Date.now(),
            image,
        });
    }

    async close() {
        if (window.confirm(I18n.translate("prompt.saveDocument{0}", this.name))) {
            await this.save();
        }

        const views = this.application.views.filter((x) => x.document === this);
        this.application.views.remove(...views);
        this.application.activeView = this.application.views.at(0);
        this.application.documents.delete(this);

        PubSub.default.pub("documentClosed", this);

        Logger.info(`document: ${this.name} closed`);
        this.dispose();
    }

    static async open(application: IApplication, id: string) {
        const data = (await application.storage.get(
            Constants.DBName,
            Constants.DocumentTable,
            id,
        )) as Serialized;
        if (data === undefined) {
            Logger.warn(`document: ${id} not find`);
            return;
        }
        const document = await Document.load(application, data);
        if (document !== undefined) {
            Logger.info(`document: ${document.name} opened`);
        }
        return document;
    }

    /**
     * Opens a serialized document, first migrating it up to this build's format. A file that is
     * not a Spicy3D document, or that a newer build saved, is reported with a toast and left
     * untouched — `data` itself is never modified.
     */
    static async load(app: IApplication, stored: Serialized): Promise<IDocument | undefined> {
        const migrated = DocumentMigrations.migrate(stored);
        if (!migrated.isOk) {
            Document.reportFormatError(migrated.error);
            return undefined;
        }
        const data = migrated.value;

        const document = new Document(app, data["name"], data["id"]);
        document.foreignModuleVersions = Document.foreignVersionsOf(data["moduleVersions"]);
        document.history.disabled = true;
        // Before the models: a body's feature chain resolves its parameters against
        // the table, and deserializing a body rebuilds it.
        document.variables.setItems(data["variables"] ?? []);
        // Files from before project settings read as the defaults (millimetres).
        document.settings.load(data["settings"]);
        document.acts.push(...data["acts"].map((x: Serialized) => Serializer.deserializeObject(document, x)));
        if (data["userData"]) {
            document.userData = data["userData"];
        }

        await document.modelManager.deserialize(data["models"]);
        document.analyses.attachModel();
        document.history.disabled = false;
        return document;
    }

    private static foreignVersionsOf(moduleVersions: Record<string, number>): Record<string, number> {
        const registered = DocumentMigrations.moduleVersions();
        return Object.fromEntries(
            Object.entries(moduleVersions).filter(([module]) => !(module in registered)),
        );
    }

    private static reportFormatError(error: DocumentFormatError) {
        Logger.warn(`document: cannot open (${JSON.stringify(error)})`);
        const [key, ...args]: [I18nKeys, ...unknown[]] =
            error.kind === "notSpicy3D"
                ? ["error.document.notSpicy3D"]
                : error.kind === "newerFormat"
                  ? ["error.document.newerFormat"]
                  : ["error.document.migrationFailed:{0}", `${error.module}@${error.from}: ${error.message}`];
        PubSub.default.pub("showToast", key, ...args);
    }
}
