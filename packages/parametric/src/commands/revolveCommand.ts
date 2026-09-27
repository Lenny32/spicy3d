// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type AsyncController,
    Combobox,
    ConstructionNode,
    type ConstructionRef,
    CurveUtils,
    command,
    type IDocument,
    Id,
    type IEdge,
    type IFace,
    type ILine,
    type IShape,
    type IShapeFilter,
    type IStep,
    Line,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    resolveConstructionRef,
    SelectNodeStep,
    SelectShapeStep,
    ShapeNode,
    ShapeTypes,
    type SnapResult,
    Transaction,
    VisualStates,
} from "@spicy3d/core";
import { captureEdgeRef } from "../features/edgeRef";
import type { RevolveFeatureData } from "../features/feature";
import { captureProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { SelectSketchProfilesStep } from "./extrudeCommand";

@command({ key: "feature.revolve", icon: "icon-revolve" })
export class RevolveFeatureCommand extends MultistepCommand {
    @property("construction.axisSource", {
        combobox: Combobox.from(["construction.axisSource.edge", "construction.axisSource.datum"]),
    })
    get axisMode() {
        return this.getPrivateValue("axisMode", "construction.axisSource.edge");
    }
    set axisMode(value: string) {
        this.setProperty("axisMode", value);
    }

    @property("construction.ucsAxis", {
        combobox: Combobox.from([
            "construction.ucsAxis.X",
            "construction.ucsAxis.Y",
            "construction.ucsAxis.Z",
        ]),
    })
    get ucsAxis() {
        return this.getPrivateValue("ucsAxis", "construction.ucsAxis.Z");
    }
    set ucsAxis(value: string) {
        this.setProperty("ucsAxis", value);
    }

    private get ucsMember(): "X" | "Y" | "Z" {
        return this.ucsAxis.endsWith(".X") ? "X" : this.ucsAxis.endsWith(".Y") ? "Y" : "Z";
    }

    @property("common.angle", { unit: ANGLE_UNITS })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 360);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value);
    }

    private get sketch(): SketchNode {
        return this.stepDatas[0].nodes![0] as unknown as SketchNode;
    }

    protected override getSteps(): IStep[] {
        return [
            new SelectSketchProfilesStep((node) => node instanceof SketchNode),
            new SelectRevolveAxisStep(this),
        ];
    }

    private axis(): Line {
        const datum = this.stepDatas[1].nodes?.[0];
        if (datum instanceof ConstructionNode) {
            const ref: ConstructionRef = {
                kind: "datum",
                nodeId: datum.id,
                ...(datum.definition.kind === "ucs" ? { member: this.ucsMember } : {}),
            };
            const source = resolveConstructionRef(this.document, ref);
            if (!source.isOk || source.value.kind !== "axis")
                throw new Error(source.isOk ? "Select a construction axis" : source.error);
            return new Line({ point: source.value.origin, direction: source.value.direction });
        }
        const { shape, transform } = this.stepDatas[1].shapes[0];
        const curve = (shape as IEdge).curve.basisCurve as ILine;
        return new Line({
            point: transform.ofPoint(curve.value(0)),
            direction: transform.ofVector(curve.direction),
        });
    }

    protected override executeMainTask(): void {
        if (!this.validAngle()) return;
        const sketch = this.sketch;
        let feature: RevolveFeatureData;
        try {
            feature = this.buildFeature();
        } catch (error) {
            PubSub.default.pub("showToast", "error.default:{0}", String(error));
            return;
        }
        const node = new ParametricBodyNode({ document: this.document, features: [feature] });
        Transaction.execute(this.document, "excute feature.revolve", () => {
            this.document.modelManager.addNode(node);
            // The sketch is consumed by the feature; hide it. Same transaction, so
            // undo restores the visibility together with the body.
            sketch.visible = false;
            this.document.visual.update();
        });
    }

    private validAngle(): boolean {
        // The feature keeps the expression; what has to be a usable angle is what it
        // resolves to.
        const angle = this.resolveParameter(this.angle, ANGLE_UNITS);
        if (angle.isOk && angle.value !== 0) return true;
        PubSub.default.pub("showToast", "error.input.invalidNumber");
        return false;
    }

    private buildFeature(): RevolveFeatureData {
        const axis = this.axis();
        // Picked profile faces are fingerprinted (undefined revolves the whole sketch).
        const faces = this.stepDatas[0].shapes.map((x) => x.shape as unknown as IFace);
        return {
            id: Id.generate(),
            type: "revolve",
            sketchId: this.sketch.id,
            axis: {
                point: { x: axis.point.x, y: axis.point.y, z: axis.point.z },
                direction: { x: axis.direction.x, y: axis.direction.y, z: axis.direction.z },
            },
            angle: this.angle,
            ...(faces.length > 0 ? { profiles: faces.map((face) => captureProfileRef(face)) } : {}),
            ...this.axisSource(),
            ...this.constructionAxisSource(),
        };
    }

    private constructionAxisSource(): Pick<RevolveFeatureData, "constructionAxisRef"> {
        const node = this.stepDatas[1].nodes?.[0];
        if (!(node instanceof ConstructionNode)) return {};
        return {
            constructionAxisRef: {
                kind: "datum",
                nodeId: node.id,
                ...(node.definition.kind === "ucs" ? { member: this.ucsMember } : {}),
            },
        };
    }

    /**
     * The axis as a fingerprinted edge reference (local coords), so it follows the
     * source node on rebuild; the `axis` snapshot stays as the fallback.
     */
    private axisSource(): Pick<RevolveFeatureData, "axisSource"> {
        const data = this.stepDatas[1].shapes[0];
        if (!data) return {};
        const node = data.owner.node;
        if (!(node instanceof ShapeNode)) return {};
        return {
            axisSource: { nodeId: node.id, edge: captureEdgeRef(data.shape as unknown as IEdge) },
        };
    }
}

class SelectRevolveAxisStep implements IStep {
    constructor(private readonly command: RevolveFeatureCommand) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        if (this.command.axisMode === "construction.axisSource.datum") {
            const selected = document.selection
                .getSelectedNodes()
                .find(
                    (node) =>
                        node instanceof ConstructionNode &&
                        (node.definition.kind.startsWith("axis-") || node.definition.kind === "ucs"),
                );
            if (selected) {
                controller.success();
                return {
                    view: document.application.activeView!,
                    type: "node",
                    shapes: [],
                    nodes: [selected as ConstructionNode],
                };
            }
            return new SelectNodeStep("prompt.select.axis", {
                filter: {
                    allow: (node) =>
                        node instanceof ConstructionNode &&
                        (node.definition.kind.startsWith("axis-") || node.definition.kind === "ucs"),
                },
                keepSelection: true,
            }).execute(document, controller);
        }
        return new SelectShapeStep(ShapeTypes.edge, "prompt.select.axis", {
            shapeFilter: new LineEdgeFilter(),
            keepSelection: true,
            highlightState: VisualStates.edgeHighlight,
            selectedState: VisualStates.edgeSelected,
        }).execute(document, controller);
    }
}

class LineEdgeFilter implements IShapeFilter {
    allow(shape: IShape): boolean {
        if (shape.shapeType !== ShapeTypes.edge) return false;
        return CurveUtils.isLine((shape as IEdge).curve.basisCurve);
    }
}
