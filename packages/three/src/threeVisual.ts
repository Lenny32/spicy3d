// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    type IDocument,
    type IEventHandler,
    type IMeshExporter,
    type IVisual,
    isDisposable,
    type Plane,
} from "@spicy3d/core";
import { AmbientLight, AxesHelper, Object3D, Scene } from "three";
import { ThreeMeshExporter } from "./meshExporter";
import { ThreeGrid } from "./threeGrid";
import { ThreeHighlighter } from "./threeHighlighter";
import { ThreeView } from "./threeView";
import { ThreeViewHandler } from "./threeViewEventHandler";
import { ThreeVisualContext } from "./threeVisualContext";

Object3D.DEFAULT_UP.set(0, 0, 1);

export class ThreeVisual implements IVisual {
    readonly context: ThreeVisualContext;
    readonly scene: Scene;
    readonly highlighter: ThreeHighlighter;
    readonly meshExporter: IMeshExporter;
    readonly grid: ThreeGrid;

    viewHandler: IEventHandler;
    eventHandler: IEventHandler;
    defaultEventHandler: IEventHandler;

    constructor(
        readonly document: IDocument,
        defaultEventHandler: IEventHandler,
    ) {
        this.grid = new ThreeGrid();
        this.grid.visible = Config.instance.showGrid;
        this.scene = this.initScene();
        this.defaultEventHandler = defaultEventHandler;
        this.viewHandler = new ThreeViewHandler();
        this.context = new ThreeVisualContext(this, this.scene);
        this.highlighter = new ThreeHighlighter(this.context);
        this.meshExporter = new ThreeMeshExporter(this.context);
        this.eventHandler = this.defaultEventHandler;
        Config.instance.onPropertyChanged(this.onConfigChanged);
    }

    private readonly onConfigChanged = (property: keyof Config) => {
        if (property === "showGrid") {
            this.grid.visible = Config.instance.showGrid;
            this.update();
        }
    };

    initScene() {
        const scene = new Scene();
        const envLight = new AmbientLight(0x888888, 4);
        const axisHelper = new AxesHelper(250);
        scene.add(envLight, axisHelper, this.grid);
        return scene;
    }

    createView(name: string, workplane: Plane) {
        return new ThreeView(this.document, name, workplane, this.highlighter, this.context);
    }

    update(): void {
        this.document.application.views.forEach((view) => {
            if (view.document === this.document) view.update();
        });
    }

    dispose() {
        Config.instance.removePropertyChanged(this.onConfigChanged);
        this.context.dispose();
        this.defaultEventHandler.dispose();
        this.eventHandler.dispose();
        this.viewHandler.dispose();
        this.scene.traverse((x) => {
            if (isDisposable(x)) x.dispose();
        });
        this.scene.clear();
    }
}
