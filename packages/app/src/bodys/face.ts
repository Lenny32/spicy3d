// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryUtils,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IShape,
    type IWire,
    ParameterShapeNode,
    Precision,
    Result,
    ShapeTypes,
    serializable,
    serialize,
    XYZ,
} from "@spicy3d/core";

export interface FaceOptions {
    document: IDocument;
    shapes: IEdge[] | IWire[];
}

@serializable()
export class FaceNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.face";
    }

    @serialize()
    get shapes(): IEdge[] | IWire[] {
        return this.getPrivateValue("shapes");
    }
    set shapes(values: IEdge[] | IWire[]) {
        this.setPropertyEmitShapeChanged("shapes", values);
    }

    constructor(options: FaceOptions) {
        super(options);
        this.setPrivateValue("shapes", options.shapes);
    }

    private getWires(): IWire[] {
        const wires: IWire[] = [];
        const edges: IEdge[] = [];
        for (const shape of this.shapes) {
            if (shape.shapeType === ShapeTypes.wire) {
                if (shape.isClosed()) {
                    wires.push(shape as IWire);
                } else {
                    edges.push(...(shape.findSubShapes(ShapeTypes.edge) as IEdge[]));
                }
            } else {
                edges.push(shape as IEdge);
            }
        }

        // Edges may form several disjoint loops (e.g. an inner loop offset from an
        // outer one), so build one wire per connected group instead of forcing all
        // edges into a single wire.
        for (const group of FaceNode.groupConnectedEdges(edges)) {
            const wire = shapeFactory.wire(group);
            if (!wire.isOk) throw new Error("Cannot create wire from open shapes");
            wires.push(wire.value);
        }

        return wires;
    }

    private static groupConnectedEdges(edges: IEdge[]): IEdge[][] {
        const remaining = edges.map((edge) => ({ edge, points: FaceNode.endpoints(edge) }));
        const groups: IEdge[][] = [];
        let first = remaining.pop();
        while (first !== undefined) {
            const group = [first];
            let merged = true;
            while (merged) {
                merged = false;
                for (let i = remaining.length - 1; i >= 0; i--) {
                    if (group.some((x) => FaceNode.isTouching(x.points, remaining[i].points))) {
                        group.push(remaining.splice(i, 1)[0]);
                        merged = true;
                    }
                }
            }
            groups.push(group.map((x) => x.edge));
            first = remaining.pop();
        }
        return groups;
    }

    private static endpoints(edge: IEdge): XYZ[] {
        const curve = edge.curve;
        return [curve.value(curve.firstParameter()), curve.value(curve.lastParameter())];
    }

    private static isTouching(a: XYZ[], b: XYZ[]): boolean {
        return a.some((p1) => b.some((p2) => p1.distanceTo(p2) < Precision.Distance));
    }

    override generateShape(): Result<IShape> {
        if (this.shapes.length === 0) return Result.err("No shapes to create face");

        const wires = this.getWires();
        FaceNode.orientOuterWire(wires[0]);
        return shapeFactory.face(wires);
    }

    // Orients the outer wire so the face normal points along the positive dominant axis
    // (e.g. +Z for a face in the XY plane), independent of the drawing direction.
    private static orientOuterWire(wire: IWire): void {
        const normal = GeometryUtils.normal(wire);
        const ax = Math.abs(normal.x);
        const ay = Math.abs(normal.y);
        const az = Math.abs(normal.z);
        const dominant = az >= ax && az >= ay ? XYZ.unitZ : ay >= ax ? XYZ.unitY : XYZ.unitX;
        if (normal.dot(dominant) < 0) {
            wire.reserve();
        }
    }
}
