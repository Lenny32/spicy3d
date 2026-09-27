// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type GeometryNode,
    type IStep,
    type LengthAtAxisSnapData,
    LengthAtAxisStep,
    LengthAtPlaneStep,
    type Plane,
    PointStep,
    Precision,
    property,
    type SnapLengthAtPlaneData,
    type XYZ,
} from "@spicy3d/core";
import { HelixNode } from "../../bodys/helix";
import { CreateCommand } from "../createCommand";

@command({
    key: "create.helix",
    icon: "icon-helix",
})
export class Helix extends CreateCommand {
    @property("option.command.pitch", { quantity: "length" })
    get pitch() {
        return this.getPrivateValue("pitch", 10);
    }
    set pitch(value: number) {
        this.setProperty("pitch", value);
    }

    protected override getSteps(): IStep[] {
        const centerStep = new PointStep("prompt.pickCircleCenter");
        const radiusStep = new LengthAtPlaneStep("prompt.pickRadius", this.getRadiusData);
        const heightStep = new LengthAtAxisStep("prompt.pickNextPoint", this.getHeightStepData);
        return [centerStep, radiusStep, heightStep];
    }

    private readonly getRadiusData = (): SnapLengthAtPlaneData => {
        const { point, view } = this.stepDatas[0];
        return {
            point: () => point!,
            preview: this.radiusPreview,
            plane: (tmp: XYZ | undefined) => this.findPlane(view, point!, tmp),
            validator: (p: XYZ) => {
                if (p.distanceTo(point!) < Precision.Distance) return false;
                const plane = this.findPlane(view, point!, p);
                return p.sub(point!).isParallelTo(plane.normal) === false;
            },
        };
    };

    private readonly radiusPreview = (point: XYZ | undefined) => {
        if (!point) return [this.meshPoint(this.stepDatas[0].point!)];

        const start = this.stepDatas[0].point!;
        const plane = this.findPlane(this.stepDatas[0].view, start, point);
        return [
            this.meshPoint(this.stepDatas[0].point!),
            this.meshLine(start, point),
            this.meshCreatedShape("circle", plane.normal, start, plane.projectDistance(start, point)),
        ];
    };

    private readonly getHeightStepData = (): LengthAtAxisSnapData => {
        return {
            point: this.stepDatas[0].point!,
            direction: this.stepDatas[1].plane!.normal,
            preview: this.previewHelix,
            validator: (p: XYZ) => {
                return Math.abs(this.getHeight(this.stepDatas[1].plane!, p)) > 0.001;
            },
        };
    };

    private readonly previewHelix = (end: XYZ | undefined) => {
        if (!end) {
            return this.radiusPreview(this.stepDatas[1].point);
        }

        const plane = this.stepDatas[1].plane!;
        const center = this.stepDatas[0].point!;
        const radiusPoint = this.stepDatas[1].point!;
        const radius = plane.projectDistance(center, radiusPoint);
        const height = this.getHeight(plane, end);
        const dir = height < 0 ? plane.normal.reverse() : plane.normal;
        const xDir = radiusPoint.sub(center);
        const angle = this.computeAngle(height);

        const mesh = this.meshCreatedShape("helix", center, dir, xDir, radius, Math.abs(this.pitch), angle);
        return mesh ? [mesh] : [];
    };

    protected override geometryNode(): GeometryNode {
        const plane = this.stepDatas[1].plane!;
        const center = this.stepDatas[0].point!;
        const radiusPoint = this.stepDatas[1].point!;
        const radius = plane.projectDistance(center, radiusPoint);
        const height = this.getHeight(plane, this.stepDatas[2].point!);
        const xDir = radiusPoint.sub(center);
        const angle = this.computeAngle(height);

        return new HelixNode({
            document: this.document,
            origin: center,
            normal: height < 0 ? plane.normal.reverse() : plane.normal,
            xDir,
            radius,
            pitch: Math.abs(this.pitch),
            angle,
        });
    }

    private computeAngle(height: number): number {
        return (Math.abs(height) / Math.abs(this.pitch)) * 360;
    }

    private getHeight(plane: Plane, point: XYZ): number {
        return point.sub(this.stepDatas[0].point!).dot(plane.normal);
    }
}
