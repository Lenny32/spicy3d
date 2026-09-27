// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IApplication,
    type ICommand,
    type IDataExchange,
    type IDocument,
    type IPluginManager,
    type IShapeProvider,
    type IStorage,
    type IView,
    type IVisualFactory,
    ObservableCollection,
} from "../src";
import { createMockVisualWithDocument } from "./mockVisual";

export interface MockApplicationOverrides {
    storage?: Partial<IStorage>;
    visualFactory?: Partial<IVisualFactory>;
    shapeProvider?: Partial<IShapeProvider>;
    dataExchange?: Partial<IDataExchange>;
    services?: any[];
    pluginManager?: Partial<IPluginManager>;
}

/**
 * Create a configurable mock IApplication for unit tests.
 * The returned object implements the full IApplication interface with sensible defaults.
 */
export function createMockApplication(overrides: MockApplicationOverrides = {}): IApplication {
    const mockDocuments = new Set<IDocument>();
    const mockViews = new ObservableCollection<IView>();

    const app: IApplication = {
        storage: {
            createDBIfNeeded: async () => {},
            get: async () => undefined,
            put: async () => true,
            delete: async () => true,
            page: async () => [],
            ...overrides.storage,
        } as IStorage,
        visualFactory: {
            kernelName: "mock",
            create: (doc: IDocument) => ({
                ...createMockVisualWithDocument(doc),
                resetEventHandler: () => {},
                isExcutingHandler: () => false,
            }),
            ...overrides.visualFactory,
        } as unknown as IVisualFactory,
        shapeProvider: {
            factory: {} as any,
            converter: {} as any,
            ...overrides.shapeProvider,
        } as IShapeProvider,
        dataExchange: {
            import: async () => {},
            export: async () => new Blob(),
            importFormats: () => [] as string[],
            exportFormats: () => [] as string[],
            exportUnitHandling: () => ({ kind: "none" }),
            ...overrides.dataExchange,
        } as IDataExchange,
        services: overrides.services ?? [],
        pluginManager: {
            loadFromFile: async () => {},
            loadFromUrl: async () => {},
            unload: async () => {},
            unloadAll: () => {},
            getPlugins: () => [],
            get: () => undefined,
            isLoaded: () => false,
            ...overrides.pluginManager,
        },
        views: mockViews,
        documents: mockDocuments,
        activeView: undefined,
        lastCommand: undefined,
        executingCommand: undefined,
        dispose: () => {},
        removePropertyChanged: () => {},
        clearPropertyChanged: () => {},
        onPropertyChanged: () => {},
        newDocument: async () => ({}) as IDocument,
        openDocument: async () => undefined,
        loadDocument: async () => undefined,
        loadFileFromUrl: async () => {},
    };

    return app;
}

/**
 * Create a mock ICommand for testing.
 */
export function createMockCommand(overrides: Partial<ICommand> = {}): ICommand {
    return {
        execute: async () => {},
        ...overrides,
    };
}

/**
 * Create a mock cancelable command for testing.
 */
export function createMockCancelableCommand(
    overrides: Partial<{
        execute: () => Promise<void>;
        cancel: () => Promise<void>;
        dispose: () => void;
    }> = {},
): ICommand {
    return {
        execute: overrides.execute ?? (async () => {}),
        cancel: overrides.cancel ?? (async () => {}),
        dispose: overrides.dispose ?? (() => {}),
    } as any;
}
