// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Act,
    AnalysisManager,
    type CloseDocumentOptions,
    DOCUMENT_FORMAT_VERSION,
    type DocumentFormatError,
    DocumentMigrations,
    type DocumentRepositoryError,
    type DocumentSource,
    History,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
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
    type Result,
    repositoryErrorMessage,
    type SaveConflict,
    type SaveKind,
    type SaveOutcome,
    type Serialized,
    Serializer,
    VariableTable,
} from "@spicy3d/core";
import { registerAdvancedInspectAnalyses } from "./analysis/advanced";
import { registerBasicInspectAnalyses } from "./analysis/basic";
import { registerPrerequisiteInspectAnalyses } from "./analysis/prerequisites";
import { Picker } from "./picker";
import { askToSaveChanges } from "./saveChangesPrompt";
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
    repository: IDocumentRepository;
    version?: string;
    /** `history.position()` at the last save (or at the opening). */
    private savedPosition: object;
    private closing = false;

    get name(): string {
        return this.getPrivateValue("name");
    }
    set name(name: string) {
        if (this.name === name) return;
        this.setProperty("name", name);
        if (this.modelManager.rootNode) this.modelManager.rootNode.name = name;
    }

    /** Whether the undo position differs from the one of the last save. Observable. */
    get isDirty(): boolean {
        return this.getPrivateValue("isDirty", false);
    }

    constructor(
        readonly application: IApplication,
        name: string,
        readonly id: string = Id.generate(),
        source: DocumentSource = {},
    ) {
        super();
        this.setPrivateValue("name", name);
        this.repository = source.repository ?? application.repositories.local;
        this.version = source.version;
        this.modelManager = new ModelManager(this);
        this.history = new History();
        this.savedPosition = this.history.position();
        this.history.onChanged.sub(this.updateDirty);
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

    private readonly updateDirty = () => {
        this.setProperty("isDirty", this.history.position() !== this.savedPosition);
    };

    /** Takes the current undo position as the saved one (after a save, or once loaded). */
    private markSaved() {
        this.savedPosition = this.history.position();
        this.updateDirty();
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

    /**
     * Saves one at a time: a save requested while one runs waits for it (its base version is the
     * one that save produces, so the two never conflict with each other), and every request made
     * meanwhile shares that single follow-up save — manual if any of them was.
     */
    save(kind: SaveKind = "manual"): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        if (this.followUp) {
            if (kind === "manual") this.followUp.kind = "manual";
            return this.followUp.promise;
        }
        if (!this.running) return this.startSave(kind);
        const followUp = {
            kind,
            promise: undefined as unknown as Promise<Result<SaveOutcome, DocumentRepositoryError>>,
        };
        followUp.promise = this.running.then(() => {
            this.followUp = undefined;
            return this.startSave(followUp.kind);
        });
        this.followUp = followUp;
        return followUp.promise;
    }

    /** Resolves once no save of this document is running or queued. */
    async settled(): Promise<void> {
        while (this.followUp || this.running) await (this.followUp?.promise ?? this.running);
    }

    private running?: Promise<unknown>;
    private followUp?: { kind: SaveKind; promise: Promise<Result<SaveOutcome, DocumentRepositoryError>> };

    private startSave(kind: SaveKind): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const promise = this.saveNow(kind);
        const running = promise.finally(() => {
            if (this.running === running) this.running = undefined;
        });
        this.running = running;
        return promise;
    }

    private async saveNow(kind: SaveKind): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const position = this.history.position();
        const result = await this.repository.save({
            id: this.id,
            name: this.name,
            data: this.serialize(),
            kind,
            thumbnail: this.ownView()?.toImage(),
            baseVersion: this.version,
        });
        if (result.isOk && result.value.status === "saved") {
            this.version = result.value.version ?? this.version;
            // The position the data was serialized at: edits made while saving stay unsaved.
            this.savedPosition = position;
            this.updateDirty();
        }
        return result;
    }

    /** The view the thumbnail is taken from: the active one when it shows this document. */
    private ownView() {
        const active = this.application.activeView;
        return active?.document === this ? active : this.application.views.find((x) => x.document === this);
    }

    async close(options: CloseDocumentOptions = {}): Promise<boolean> {
        if (this.closing) return true;
        if (!options.discardChanges && this.isDirty && !(await this.saveBeforeClosing())) return false;

        this.closing = true;
        // Deregistered first: a view closing sees its document is no longer open and does not
        // ask it to close again.
        this.application.documents.delete(this);
        const views = this.application.views.filter((x) => x.document === this);
        views.forEach((view) => view.close());
        this.application.views.remove(...views);
        this.application.activeView = this.application.views.at(0);

        PubSub.default.pub("documentClosed", this);

        Logger.info(`document: ${this.name} closed`);
        this.dispose();
        return true;
    }

    /** Resolves whether closing may go on: changes saved or discarded, not cancelled. */
    private async saveBeforeClosing(): Promise<boolean> {
        const choice = await askToSaveChanges(this.name);
        if (choice === "cancel") return false;
        if (choice === "discard") return true;
        const saved = await this.save();
        if (saved.isOk && saved.value.status === "saved") return true;
        if (saved.isOk && saved.value.status === "conflict") {
            // The conflict dialog decides; the document stays open unless it closes it.
            await reportSaveConflict(this.application, this, saved.value);
            return false;
        }
        PubSub.default.pub("showToast", ...repositoryErrorMessage(saved.error));
        return false;
    }

    static async open(
        application: IApplication,
        id: string,
        repository: IDocumentRepository = application.repositories.local,
    ): Promise<IDocument | undefined> {
        const loaded = await repository.load(id);
        if (!loaded.isOk) {
            Logger.warn(`document: cannot open ${id} (${JSON.stringify(loaded.error)})`);
            PubSub.default.pub("showToast", ...repositoryErrorMessage(loaded.error));
            return undefined;
        }
        const document = await Document.load(application, loaded.value.data, {
            repository,
            version: loaded.value.version,
        });
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
    static async load(
        app: IApplication,
        stored: Serialized,
        source: DocumentSource = {},
    ): Promise<IDocument | undefined> {
        const migrated = DocumentMigrations.migrate(stored);
        if (!migrated.isOk) {
            Document.reportFormatError(migrated.error);
            return undefined;
        }
        const data = migrated.value;

        const document = new Document(app, data["name"], data["id"], source);
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
        document.markSaved();
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

/** Hands a save conflict to the cloud's dialog when there is one, toasts it otherwise. */
export async function reportSaveConflict(
    app: IApplication,
    document: IDocument,
    conflict: SaveConflict,
): Promise<void> {
    const handler = app.repositories.conflictHandler;
    if (handler) {
        await handler(document, conflict);
    } else {
        PubSub.default.pub("showToast", "error.repository.conflict");
    }
}
