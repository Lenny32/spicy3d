// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type GeometryNode,
    type ICurve,
    type IEdge,
    type IShapeFilter,
    type IStep,
    LengthAtPlaneStep,
    type Plane,
    Precision,
    SelectShapeStep,
    type ShapeMeshData,
    ShapeTypes,
    type SnapLengthAtPlaneData,
    XYZ,
} from "@spicy3d/core";
import { ArcNode } from "../../bodys/arc";
import { CreateCommand } from "../createCommand";
import {
    basisCurveOf,
    computeTangentTangentRadiusArc,
    isTangentRadiusCurve,
    tangentCurvesPlane,
} from "./arcUtils";

@command({
    key: "create.arcTTR",
    icon: "icon-arcTTR",
})
export class ArcTTR extends CreateCommand {
    private _curves: [ICurve, ICurve] | undefined;
    private _refPoints: [XYZ, XYZ] | undefined;
    private _anchor: XYZ | undefined;
    private _plane: Plane | undefined;

    getSteps(): IStep[] {
        return [
            new SelectShapeStep(ShapeTypes.edge, "prompt.select.edges", {
                multiple: true,
                shapeFilter: this._edgeFilter,
                canFinish: (selected) => selected.length === 2,
            }),
            new LengthAtPlaneStep("prompt.pickRadius", this.getRadiusData),
        ];
    }

    private readonly _edgeFilter: IShapeFilter = {
        allow: (shape) => shape.shapeType === ShapeTypes.edge && isTangentRadiusCurve((shape as IEdge).curve),
    };

    private readonly getRadiusData = (): SnapLengthAtPlaneData => {
        this.initTangentData();
        return {
            point: () => this._anchor!,
            preview: this.tangentPreview,
            plane: () => this._plane ?? this.stepDatas[0].view.workplane,
            validator: (point: XYZ) => this.solve(point) !== undefined,
        };
    };

    private initTangentData() {
        const edges = this.transformdShapes(this.stepDatas[0]) as IEdge[];
        this._curves = [basisCurveOf(edges[0].curve), basisCurveOf(edges[1].curve)];
        this._refPoints = [
            this.stepDatas[0].shapes[0].point ?? edges[0].startPoint(),
            this.stepDatas[0].shapes[1].point ?? edges[1].startPoint(),
        ];
        // The drag starts midway between the two pick points: radius grows from between the curves.
        this._anchor = XYZ.center(this._refPoints[0], this._refPoints[1]);
        this._plane = tangentCurvesPlane(
            this._curves[0],
            this._curves[1],
            this._anchor,
            this._refPoints[1].sub(this._anchor),
        );
    }

    private readonly tangentPreview = (point: XYZ | undefined): ShapeMeshData[] => {
        const meshes: ShapeMeshData[] = [this.meshPoint(this._anchor!)];
        const geometry = point === undefined ? undefined : this.solve(point);
        if (geometry !== undefined && Math.abs(geometry.angle) > Precision.Angle) {
            meshes.push(
                this.meshPoint(geometry.center),
                this.meshPoint(geometry.start),
                this.meshPoint(geometry.end),
                this.meshCreatedShape(
                    "arc",
                    geometry.normal,
                    geometry.center,
                    geometry.start,
                    geometry.angle,
                ),
            );
        }
        return meshes;
    };

    private solve(point: XYZ) {
        const radius = point.distanceTo(this._anchor!);
        if (radius < Precision.Distance) return undefined;
        return computeTangentTangentRadiusArc(
            this._curves![0],
            this._refPoints![0],
            this._curves![1],
            this._refPoints![1],
            radius,
        );
    }

    protected override geometryNode(): GeometryNode {
        const geometry = this.solve(this.stepDatas[1].point!)!;
        return new ArcNode({
            document: this.document,
            normal: geometry.normal,
            center: geometry.center,
            start: geometry.start,
            angle: geometry.angle,
        });
    }
}
