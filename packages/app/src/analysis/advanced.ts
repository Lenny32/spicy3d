// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AnalysisContext,
    type AnalysisManager,
    type AnalysisResult,
    componentAnalysisColor,
    type FaceMeshData,
    type IEdge,
    type IFace,
    type IShape,
    MeshDataUtils,
    MeshNode,
    Result,
    ShapeNode,
    ShapeTypes,
    XYZ,
    type XYZLike,
} from "@spicy3d/core";
import {
    classifyMinimumRadius,
    edgeEndpointContinuity,
    evaluateFaceNormal,
    evaluateSurfaceCurvature,
    sampleEdgeCurvature,
    signedDraftAngle,
} from "./geometry";

const UNKNOWN_COLOR = 0x888888;

function numberSetting(settings: Record<string, unknown>, key: string, fallback: number): number {
    const value = settings[key];
    return value === undefined ? fallback : typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function directionSetting(context: AnalysisContext, key: string): Result<XYZ> {
    const settings = context.settings;
    const sourceIndex = settings["directionSourceIndex"];
    if (sourceIndex !== undefined) {
        if (!Number.isInteger(sourceIndex) || (sourceIndex as number) < 0) {
            return Result.err("Invalid direction source index");
        }
        const source = context.sources[sourceIndex as number];
        if (!source) return Result.err("Direction source is missing");
        if (settings["directionSourceId"] !== undefined && settings["directionSourceId"] !== source.node.id) {
            return Result.err("Direction source changed");
        }
        const expected = settings["directionSourceKind"];
        const shape = source.subShape ?? source.shape;
        if (!shape || (expected !== "edge" && expected !== "face")) {
            return Result.err("Select a linear edge or planar face for direction");
        }
        let vector: XYZ | undefined;
        if (expected === "edge" && shape.shapeType === ShapeTypes.edge) {
            const edge = shape as IEdge;
            if (edge.curve.basisCurve.curveType !== "line")
                return Result.err("Direction edge must be linear");
            vector = edge.endPoint().sub(edge.startPoint());
        } else if (expected === "face" && shape.shapeType === ShapeTypes.face) {
            const face = shape as IFace;
            const surface = face.surface();
            try {
                if (!surface.isPlanar()) return Result.err("Direction face must be planar");
                const bounds = face.inspectionUVBounds?.();
                if (!bounds?.isOk) return Result.err("Direction face has no bounded UV domain");
                const { u1, u2, v1, v2 } = bounds.value;
                vector = face.normal((u1 + u2) / 2, (v1 + v2) / 2)[1];
            } finally {
                surface.dispose();
            }
        } else {
            return Result.err("Direction source does not match its selected topology");
        }
        const transform =
            expected === "face" ? source.worldTransform.invert()?.transpose() : source.worldTransform;
        if (!transform) return Result.err("Direction source has a singular transform");
        const world = transform.ofVector(vector);
        if (![world.x, world.y, world.z].every(Number.isFinite))
            return Result.err("Invalid direction source");
        const normalized = world.normalize();
        if (!normalized) return Result.err("Direction source is degenerate");
        return Result.ok(settings["directionReverse"] === true ? normalized.reverse() : normalized);
    }
    const value = settings[key];
    if (!value || typeof value !== "object" || !("x" in value) || !("y" in value) || !("z" in value)) {
        return Result.err(`Select a ${key}`);
    }
    const direction = value as XYZLike;
    if (![direction.x, direction.y, direction.z].every(Number.isFinite)) return Result.err(`Invalid ${key}`);
    const normalized = new XYZ(direction).normalize();
    return normalized ? Result.ok(normalized) : Result.err(`Invalid ${key}`);
}

function sourceRole(context: AnalysisContext, key: string, defaults: number[]): Result<AnalysisContext> {
    const selected = context.settings[key] ?? defaults;
    if (
        !Array.isArray(selected) ||
        !selected.length ||
        !selected.every((index) => Number.isInteger(index) && index >= 0 && index < context.sources.length)
    ) {
        return Result.err(`Select valid ${key}`);
    }
    const directionIndex = context.settings["directionSourceIndex"];
    if (selected.includes(directionIndex)) return Result.err(`Direction reference cannot be a ${key}`);
    return Result.ok({ ...context, sources: [...new Set(selected)].map((index) => context.sources[index]) });
}

async function withShapes<T extends IShape>(
    context: AnalysisContext,
    kind: "edge" | "face",
    callback: (shapes: T[]) => Result<AnalysisResult> | Promise<Result<AnalysisResult>>,
): Promise<Result<AnalysisResult>> {
    const shapes: T[] = [];
    const owned: IShape[] = [];
    try {
        for (const source of context.sources) {
            if (context.signal.aborted) return Result.err("Cancelled");
            if (!source.shape) return Result.err("This analysis requires B-rep shape sources");
            const selected = source.subShape ?? source.shape;
            const type = kind === "edge" ? ShapeTypes.edge : ShapeTypes.face;
            const found = selected.shapeType === type ? [selected] : selected.findSubShapes(type);
            if (found[0] !== selected) owned.push(...found);
            for (const shape of found) {
                const transformed = shape.transformedMul(source.worldTransform);
                owned.push(transformed);
                shapes.push(transformed as T);
            }
        }
        return shapes.length ? await callback(shapes) : Result.err(`Select at least one ${kind}`);
    } finally {
        for (const shape of owned) shape.dispose();
    }
}

function rgb(hex: number): [number, number, number] {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Color exact face UV samples at rendered triangle centroids, preserving trim holes. */
async function colorFace(
    face: IFace,
    classify: (u: number, v: number) => number,
    signal: AbortSignal,
    resolution = 1,
): Promise<{ overlay: FaceMeshData; unknown: number; total: number } | undefined> {
    const data = face.mesh.faces;
    const bounds = face.inspectionUVBounds?.();
    if (!data?.index.length || data.uv.length !== (data.position.length / 3) * 2 || !bounds?.isOk)
        return undefined;
    const positions: number[] = [];
    const normals: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const colors: number[] = [];
    let unknown = 0;
    for (let i = 0; i < data.index.length; i += 3) {
        if (i % 384 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (signal.aborted) throw new Error("Cancelled");
        }
        const vertices = [data.index[i], data.index[i + 1], data.index[i + 2]];
        let color = 0x2bad4b;
        for (let a = 0; a < resolution; a++) {
            for (let b = 0; b < resolution - a; b++) {
                const wa = (a + 1 / 3) / resolution;
                const wb = (b + 1 / 3) / resolution;
                const wc = 1 - wa - wb;
                const normalizedU =
                    wa * data.uv[vertices[0] * 2] +
                    wb * data.uv[vertices[1] * 2] +
                    wc * data.uv[vertices[2] * 2];
                const normalizedV =
                    wa * data.uv[vertices[0] * 2 + 1] +
                    wb * data.uv[vertices[1] * 2 + 1] +
                    wc * data.uv[vertices[2] * 2 + 1];
                const u = bounds.value.u1 + normalizedU * (bounds.value.u2 - bounds.value.u1);
                const v = bounds.value.v1 + normalizedV * (bounds.value.v2 - bounds.value.v1);
                const next = classify(u, v);
                if (resolution === 1 || next === 0xd44d4d || (next === UNKNOWN_COLOR && color !== 0xd44d4d))
                    color = next;
            }
        }
        if (color === UNKNOWN_COLOR) unknown++;
        const components = rgb(color);
        for (const vertex of vertices) {
            index.push(index.length);
            positions.push(...data.position.slice(vertex * 3, vertex * 3 + 3));
            normals.push(...data.normal.slice(vertex * 3, vertex * 3 + 3));
            uv.push(...data.uv.slice(vertex * 2, vertex * 2 + 2));
            colors.push(...components);
        }
    }
    return {
        overlay: {
            position: new Float32Array(positions),
            normal: new Float32Array(normals),
            uv: new Float32Array(uv),
            index: new Uint32Array(index),
            range: [],
            groups: [],
            color: colors,
        },
        unknown,
        total: data.index.length / 3,
    };
}

function curvatureComb(context: AnalysisContext): Promise<Result<AnalysisResult>> | Result<AnalysisResult> {
    const count = numberSetting(context.settings, "sampleCount", 24);
    const scale = numberSetting(context.settings, "scale", 10);
    if (!(scale > 0) || !(count >= 2)) return Result.err("Invalid comb settings");
    return withShapes<IEdge>(context, "edge", async (edges) => {
        const positions: number[] = [];
        const singularPoints: XYZ[] = [];
        let undefinedCount = 0;
        let maximum = 0;
        for (const edge of edges) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (context.signal.aborted) return Result.err("Cancelled");
            const samples = sampleEdgeCurvature(edge, count);
            if (!samples.isOk) return Result.err(samples.error);
            for (const sample of samples.value) {
                if (sample.status !== "ok") {
                    undefinedCount++;
                    singularPoints.push(sample.point);
                    continue;
                }
                if (!sample.normal) continue; // a straight edge has zero curvature and no comb height
                maximum = Math.max(maximum, sample.curvature);
                const tip = sample.point.add(sample.normal.multiply(sample.curvature * scale));
                positions.push(...sample.point.toArray(), ...tip.toArray());
            }
        }
        const continuityRows: NonNullable<AnalysisResult["rows"]> = [];
        let compared = 0;
        let truncated = false;
        for (let i = 0; i < edges.length; i++) {
            if (i % 16 === 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (context.signal.aborted) return Result.err("Cancelled");
            }
            for (let j = i + 1; j < edges.length; j++) {
                if (++compared > 10000 || continuityRows.length >= 128) {
                    truncated = true;
                    break;
                }
                const status = edgeEndpointContinuity(edges[i], edges[j]);
                if (status.isOk && status.value !== "gap") {
                    continuityRows.push({ label: `Edge ${i + 1}–${j + 1} continuity`, value: status.value });
                }
            }
            if (truncated) break;
        }
        return Result.ok({
            overlays: [
                { position: new Float32Array(positions), range: [], lineType: "solid", color: 0x19a5d9 },
                ...singularPoints.map((point) => MeshDataUtils.createVertexMesh(point, 8, 0xd44d4d)),
            ],
            legend: [
                { label: "Curvature", value: `0 … ${maximum.toPrecision(4)} mm⁻¹`, color: 0x19a5d9 },
                { label: "Undefined samples", value: String(undefinedCount), color: UNKNOWN_COLOR },
                ...(truncated
                    ? [{ label: "Continuity diagnostics", value: "First 10,000 pairs / 128 joins" }]
                    : []),
            ],
            rows: [{ label: "Edges", value: String(edges.length) }, ...continuityRows],
        });
    });
}

function curvatureMap(context: AnalysisContext): Promise<Result<AnalysisResult>> | Result<AnalysisResult> {
    const mode = context.settings["mode"];
    if (mode !== "gaussian" && mode !== "minimum" && mode !== "maximum") {
        return Result.err("Choose Gaussian, minimum, or maximum curvature");
    }
    const minimum = numberSetting(context.settings, "minimum", -0.2);
    const maximum = numberSetting(context.settings, "maximum", 0.2);
    if (!(minimum < maximum)) return Result.err("Curvature range must increase");
    return withShapes<IFace>(context, "face", async (faces) => {
        const overlays: FaceMeshData[] = [];
        let unknown = 0;
        let total = 0;
        for (const face of faces) {
            const colored = await colorFace(
                face,
                (u, v) => {
                    const sample = evaluateSurfaceCurvature(face, u, v);
                    if (!sample.isOk) return UNKNOWN_COLOR;
                    const value =
                        mode === "gaussian"
                            ? sample.value.gaussian
                            : mode === "minimum"
                              ? sample.value.kMin
                              : sample.value.kMax;
                    const ratio = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
                    const red = Math.round(255 * ratio);
                    const blue = Math.round(255 * (1 - ratio));
                    return (red << 16) | (0x40 << 8) | blue;
                },
                context.signal,
            );
            if (!colored) {
                unknown++;
                continue;
            }
            overlays.push(colored.overlay);
            unknown += colored.unknown;
            total += colored.total;
        }
        return overlays.length
            ? Result.ok({
                  overlays,
                  legend: [
                      {
                          label: `${mode} curvature`,
                          value: `${minimum} … ${maximum} ${mode === "gaussian" ? "mm⁻²" : "mm⁻¹"}`,
                      },
                      { label: "Unknown triangles", value: `${unknown}/${total}`, color: UNKNOWN_COLOR },
                  ],
              })
            : Result.err("No renderable face samples");
    });
}

function draftAnalysis(context: AnalysisContext): Promise<Result<AnalysisResult>> | Result<AnalysisResult> {
    const pull = directionSetting(context, "pullDirection");
    if (!pull.isOk) return pull.parse();
    const threshold = numberSetting(context.settings, "threshold", 2);
    if (!(threshold >= 0 && threshold <= 90)) return Result.err("Draft threshold must be 0–90 degrees");
    const targets = sourceRole(
        context,
        "targetSourceIndexes",
        context.sources.flatMap((_, index) =>
            index === context.settings["directionSourceIndex"] ? [] : [index],
        ),
    );
    if (!targets.isOk) return targets.parse();
    return withShapes<IFace>(targets.value, "face", async (faces) => {
        const overlays: FaceMeshData[] = [];
        let unknown = 0;
        for (const face of faces) {
            const colored = await colorFace(
                face,
                (u, v) => {
                    const sample = evaluateFaceNormal(face, u, v);
                    if (!sample.isOk) return UNKNOWN_COLOR;
                    const angle = signedDraftAngle(sample.value.normal, pull.value);
                    if (!angle.isOk) return UNKNOWN_COLOR;
                    return angle.value >= threshold
                        ? 0x2bad4b
                        : angle.value <= -threshold
                          ? 0xd44d4d
                          : 0xffc247;
                },
                context.signal,
            );
            if (!colored) {
                unknown++;
                continue;
            }
            unknown += colored.unknown;
            overlays.push(colored.overlay);
        }
        return overlays.length
            ? Result.ok({
                  overlays,
                  legend: [
                      { label: `Positive draft ≥ ${threshold}°`, color: 0x2bad4b },
                      { label: `Negative draft ≤ -${threshold}°`, color: 0xd44d4d },
                      { label: "Zero-draft band", color: 0xffc247 },
                      { label: "Unknown triangles", value: String(unknown), color: UNKNOWN_COLOR },
                  ],
              })
            : Result.err("No renderable face samples");
    });
}

function minimumRadius(context: AnalysisContext): Promise<Result<AnalysisResult>> | Result<AnalysisResult> {
    const threshold = numberSetting(context.settings, "radius", 1);
    if (!(threshold > 0)) return Result.err("Minimum radius must be positive");
    return withShapes<IFace>(context, "face", async (faces) => {
        const overlays: FaceMeshData[] = [];
        let violations = 0;
        let unknown = 0;
        for (const face of faces) {
            const colored = await colorFace(
                face,
                (u, v) => {
                    const sample = evaluateSurfaceCurvature(face, u, v);
                    if (!sample.isOk) return UNKNOWN_COLOR;
                    const status = classifyMinimumRadius(sample.value, threshold);
                    if (!status.isOk) return UNKNOWN_COLOR;
                    if (status.value === "violation") {
                        violations++;
                        return 0xd44d4d;
                    }
                    return 0x2bad4b;
                },
                context.signal,
            );
            if (!colored) {
                unknown++;
                continue;
            }
            unknown += colored.unknown;
            overlays.push(colored.overlay);
        }
        return overlays.length
            ? Result.ok({
                  overlays,
                  legend: [
                      {
                          label: `Concave radius < ${threshold} mm`,
                          value: `${violations} sampled triangles`,
                          color: 0xd44d4d,
                      },
                      { label: "Within local limit", color: 0x2bad4b },
                      { label: "Unknown triangles", value: String(unknown), color: UNKNOWN_COLOR },
                  ],
              })
            : Result.err("No renderable face samples");
    });
}

function isocurves(context: AnalysisContext): Promise<Result<AnalysisResult>> | Result<AnalysisResult> {
    const count = numberSetting(context.settings, "count", 10);
    const steps = numberSetting(context.settings, "steps", 96);
    const combScale = numberSetting(context.settings, "combScale", 0);
    const direction = context.settings["direction"] ?? "both";
    if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 100 ||
        !Number.isInteger(steps) ||
        steps < 8 ||
        steps > 1024 ||
        !["u", "v", "both"].includes(direction as string) ||
        !Number.isFinite(combScale) ||
        combScale < 0
    )
        return Result.err("Invalid isocurve settings");
    return withShapes<IFace>(context, "face", async (faces) => {
        const positions: number[] = [];
        const combPositions: number[] = [];
        let skipped = 0;
        for (const face of faces) {
            const bounds = face.inspectionUVBounds?.();
            if (!bounds?.isOk || !face.inspectionTrimmedIso) {
                skipped++;
                continue;
            }
            const { u1, u2, v1, v2 } = bounds.value;
            for (const axis of direction === "both" ? ["u", "v"] : [direction]) {
                for (let line = 1; line <= count; line++) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    if (context.signal.aborted) return Result.err("Cancelled");
                    const fixed = line / (count + 1);
                    const parameter = axis === "u" ? u1 + fixed * (u2 - u1) : v1 + fixed * (v2 - v1);
                    const iso = face.inspectionTrimmedIso(axis as "u" | "v", parameter);
                    if (!iso) {
                        skipped++;
                        continue;
                    }
                    try {
                        positions.push(...iso.edgesMeshPosition().position);
                        if (combScale > 0) {
                            const edges =
                                iso.shapeType === ShapeTypes.edge
                                    ? [iso]
                                    : iso.findSubShapes(ShapeTypes.edge);
                            try {
                                for (const edge of edges) {
                                    const samples = sampleEdgeCurvature(edge as IEdge, steps);
                                    if (!samples.isOk) {
                                        skipped++;
                                        continue;
                                    }
                                    for (const sample of samples.value) {
                                        if (sample.normal) {
                                            const tip = sample.point.add(
                                                sample.normal.multiply(sample.curvature * combScale),
                                            );
                                            combPositions.push(...sample.point.toArray(), ...tip.toArray());
                                        }
                                    }
                                }
                            } finally {
                                if (edges[0] !== iso) edges.forEach((edge) => edge.dispose());
                            }
                        }
                    } finally {
                        iso.dispose();
                    }
                }
            }
        }
        return positions.length
            ? Result.ok({
                  overlays: [
                      {
                          position: new Float32Array(positions),
                          range: [],
                          lineType: "solid",
                          color: 0x3fc6e8,
                      },
                      ...(combPositions.length
                          ? [
                                {
                                    position: new Float32Array(combPositions),
                                    range: [],
                                    lineType: "solid" as const,
                                    color: 0xffba55,
                                },
                            ]
                          : []),
                  ],
                  legend: [
                      { label: "U/V isocurves", value: `${count} per direction` },
                      { label: "Unsupported faces", value: String(skipped), color: UNKNOWN_COLOR },
                  ],
              })
            : Result.err("No bounded trimmed isocurves available");
    });
}

function accessibility(context: AnalysisContext): Promise<Result<AnalysisResult>> | Result<AnalysisResult> {
    const approach = directionSetting(context, "approachDirection");
    if (!approach.isOk) return approach.parse();
    const resolution = numberSetting(context.settings, "resolution", 1);
    if (!Number.isInteger(resolution) || resolution < 1 || resolution > 8) {
        return Result.err("Resolution must be 1–8 samples per triangle edge");
    }
    const available = context.sources.flatMap((_, index) =>
        index === context.settings["directionSourceIndex"] ? [] : [index],
    );
    const obstructionIndexes = context.settings["obstructionSourceIndexes"];
    const defaultTargets = Array.isArray(obstructionIndexes)
        ? available.filter((index) => !obstructionIndexes.includes(index))
        : available;
    const targetContext = sourceRole(context, "targetSourceIndexes", defaultTargets);
    if (!targetContext.isOk) return targetContext.parse();
    const blockerContext = sourceRole(context, "obstructionSourceIndexes", available);
    if (!blockerContext.isOk) return blockerContext.parse();
    return withShapes<IFace>(targetContext.value, "face", (faces) =>
        withShapes<IFace>(blockerContext.value, "face", async (blockers) => {
            const overlays: FaceMeshData[] = [];
            let obstructed = 0;
            let unknown = 0;
            for (const face of faces) {
                const colored = await colorFace(
                    face,
                    (u, v) => {
                        const sample = evaluateFaceNormal(face, u, v);
                        if (!sample.isOk) return UNKNOWN_COLOR;
                        const facing = signedDraftAngle(sample.value.normal, approach.value);
                        if (!facing.isOk || Math.abs(facing.value) < 0.1) return UNKNOWN_COLOR;
                        if (facing.value < 0) {
                            obstructed++;
                            return 0xd44d4d;
                        }
                        const start = sample.value.point;
                        for (const blocker of blockers) {
                            if (!blocker.inspectionRayHit) return UNKNOWN_COLOR;
                            const hit = blocker.inspectionRayHit(start, approach.value, 1e-4, 1e9, 1e-6);
                            if (!hit.isOk) return UNKNOWN_COLOR;
                            if (hit.value) {
                                obstructed++;
                                return 0xd44d4d;
                            }
                        }
                        return 0x2bad4b;
                    },
                    context.signal,
                    resolution,
                );
                if (!colored) {
                    unknown++;
                    continue;
                }
                unknown += colored.unknown;
                overlays.push(colored.overlay);
            }
            return overlays.length
                ? Result.ok({
                      overlays,
                      legend: [
                          { label: "Directional point access", color: 0x2bad4b },
                          { label: "Obstructed samples", value: String(obstructed), color: 0xd44d4d },
                          { label: "Unknown samples", value: String(unknown), color: UNKNOWN_COLOR },
                      ],
                  })
                : Result.err("No renderable face samples");
        }),
    );
}

function appearanceResult(
    manager: AnalysisManager,
    context: AnalysisContext,
    mode: "chrome" | "zebra",
): Result<AnalysisResult> {
    if (!context.sources.length) return Result.err("Select at least one body");
    const rotation = numberSetting(context.settings, "rotation", 0);
    const direction = numberSetting(context.settings, "direction", 0);
    const density = numberSetting(context.settings, "density", 12);
    const contrast = numberSetting(context.settings, "contrast", 0.8);
    const mirrorFinish = numberSetting(context.settings, "mirrorFinish", 0.8);
    const environment = context.settings["environment"] === "softbox" ? "softbox" : "studio";
    if (
        !Number.isFinite(rotation) ||
        !Number.isFinite(direction) ||
        !(density > 0) ||
        !(contrast >= 0 && contrast <= 1) ||
        !(mirrorFinish >= 0 && mirrorFinish <= 1)
    ) {
        return Result.err("Invalid appearance controls");
    }
    return Result.ok({
        legend: [
            {
                label: mode === "chrome" ? "Procedural studio reflection" : "Zebra reflection stripes",
                value: mode === "chrome" ? environment : `${density} stripes`,
            },
        ],
        display: () =>
            manager.document.visual.context.acquireAnalysisAppearance(
                context.analysisId,
                context.sources.map((source) => ({
                    nodeId: source.node.id,
                    mode,
                    rotation,
                    direction,
                    density,
                    contrast,
                    mirrorFinish,
                    environment,
                })),
            ),
    });
}

function componentColors(manager: AnalysisManager, context: AnalysisContext): Result<AnalysisResult> {
    const nodes = context.sources.length
        ? context.sources.map((source) => source.node)
        : manager.document.modelManager
              .findNodes()
              .filter((node) => node instanceof ShapeNode || node instanceof MeshNode);
    if (!nodes.length) return Result.err("No displayable components");
    const assignments = nodes.map((node) => ({
        nodeId: node.id,
        mode: "color" as const,
        color: componentAnalysisColor(node),
    }));
    return Result.ok({
        legend: [
            { label: "Component owner", value: "Nearest containing group; ungrouped body uses its own ID" },
        ],
        display: () =>
            manager.document.visual.context.acquireAnalysisAppearance(context.analysisId, assignments),
    });
}

export function registerAdvancedInspectAnalyses(manager: AnalysisManager): void {
    manager.registerEvaluator("curvatureComb", curvatureComb);
    manager.registerEvaluator("curvatureMap", curvatureMap);
    manager.registerEvaluator("draft", draftAnalysis);
    manager.registerEvaluator("isocurves", isocurves);
    manager.registerEvaluator("accessibility", accessibility);
    manager.registerEvaluator("minimumRadius", minimumRadius);
    manager.registerEvaluator("environmentMap", (context) => appearanceResult(manager, context, "chrome"));
    manager.registerEvaluator("zebra", (context) => appearanceResult(manager, context, "zebra"));
    manager.registerEvaluator("componentColors", (context) => componentColors(manager, context));
}
