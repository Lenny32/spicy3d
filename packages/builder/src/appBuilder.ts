// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Application,
    AutosaveService,
    CommandService,
    HotkeyService,
    ShowPropertyEventHandler,
} from "@spicy3d/app";
import type { AccountLink } from "@spicy3d/cloud/src/links";
import {
    Config,
    Constants,
    I18n,
    type IApplication,
    type IDataExchange,
    type IService,
    type IShapeProvider,
    type IStorage,
    type IVisualFactory,
    type IWindow,
    type Locale,
    Logger,
} from "@spicy3d/core";
import { DefaultDataExchange } from "./defaultDataExchange";
import {
    DefaultRibbon,
    mergeRibbonProfiles,
    ParametricRibbonProfiles,
    type RibbonProfileExtra,
} from "./ribbon";

/** See `useCloud`. */
export interface UseCloudOptions {
    /** Where the server's `/api` lives; defaults to the folder the app is served from (same origin). */
    baseUrl?: string;
    /** An account email link the app was opened with (verify email, reset password…); see `takeAccountLink`. */
    accountLink?: AccountLink;
}

export class AppBuilder {
    protected readonly _inits: (() => Promise<void>)[] = [];
    /** Run once the application and its window exist, without delaying startup. */
    protected readonly _started: ((app: IApplication) => Promise<void>)[] = [];
    protected readonly _ribbonExtras: RibbonProfileExtra[] = [];
    protected _storage?: IStorage;
    protected _visualFactory?: IVisualFactory;
    protected _shapeProvider?: IShapeProvider;
    protected _window?: IWindow;

    /** Settles once every post-startup step (e.g. cloud discovery) has run; failures are only logged. */
    started: Promise<void> = Promise.resolve();

    constructor() {
        this.initI18n();
        this.initConfig();
        this.ensureAPI();
    }

    protected ensureAPI() {
        this._inits.push(async () => {
            Logger.info("initializing api");

            (globalThis as any).Spicy3DCore = await import("@spicy3d/core");
            (globalThis as any).Spicy3DElement = await import("@spicy3d/element");
        });
    }

    protected initConfig() {
        Config.instance.init("config");
        return this;
    }

    protected initI18n() {
        this._inits.push(async () => {
            Logger.info("initializing i18n");

            const i18n = await import("@spicy3d/i18n");
            for (const key of Object.keys(i18n)) {
                I18n.addLanguage((i18n as { [key: string]: Locale })[key]);
            }
        });
    }

    useIndexedDB() {
        this._inits.push(async () => {
            Logger.info("initializing IndexedDBStorage");

            const db = await import("@spicy3d/storage");
            this._storage = new db.IndexedDBStorage();
            await this._storage.createDBIfNeeded(Constants.DBName, [
                Constants.DocumentTable,
                Constants.RecentTable,
            ]);
        });
        return this;
    }

    useWasmOcc() {
        this._inits.push(async () => {
            Logger.info("initializing wasm occ");

            const wasm = await import("@spicy3d/wasm");
            await wasm.initWasm();
            this._shapeProvider = new wasm.OccShapeProvider();
        });
        return this;
    }

    useParametric(): this {
        this._inits.push(async () => {
            Logger.info("initializing parametric");

            // registers sketch/feature commands, the SketchNode/ParametricBodyNode
            // serializers, and exposes the sketch ribbon contributions
            const parametric = await import("@spicy3d/parametric");
            await parametric.initPlaneGcs();
            // Sketch last so `sketch.create` lands in front of the feature commands.
            this._ribbonExtras.push(...ParametricRibbonProfiles, ...parametric.SketchRibbonProfiles);
        });
        return this;
    }

    useThree(): this {
        this._inits.push(async () => {
            Logger.info("initializing three");

            const three = await import("@spicy3d/three");
            this._visualFactory = new three.ThreeVisulFactory((d) => new ShowPropertyEventHandler(d));
        });
        return this;
    }

    useUI(): this {
        this._inits.push(async () => {
            Logger.info("initializing MainWindow");

            const ui = await import("@spicy3d/ui");
            const app = document.getElementById("app") as HTMLElement;
            this._window = new ui.MainWindow(await this.getRibbonTabs(), "iconfont.js", app);
        });
        return this;
    }

    /**
     * Connects to a Spicy3D server when one answers `GET /api/config`; otherwise (static hosting,
     * no server) the cloud stays dormant and shows no UI. Runs after startup, and loads the API
     * client and the account UI only once a server is found.
     */
    useCloud(options: UseCloudOptions = {}): this {
        this._started.push(async (app) => {
            const { discoverCloud } = await import("@spicy3d/cloud/src/config");
            const { accountLink, ...connection } = options;
            const discovery = await discoverCloud(connection);
            if (discovery.status === "dormant") {
                if (accountLink) Logger.warn("[cloud] opened with an account link, but no server answers");
                return;
            }

            Logger.info(
                `initializing cloud (server ${discovery.config.version}, API ${discovery.config.apiVersion})`,
            );
            const cloud = await import("@spicy3d/cloud");
            const started = cloud.startCloud(discovery, connection);
            if (!started) {
                // An incompatible server: the banner says so; the link can't be used either.
                if (accountLink)
                    Logger.warn("[cloud] opened with an account link, but the server is incompatible");
                return;
            }
            cloud.startCloudSettings(started);
            await cloud.startAccountUi(started, accountLink);
            cloud.startCloudDocuments(started, app);
        });
        return this;
    }

    async getRibbonTabs() {
        return mergeRibbonProfiles(DefaultRibbon, this._ribbonExtras);
    }

    async build(): Promise<IApplication> {
        for (const init of this._inits) {
            await init();
        }
        this.ensureNecessary();

        const app = this.createApp();
        await this._window?.init(app);
        await this.loadDefaultPlugins(app);
        this.started = this.runStarted(app);

        Logger.info("Application build completed");

        return app;
    }

    protected async runStarted(app: IApplication) {
        await Promise.all(
            this._started.map((step) =>
                step(app).catch((error) => Logger.warn(`startup step failed: ${error}`)),
            ),
        );
    }

    protected async loadDefaultPlugins(app: IApplication) {
        const urlObj = new URL(window.location.href);
        const pathParts = urlObj.pathname
            .split("/")
            .map((x) => x.trim())
            .filter((x) => x.length > 0);
        if (pathParts.at(-1)?.endsWith(".html")) pathParts.pop();
        urlObj.pathname = `${pathParts.join("/")}/`;
        const folderUrl = `${urlObj.href}plugins/`;
        try {
            const response = await fetch(`${folderUrl}plugins.json`);
            if (!response.ok) {
                return;
            }
            const config = await response.json();
            const plugins = config.plugins as string[];
            for (const plugin of plugins ?? []) {
                await app.pluginManager.loadFromUrl(folderUrl + plugin);
            }
        } catch {
            Logger.warn(`Failed to load plugins from folder: ${folderUrl}`);
        }
    }

    createApp() {
        return new Application({
            storage: this._storage!,
            shapeProvider: this._shapeProvider!,
            visualFactory: this._visualFactory!,
            services: this.getServices(),
            mainWindow: this._window,
            dataExchange: this.initDataExchange(),
        });
    }

    initDataExchange(): IDataExchange {
        return new DefaultDataExchange();
    }

    private ensureNecessary() {
        if (this._shapeProvider === undefined) {
            throw new Error("ShapeProvider not set");
        }
        if (this._visualFactory === undefined) {
            throw new Error("VisualFactory not set");
        }
        if (this._storage === undefined) {
            throw new Error("storage has not been initialized");
        }
    }

    protected getServices(): IService[] {
        return [new CommandService(), new HotkeyService(), new AutosaveService()];
    }
}
