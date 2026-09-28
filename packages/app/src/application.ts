// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    DocumentRepositories,
    type DocumentSource,
    I18n,
    type IApplication,
    type ICommand,
    type IDataExchange,
    type IDocument,
    type IDocumentRepository,
    type IPluginManager,
    type IService,
    type IShapeProvider,
    type IStorage,
    type IView,
    type IVisualFactory,
    type IWindow,
    isDocumentFileName,
    Logger,
    Material,
    MergeEvaluators,
    Observable,
    ObservableCollection,
    PLUGIN_FILE_EXTENSION,
    Plane,
    PubSub,
    redactSecrets,
    redactUrl,
    type Serialized,
    setCurrentApplication,
    VisualConfig,
    type VisualItemConfig,
} from "@spicy3d/core";
import { Document } from "./document";
import { type DocumentFileEntry, openDocumentFile } from "./documentFiles";
import { approveExternalFile, isPluginUrl, urlFileName } from "./externalFile";
import { HeadlessDocumentEvaluator } from "./mergeEvaluator";
import { PluginManager } from "./pluginManager";
import { LocalDocumentRepository } from "./repositories";
import { importFiles } from "./utils";

export interface ApplicationOptions {
    visualFactory: IVisualFactory;
    shapeProvider: IShapeProvider;
    services: IService[];
    storage: IStorage;
    dataExchange: IDataExchange;
    mainWindow?: IWindow;
}

export class Application extends Observable implements IApplication {
    readonly dataExchange: IDataExchange;
    readonly visualFactory: IVisualFactory;
    readonly shapeProvider: IShapeProvider;
    readonly services: IService[];
    readonly storage: IStorage;
    readonly repositories: DocumentRepositories;
    readonly mainWindow?: IWindow;
    readonly pluginManager: IPluginManager;
    readonly views = new ObservableCollection<IView>();
    readonly documents: Set<IDocument> = new Set<IDocument>();

    lastCommand: CommandKeys | undefined;

    get executingCommand(): ICommand | undefined {
        return this.getPrivateValue("executingCommand", undefined);
    }
    set executingCommand(value: ICommand | undefined) {
        this.setProperty("executingCommand", value);
    }

    get activeView(): IView | undefined {
        return this.getPrivateValue("activeView", undefined);
    }
    set activeView(value: IView | undefined) {
        this.setProperty("activeView", value, () => {
            PubSub.default.pub("activeViewChanged", value);
        });
    }

    constructor(option: ApplicationOptions) {
        super();

        setCurrentApplication(this);
        // the merge's validation pass rebuilds versions in headless documents of this application
        MergeEvaluators.register(new HeadlessDocumentEvaluator(this));
        this.visualFactory = option.visualFactory;
        this.shapeProvider = option.shapeProvider;
        this.services = option.services;
        this.storage = option.storage;
        this.repositories = new DocumentRepositories(new LocalDocumentRepository(option.storage));
        this.dataExchange = option.dataExchange;
        this.mainWindow = option.mainWindow;
        this.pluginManager = new PluginManager(this);
        this.services.forEach((x) => x.register(this));
        this.services.forEach((x) => x.start());
        this.initEvents();
    }

    private initEvents() {
        window.onbeforeunload = this.handleWindowUnload;
        this.mainWindow?.addEventListener("dragstart", this.handleDragStart);
        this.mainWindow?.addEventListener("dragover", this.handleDragOver);
        this.mainWindow?.addEventListener("drop", this.handleDrop);
        VisualConfig.onPropertyChanged(this.onVisualConfigChanged);
    }

    private readonly onVisualConfigChanged = (property: keyof VisualItemConfig) => {
        if (property === "defaultEdgeColor") {
            this.views.forEach((x) => x.update());
        }
    };

    private readonly handleWindowUnload = (event: BeforeUnloadEvent) => {
        if ([...this.documents].some((x) => x.isDirty)) {
            // Cancel the event as stated by the standard.
            event.preventDefault();
            // Chrome requires returnValue to be set.
            event.returnValue = "";
        }
    };

    private readonly handleDragStart = (ev: DragEvent) => {
        // Internal drags (feature-list reorder, project tree) start from elements
        // marked draggable — let them proceed; only block the browser's native
        // drags (selected text, images, links).
        if ((ev.target as HTMLElement | null)?.closest?.("[draggable='true']")) return;
        ev.preventDefault();
    };

    private readonly handleDragOver = (ev: DragEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (ev.dataTransfer) {
            ev.dataTransfer.dropEffect = "copy";
        }
    };

    private readonly handleDrop = (ev: DragEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        // File handles must be requested while the drop event is dispatched.
        const handles = this.requestDroppedFileHandles(ev.dataTransfer);
        const files = this.extractDroppedFiles(ev.dataTransfer);
        this.importFiles(files, handles);
    };

    /**
     * Opens documents, loads plugins and imports every other file. `handles` are the dropped
     * files' File System Access handles by name, letting a document save back to its file.
     */
    async importFiles(
        files: File[] | FileList | undefined,
        handles?: Promise<Map<string, FileSystemFileHandle>>,
    ) {
        if (!files || files.length === 0) {
            return;
        }
        const { opens, imports, plugins } = this.groupFiles(files);
        this.loadPluginsWithLoading(plugins);
        this.loadDocumentsWithLoading(opens, handles);
        importFiles(this, imports);
    }

    private loadPluginsWithLoading(plugins: File[]) {
        PubSub.default.pub(
            "showPermanent",
            async () => {
                for (const pluginFile of plugins) {
                    await this.pluginManager.loadFromFile(pluginFile);
                }
            },
            "toast.executing{0}",
            I18n.translate("command.doc.open"),
        );
    }

    private loadDocumentsWithLoading(opens: File[], handles?: Promise<Map<string, FileSystemFileHandle>>) {
        PubSub.default.pub(
            "showPermanent",
            async () => {
                const byName = (await handles) ?? new Map<string, FileSystemFileHandle>();
                for (const file of opens) {
                    const entry: DocumentFileEntry = { file, handle: byName.get(file.name) };
                    const document = await openDocumentFile(this, entry);
                    document?.application.activeView?.cameraController.fitContent();
                }
            },
            "toast.executing{0}",
            I18n.translate("command.doc.open"),
        );
    }

    private groupFiles(files: FileList | File[]) {
        const opens: File[] = [];
        const imports: File[] = [];
        const plugins: File[] = [];
        for (const element of files) {
            const fileName = element.name.toLowerCase();
            if (isDocumentFileName(fileName)) {
                opens.push(element);
            } else if (fileName.endsWith(PLUGIN_FILE_EXTENSION)) {
                plugins.push(element);
            } else {
                imports.push(element);
            }
        }
        return { opens, imports, plugins };
    }

    private extractDroppedFiles(dataTransfer: DataTransfer | null): File[] {
        if (!dataTransfer) return [];
        const fromFileList = Array.from(dataTransfer.files ?? []);
        if (fromFileList.length > 0) return fromFileList;
        const fromItems = Array.from(dataTransfer.items ?? [])
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
        return fromItems;
    }

    private requestDroppedFileHandles(
        dataTransfer: DataTransfer | null,
    ): Promise<Map<string, FileSystemFileHandle>> | undefined {
        type HandleItem = DataTransferItem & {
            getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
        };
        const items = Array.from(dataTransfer?.items ?? []) as HandleItem[];
        const requests = items
            .filter((item) => item.kind === "file")
            .flatMap((item) =>
                item.getAsFileSystemHandle ? [item.getAsFileSystemHandle().catch(() => null)] : [],
            );
        if (requests.length === 0) return undefined;
        return Promise.all(requests).then(
            (handles) =>
                new Map(
                    handles
                        .filter((x): x is FileSystemFileHandle => x?.kind === "file")
                        .filter((x) => isDocumentFileName(x.name))
                        .map((x) => [x.name, x] as const),
                ),
        );
    }

    /**
     * Opens a stored document; when it is already open (same id, same repository), shows that one
     * instead of a second copy that would save over it.
     */
    async openDocument(id: string, repository?: IDocumentRepository): Promise<IDocument | undefined> {
        const source = repository ?? this.repositories.local;
        const open = [...this.documents].find((x) => x.id === id && x.repository === source);
        if (open) {
            const view = this.views.find((x) => x.document === open);
            if (view) this.activeView = view;
            else await this.createActiveView(open);
            return open;
        }
        const document = await Document.open(this, id, repository);
        await this.createActiveView(document);
        return document;
    }

    async newDocument(name: string, repository?: IDocumentRepository): Promise<IDocument> {
        const document = new Document(this, name, undefined, {
            repository: repository ?? this.repositories.forNewDocuments(),
        });
        const lightGray = new Material({ document, name: "LightGray", color: 0xdedede });
        const deepGray = new Material({ document, name: "DeepGray", color: 0x898989 });
        document.modelManager.materials.push(lightGray, deepGray);
        await this.createActiveView(document);
        return document;
    }

    async loadDocument(data: Serialized, source?: DocumentSource): Promise<IDocument | undefined> {
        const document = await Document.load(this, data, source);
        await this.createActiveView(document);
        return document;
    }

    /**
     * Opens the file at `url` (`?url=` / `?model=`): the app's own origin and the deployment's
     * allowlist at once, any other origin only once the user confirms (`approveExternalFile`).
     * Cross-origin requests carry no cookies. A `.spicyplugin` is code, not a file: it goes through
     * the plugin rules (`PluginManager.loadFromUrl`), never through this prompt.
     */
    async loadFileFromUrl(url: string): Promise<void> {
        return Promise.try(async () => {
            if (isPluginUrl(url)) {
                await this.pluginManager.loadFromUrl(url);
                return;
            }
            const approved = await approveExternalFile(url);
            if (!approved) return;
            const filename = urlFileName(approved);
            if (filename.toLowerCase().endsWith(PLUGIN_FILE_EXTENSION)) return; // never imported as a file
            if (!filename || !filename.includes(".")) {
                throw new Error(`No file name in url: ${redactUrl(approved)}`);
            }

            const response = await fetch(approved.href, { credentials: "same-origin" });
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch model: ${redactUrl(approved)}, statusText: ${response.statusText}`,
                );
            }

            const blob = await response.blob();
            const file = new File([blob], filename, { type: blob.type });
            await this.importFiles([file]);
        }).catch((err) => {
            Logger.error(err instanceof Error ? redactSecrets(err.message) : redactSecrets(String(err)));
        });
    }

    protected async createActiveView(document: IDocument | undefined) {
        if (document === undefined) return undefined;
        const view = document.visual.createView("3d", Plane.XY);
        this.activeView = view;
    }
}
