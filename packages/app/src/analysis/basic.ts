// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AnalysisContext,
    type AnalysisManager,
    type AnalysisResult,
    CurveUtils,
    formatMeasure,
    type IEdge,
    type IFace,
    type IShape,
    isLengthUnit,
    lengthUnitSymbol,
    MeshDataUtils,
    Plane,
    Result,
    ShapeNode,
    ShapeTypes,
    ShapeTypeUtils,
    VisualConfig,
    XYZ,
} from "@spicy3d/core";

function worldShape(source: AnalysisContext["sources"][number]): IShape {
    const shape = source.subShape ?? source.shape;
    if (!shape) throw new Error(`Source ${source.node.name} is not a boundary shape`);
    return shape.transformedMul(source.worldTransform);
}

function formatValue(
    value: number,
    dimension: 1 | 2 | 3,
    context: AnalysisContext,
): { text: string; unit: string } {
    const unit = context.settings["unit"] ?? "mm";
    if (!isLengthUnit(unit)) throw new Error(`Unsupported measurement unit: ${String(unit)}`);
    const decimals = measurementPrecision(context);
    return {
        text: formatMeasure(value, dimension, unit, { decimals }),
        unit: lengthUnitSymbol(unit, dimension),
    };
}

function formatAngle(degrees: number, context: AnalysisContext): string {
    const precision = measurementPrecision(context);
    return degrees.toFixed(precision);
}

function measurementPrecision(context: AnalysisContext): number {
    const precision = Number(context.settings["precision"] ?? 3);
    if (!Number.isInteger(precision) || precision < 0 || precision > 8) {
        throw new Error("Measurement precision must be an integer from 0 to 8");
    }
    return precision;
}

function witness(first: XYZ, second: XYZ): AnalysisResult["overlays"] {
    const line = MeshDataUtils.createEdgeMesh(first, second, VisualConfig.highlightEdgeColor, "solid");
    line.lineWidth = 2;
    return [line];
}

function measure(context: AnalysisContext): Result<AnalysisResult> {
    if (context.sources.length < 1) {
        return Result.err("Measure requires at least one supported selection");
    }
    const shapes: IShape[] = [];
    try {
        for (const source of context.sources) shapes.push(worldShape(source));
        if (shapes.length > 2) {
            const rows: NonNullable<AnalysisResult["rows"]> = [];
            let length = 0;
            let area = 0;
            let volume = 0;
            for (const [index, shape] of shapes.entries()) {
                const label = context.sources[index].node.name;
                if (shape.shapeType === ShapeTypes.edge) {
                    const value = (shape as IEdge).length();
                    length += value;
                    const formatted = formatValue(value, 1, context);
                    rows.push({ label: `${label} length (${formatted.unit})`, value: formatted.text });
                } else if (shape.shapeType === ShapeTypes.face) {
                    const value = (shape as IFace).area();
                    area += value;
                    const formatted = formatValue(value, 2, context);
                    rows.push({ label: `${label} area (${formatted.unit})`, value: formatted.text });
                } else if (
                    shape.shapeType === ShapeTypes.solid ||
                    ShapeTypeUtils.hasCompound(shape.shapeType) ||
                    ShapeTypeUtils.hasCompoundSolid(shape.shapeType)
                ) {
                    const properties = shape.inspectionMass?.();
                    if (!properties?.isOk)
                        return Result.err(properties?.error ?? "Mass properties are unavailable");
                    volume += properties.value.volume;
                    const formatted = formatValue(properties.value.volume, 3, context);
                    rows.push({ label: `${label} volume (${formatted.unit})`, value: formatted.text });
                } else return Result.err(`Unsupported multi-measure source: ${label}`);
            }
            if (length) {
                const total = formatValue(length, 1, context);
                rows.push({ label: `Total length (${total.unit})`, value: total.text });
            }
            if (area) {
                const total = formatValue(area, 2, context);
                rows.push({ label: `Total area (${total.unit})`, value: total.text });
            }
            if (volume) {
                const total = formatValue(volume, 3, context);
                rows.push({ label: `Total volume (${total.unit})`, value: total.text });
            }
            return Result.ok({ rows, legend: [{ label: "Selections", value: String(shapes.length) }] });
        }
        if (shapes.length === 2) {
            let angleRow: NonNullable<AnalysisResult["rows"]>[number] | undefined;
            if (shapes.every((shape) => shape.shapeType === ShapeTypes.edge)) {
                const edges = shapes as IEdge[];
                const linear = edges.map((edge) => {
                    const curve = edge.curve;
                    return CurveUtils.isLine(curve.basisCurve);
                });
                if (linear.every(Boolean)) {
                    const directions = edges.map((edge) =>
                        edge.endPoint().sub(edge.startPoint()).normalize(),
                    );
                    const angle =
                        directions[0] && directions[1] ? directions[0].angleTo(directions[1]) : undefined;
                    if (angle !== undefined)
                        angleRow = {
                            label: "Edge angle (°)",
                            value: formatAngle((angle * 180) / Math.PI, context),
                        };
                }
            }
            if (shapes.every((shape) => shape.shapeType === ShapeTypes.face)) {
                const normals = (shapes as IFace[]).map((face) => {
                    const surface = face.surface();
                    try {
                        if (!surface.isPlanar()) return undefined;
                        const { u1, u2, v1, v2 } = surface.bounds();
                        return face.normal((u1 + u2) / 2, (v1 + v2) / 2)[1];
                    } finally {
                        surface.dispose();
                    }
                });
                const angle = normals[0] && normals[1] ? normals[0].angleTo(normals[1]) : undefined;
                if (angle !== undefined) {
                    angleRow = {
                        label: "Face normal angle (°)",
                        value: formatAngle((angle * 180) / Math.PI, context),
                    };
                }
            }
            if (!shapes[0].inspectionDistance) return Result.err("Exact minimum distance is unavailable");
            const distance = shapes[0].inspectionDistance(shapes[1]);
            if (!distance.isOk) return Result.err(distance.error);
            const { first, second } = distance.value;
            const formatted = formatValue(distance.value.distance, 1, context);
            const quantityRows: NonNullable<AnalysisResult["rows"]> = [];
            let sum = 0;
            let dimension: 1 | 2 | 3 | undefined;
            for (const [index, shape] of shapes.entries()) {
                let value: number | undefined;
                let kind: string | undefined;
                let currentDimension: 1 | 2 | 3 | undefined;
                if (shape.shapeType === ShapeTypes.edge) {
                    value = (shape as IEdge).length();
                    kind = "length";
                    currentDimension = 1;
                } else if (shape.shapeType === ShapeTypes.face) {
                    value = (shape as IFace).area();
                    kind = "area";
                    currentDimension = 2;
                } else if (
                    shape.shapeType === ShapeTypes.solid ||
                    ShapeTypeUtils.hasCompound(shape.shapeType) ||
                    ShapeTypeUtils.hasCompoundSolid(shape.shapeType)
                ) {
                    const mass = shape.inspectionMass?.();
                    if (mass?.isOk) {
                        value = mass.value.volume;
                        kind = "volume";
                        currentDimension = 3;
                    }
                }
                if (value === undefined || !kind || !currentDimension) continue;
                const quantity = formatValue(value, currentDimension, context);
                quantityRows.push({
                    label: `${context.sources[index].node.name} ${kind} (${quantity.unit})`,
                    value: quantity.text,
                });
                if (dimension === undefined || dimension === currentDimension) {
                    dimension = currentDimension;
                    sum += value;
                } else dimension = undefined;
            }
            if (quantityRows.length === 2 && dimension) {
                const total = formatValue(sum, dimension, context);
                quantityRows.push({
                    label: `Total ${dimension === 1 ? "length" : dimension === 2 ? "area" : "volume"} (${total.unit})`,
                    value: total.text,
                });
            }
            return Result.ok({
                rows: [
                    ...(angleRow ? [angleRow] : []),
                    { label: `Minimum distance (${formatted.unit})`, value: formatted.text },
                    ...quantityRows,
                ],
                overlays: witness(first, second),
                legend: [{ label: "Minimum distance", value: `${formatted.text} ${formatted.unit}` }],
            });
        }
        const shape = shapes[0];
        if (shape.shapeType === ShapeTypes.vertex) {
            const point = (shape as IShape & { point(): XYZ }).point();
            const x = formatValue(point.x, 1, context);
            const y = formatValue(point.y, 1, context);
            const z = formatValue(point.z, 1, context);
            return Result.ok({
                marker: point,
                rows: [{ label: `Coordinates (${x.unit})`, value: `${x.text}, ${y.text}, ${z.text}` }],
            });
        }
        if (shape.shapeType === ShapeTypes.edge) {
            const edge = shape as IEdge;
            const length = formatValue(edge.length(), 1, context);
            const rows = [{ label: `Length (${length.unit})`, value: length.text }];
            const curve = edge.curve;
            const basis = curve.basisCurve;
            if (CurveUtils.isCircle(basis)) {
                const radius = formatValue(basis.radius, 1, context);
                const diameter = formatValue(basis.radius * 2, 1, context);
                rows.push({ label: `Radius (${radius.unit})`, value: radius.text });
                rows.push({ label: `Diameter (${diameter.unit})`, value: diameter.text });
            }
            return Result.ok({ rows });
        }
        if (shape.shapeType === ShapeTypes.face) {
            const face = shape as IFace;
            const area = formatValue(face.area(), 2, context);
            return Result.ok({ rows: [{ label: `Area (${area.unit})`, value: area.text }] });
        }
        if (
            ShapeTypes.solid === shape.shapeType ||
            ShapeTypeUtils.hasCompound(shape.shapeType) ||
            ShapeTypeUtils.hasCompoundSolid(shape.shapeType)
        ) {
            if (!shape.inspectionMass) return Result.err("Mass properties are unavailable");
            const properties = shape.inspectionMass();
            if (!properties.isOk) return Result.err(properties.error);
            const volume = formatValue(properties.value.volume, 3, context);
            return Result.ok({ rows: [{ label: `Volume (${volume.unit})`, value: volume.text }] });
        }
        return Result.err("Selected geometry cannot be measured");
    } finally {
        shapes.forEach((shape) => shape.dispose());
    }
}

async function section(manager: AnalysisManager, context: AnalysisContext): Promise<Result<AnalysisResult>> {
    const planeName = String(context.settings["plane"] ?? "xy");
    let base = planeName === "yz" ? Plane.YZ : planeName === "zx" ? Plane.ZX : Plane.XY;
    if (planeName === "face") {
        const source = context.sources[0];
        if (!source?.subShape || source.subShape.shapeType !== ShapeTypes.face) {
            return Result.err("Select a planar face for this section");
        }
        const face = source.subShape as IFace;
        const surface = face.surface();
        try {
            if (!surface.isPlanar()) return Result.err("Section source must be planar");
            const bounds = face.inspectionUVBounds?.();
            if (!bounds?.isOk) return Result.err("Section face has no bounded trim region");
            const { u1, u2, v1, v2 } = bounds.value;
            const [origin, faceNormal] = face.normal((u1 + u2) / 2, (v1 + v2) / 2);
            const xvec = faceNormal.cross(XYZ.unitZ).normalize() ?? faceNormal.cross(XYZ.unitY).normalize();
            if (!xvec) return Result.err("Section face has an invalid normal");
            const inverse = source.worldTransform.invert();
            if (!inverse) return Result.err("Section source has a singular transform");
            const worldNormal = inverse.transpose().ofVector(faceNormal).normalize();
            const worldX = source.worldTransform.ofVector(xvec).normalize();
            if (!worldNormal || !worldX) return Result.err("Section face has an invalid world direction");
            base = new Plane({
                origin: source.worldTransform.ofPoint(origin),
                normal: worldNormal,
                xvec: worldX,
            });
        } finally {
            surface.dispose();
        }
    }
    const offset = Number(context.settings["offset"] ?? 0);
    const angle = Number(context.settings["rotation"] ?? 0);
    if (!Number.isFinite(offset) || !Number.isFinite(angle))
        return Result.err("Section offset and angle must be finite");
    const normal = base.normal.rotate(base.xvec, (angle * Math.PI) / 180);
    if (!normal) return Result.err("Section plane rotation is invalid");
    const direction = context.settings["flip"] === true ? normal.reverse() : normal;
    const plane = new Plane({
        origin: base.origin.add(normal.multiply(offset)),
        normal: direction,
        xvec: base.xvec,
    });
    const overlays: NonNullable<AnalysisResult["overlays"]> = [];
    let skipped = 0;
    for (const node of manager.document.modelManager.findNodes(
        (item) => item instanceof ShapeNode && item.visible && item.parentVisible,
    )) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (context.signal.aborted) return Result.err("Section analysis cancelled");
        const source = manager.resolveSource({ nodeId: node.id });
        if (!source.isOk) return Result.err(source.error);
        try {
            if (
                !source.value.shape ||
                !(
                    source.value.shape.shapeType === ShapeTypes.solid ||
                    ShapeTypeUtils.hasCompound(source.value.shape.shapeType) ||
                    ShapeTypeUtils.hasCompoundSolid(source.value.shape.shapeType)
                )
            ) {
                skipped++;
                continue;
            }
            const world = worldShape(source.value);
            try {
                if (!world.inspectionSectionCaps) return Result.err("Section cap query is unavailable");
                const caps = world.inspectionSectionCaps(plane);
                if (!caps.isOk) {
                    skipped++;
                    continue;
                }
                try {
                    const mesh = caps.value.mesh.faces;
                    if (mesh) {
                        const position = mesh.position.slice();
                        for (let index = 0; index < position.length; index += 3) {
                            position[index] += plane.normal.x * 1e-4;
                            position[index + 1] += plane.normal.y * 1e-4;
                            position[index + 2] += plane.normal.z * 1e-4;
                        }
                        overlays.push({ ...mesh, position, range: [], color: 0xedaa52 });
                    }
                } finally {
                    caps.value.dispose();
                }
            } finally {
                world.dispose();
            }
        } finally {
            source.value.dispose();
        }
    }
    return Result.ok({
        overlays,
        legend: [
            { label: "Section", value: `${planeName.toUpperCase()}, ${offset} mm, ${angle}°` },
            { label: "Unsupported bodies", value: String(skipped) },
        ],
        display: () => manager.document.visual.context.acquireAnalysisClip(context.analysisId, plane),
    });
}

async function interference(context: AnalysisContext): Promise<Result<AnalysisResult>> {
    if (context.sources.length < 2) return Result.err("Select at least two solids for interference analysis");
    const shapes: IShape[] = [];
    try {
        for (const source of context.sources) shapes.push(worldShape(source));
        const rows: NonNullable<AnalysisResult["rows"]> = [];
        const tolerance = Number(context.settings["tolerance"] ?? 1e-6);
        if (!Number.isFinite(tolerance) || tolerance < 0)
            return Result.err("Interference tolerance must be non-negative");
        for (let i = 0; i < shapes.length; i++) {
            for (let j = i + 1; j < shapes.length; j++) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (context.signal.aborted) return Result.err("Interference analysis cancelled");
                if (!shapes[i].inspectionCommonVolume)
                    return Result.err("Exact interference query is unavailable");
                const volume = shapes[i].inspectionCommonVolume!(shapes[j]);
                if (!volume.isOk) return Result.err(volume.error);
                let overlays: AnalysisResult["overlays"];
                if (volume.value > tolerance) {
                    const common = shapeFactory.booleanCommon([shapes[i]], [shapes[j]]);
                    if (!common.isOk) return Result.err(common.error);
                    try {
                        const faceMesh = common.value.mesh.faces;
                        if (faceMesh) {
                            const cloned = {
                                ...faceMesh,
                                position: faceMesh.position.slice(),
                                index: faceMesh.index.slice(),
                                normal: faceMesh.normal.slice(),
                                range: [],
                                color: 0xff4b32,
                            };
                            overlays = [cloned];
                        }
                    } finally {
                        common.value.dispose();
                    }
                }
                rows.push({
                    label: `${context.sources[i].node.name} × ${context.sources[j].node.name}`,
                    value: volume.value > tolerance ? `${volume.value} mm³ overlap` : "No volumetric overlap",
                    sourceIds: [context.sources[i].node.id, context.sources[j].node.id],
                    overlays,
                });
            }
        }
        return Result.ok({ rows, legend: [{ label: "Pairs", value: rows.length.toString() }] });
    } finally {
        shapes.forEach((shape) => shape.dispose());
    }
}

function centerOfMass(context: AnalysisContext): Result<AnalysisResult> {
    if (!context.sources.length) return Result.err("Select at least one closed solid");
    const shapes: IShape[] = [];
    try {
        for (const source of context.sources) shapes.push(worldShape(source));
        const densities = context.settings["densities"] as Record<string, number> | undefined;
        const uniformDensity = Number(context.settings["density"] ?? 1);
        let totalVolume = 0;
        let totalMass = 0;
        let weightedCenter = XYZ.zero;
        for (let index = 0; index < shapes.length; index++) {
            if (context.signal.aborted) return Result.err("Center of mass analysis cancelled");
            if (!shapes[index].inspectionMass) return Result.err("Mass properties are unavailable");
            const properties = shapes[index].inspectionMass!();
            if (!properties.isOk) return Result.err(properties.error);
            const volume = properties.value.volume;
            const density = densities?.[context.sources[index].node.id] ?? uniformDensity;
            if (!Number.isFinite(density) || density <= 0) return Result.err("Density must be positive");
            if (!Number.isFinite(volume) || volume <= 0)
                return Result.err("Source has zero or invalid volume");
            const mass = volume * density;
            totalVolume += volume;
            totalMass += mass;
            weightedCenter = weightedCenter.add(properties.value.center.multiply(mass));
        }
        const center = weightedCenter.divided(totalMass)!;
        return Result.ok({
            marker: center,
            rows: [
                { label: "Center (mm)", value: center.toString() },
                { label: "Volume (mm³)", value: totalVolume.toString() },
                { label: "Mass (g)", value: totalMass.toString() },
            ],
            legend: [
                { label: "Center of mass", value: center.toString() },
                { label: "Density model", value: "Uniform density per body (g/mm³)" },
            ],
        });
    } finally {
        shapes.forEach((shape) => shape.dispose());
    }
}

export function registerBasicInspectAnalyses(manager: AnalysisManager): void {
    manager.registerEvaluator("measure", measure);
    manager.registerEvaluator("section", (context) => section(manager, context));
    manager.registerEvaluator("interference", interference);
    manager.registerEvaluator("centerOfMass", centerOfMass);
}
