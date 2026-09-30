// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DeploymentConfig,
    type IShapeConverter,
    type IShapeFactory,
    type IShapeProvider,
} from "@spicy3d/core";
import { OccShapeConverter } from "./converter";
import { ShapeFactory } from "./factory";
import { HybridShapeFactory } from "./hybridShapeFactory";
import { workerProfile } from "./workerProfile";

export class OccShapeProvider implements IShapeProvider {
    private _factory!: IShapeFactory;
    private _converter!: IShapeConverter;
    private hybrid?: HybridShapeFactory;
    private readonly enabled: boolean;
    get factory(): IShapeFactory {
        return this._factory;
    }
    get converter(): IShapeConverter {
        return this._converter;
    }

    constructor(options?: { geometryWorker?: boolean }) {
        // Hybrid replicas currently trade elapsed time and memory for responsiveness. Opt in
        // explicitly while that tradeoff is under review; absent/invalid settings keep opt-07.
        const requested =
            options?.geometryWorker ?? DeploymentConfig.section("performance")?.["geometryWorker"];
        this.enabled = typeof Worker === "function" && requested === true;
        this.resetKernel();
    }

    /** Retire the old lazy hybrid generation while keeping the provider reference stable. */
    resetKernel(): void {
        this.hybrid?.dispose();
        const enabled = this.enabled;
        workerProfile.install(enabled);
        const hybrid = new HybridShapeFactory(undefined, enabled);
        this.hybrid = hybrid;
        this._factory = new ShapeFactory(enabled ? hybrid : undefined, hybrid);
        this._converter = new OccShapeConverter();
    }
}
