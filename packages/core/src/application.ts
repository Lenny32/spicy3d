// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys, ICommand } from "./command";
import type { IDataExchange } from "./dataExchange";
import type { IDocument } from "./document";
import type {
    DocumentRepositories,
    IDocumentRepository,
    IPropertyChanged,
    IStorage,
    ObservableCollection,
} from "./foundation";
import type { IPluginManager } from "./plugin";
import type { Serialized } from "./serialize";
import type { IService } from "./service";
import type { IShapeConverter, IShapeFactory, IShapeProvider } from "./shape";
import type { IWindow } from "./ui/window";
import type { IView, IVisualFactory } from "./visual";

/** Where an opened document came from, so it saves back there. */
export interface DocumentSource {
    repository?: IDocumentRepository;
    version?: string;
}

export interface IApplication extends IPropertyChanged {
    readonly mainWindow?: IWindow;
    readonly dataExchange: IDataExchange;
    readonly visualFactory: IVisualFactory;
    readonly shapeProvider: IShapeProvider;
    readonly services: IService[];
    readonly storage: IStorage;
    /** Document persistence: `local` always, `cloud` while signed in. */
    readonly repositories: DocumentRepositories;
    readonly views: ObservableCollection<IView>;
    readonly documents: Set<IDocument>;
    readonly pluginManager: IPluginManager;
    lastCommand: CommandKeys | undefined;
    executingCommand: ICommand | undefined;
    activeView: IView | undefined;
    /** A new, empty document; it saves to `repository` (default: `repositories.forNewDocuments()`). */
    newDocument(name: string, repository?: IDocumentRepository): Promise<IDocument>;
    /** Opens a stored document; `repository` defaults to the local one. */
    openDocument(id: string, repository?: IDocumentRepository): Promise<IDocument | undefined>;
    /** Opens serialized data (e.g. a `.spicy` file); the document then saves to `source.repository`. */
    loadDocument(data: Serialized, source?: DocumentSource): Promise<IDocument | undefined>;
    loadFileFromUrl(url: string): Promise<void>;
}

let currentApplication: IApplication;
export function getCurrentApplication() {
    if (!currentApplication) {
        throw new Error(
            "No application instance is set. Please create an instance of Application before accessing it.",
        );
    }
    return currentApplication;
}

export function setCurrentApplication(app: IApplication): void {
    if (currentApplication) {
        throw new Error("An application instance is already set. Multiple instances are not allowed.");
    }
    currentApplication = app;
}

declare global {
    var app: IApplication;
    var shapeFactory: IShapeFactory;
    var shapeConverter: IShapeConverter;
    var activeView: IView | undefined;
    var activeDocument: IDocument | undefined;
}

Object.defineProperty(globalThis, "app", {
    configurable: true,
    get() {
        const app = getCurrentApplication();
        return app;
    },
});

Object.defineProperty(globalThis, "shapeFactory", {
    configurable: true,
    get() {
        return app.shapeProvider.factory;
    },
});

Object.defineProperty(globalThis, "shapeConverter", {
    configurable: true,
    get() {
        return app.shapeProvider.converter;
    },
});

Object.defineProperty(globalThis, "activeView", {
    configurable: true,
    get() {
        return app.activeView;
    },
});

Object.defineProperty(globalThis, "activeDocument", {
    configurable: true,
    get() {
        return app.activeView?.document;
    },
});
