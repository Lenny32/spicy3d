// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AnalysisContext,
    type AnalysisManager,
    type AnalysisResult,
    type FaceMeshData,
    type IFace,
    MeshDataUtils,
    Result,
    ShapeNode,
    ShapeTypes,
    ShapeTypeUtils,
    XYZ,
    type XYZLike,
} from "@spicy3d/core";
import { classifyMinimumRadius, evaluateSurfaceCurvature, signedDraftAngle } from "./geometry";
import { describeShape, similarityScoreParts } from "./similarity";

interface AxisData {
    point: XYZLike;
    direction: XYZLike;
}

export interface FastenerMember {
    nodeId: string;
    role: "bolt" | "washer" | "nut" | "part";
    diameter?: number;
    thickness?: number;
    holeDiameter?: number;
    axis?: AxisData;
}

function isPoint(value: unknown): value is XYZLike {
    return (
        typeof value === "object" &&
        value !== null &&
        "x" in value &&
        "y" in value &&
        "z" in value &&
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        typeof value.z === "number" &&
        [value.x, value.y, value.z].every(Number.isFinite)
    );
}

function fastenerStack(context: AnalysisContext): Result<AnalysisResult> {
    const members = context.settings["members"] as FastenerMember[] | undefined;
    if (!Array.isArray(members) || !members.length) {
        return Result.ok({
            rows: [{ label: "Incomplete stack", value: "Assign bolt, clamped members, and hole metadata" }],
            legend: [{ label: "Status", value: "Incomplete—no semantics inferred from geometry" }],
        });
    }
    const rows: NonNullable<AnalysisResult["rows"]> = [];
    let failed = 0;
    let incomplete = 0;
    const boltMembers = members.filter((member) => member.role === "bolt");
    if (boltMembers.length !== 1) return Result.err("Assign exactly one bolt to a fastener stack");
    if (new Set(members.map((member) => member.nodeId)).size !== members.length) {
        return Result.err("A node can only appear once in a fastener stack");
    }
    if (
        members.some(
            (member) =>
                !["bolt", "washer", "nut", "part"].includes(member.role) ||
                (member.diameter !== undefined &&
                    (!Number.isFinite(member.diameter) || member.diameter <= 0)) ||
                (member.holeDiameter !== undefined &&
                    (!Number.isFinite(member.holeDiameter) || member.holeDiameter <= 0)) ||
                (member.thickness !== undefined &&
                    (!Number.isFinite(member.thickness) || member.thickness <= 0)),
        )
    ) {
        return Result.err("Fastener member roles and dimensions must be valid positive values");
    }
    const bolt = boltMembers[0];
    const byId = new Map(context.sources.map((source) => [source.node.id, source]));
    if (!byId.has(bolt.nodeId)) return Result.err("Bolt source is missing");
    const boltLength = Number(context.settings["nominalLength"]);
    const shaftDiameter = bolt.diameter;
    const clearanceMin = Number(context.settings["clearanceMin"] ?? 0);
    const clearanceMax = Number(context.settings["clearanceMax"] ?? 1);
    const alignmentTolerance = Number(context.settings["alignmentTolerance"] ?? 0.2);
    const angleTolerance = Number(context.settings["angleTolerance"] ?? 2);
    const minEngagement = Number(context.settings["minEngagement"] ?? 2);
    const maxEngagement = Number(context.settings["maxEngagement"] ?? Number.POSITIVE_INFINITY);
    const threadLength =
        context.settings["threadLength"] === undefined ? undefined : Number(context.settings["threadLength"]);
    const positive = [
        boltLength,
        shaftDiameter,
        clearanceMin,
        clearanceMax,
        alignmentTolerance,
        angleTolerance,
        minEngagement,
        threadLength,
    ].every((value) => value === undefined || Number.isFinite(value));
    if (
        !positive ||
        !(boltLength > 0) ||
        clearanceMin < 0 ||
        clearanceMax < clearanceMin ||
        minEngagement < 0 ||
        alignmentTolerance < 0 ||
        angleTolerance < 0 ||
        Number.isNaN(maxEngagement) ||
        maxEngagement < minEngagement ||
        members.filter((member) => member.role === "nut").length > 1
    ) {
        return Result.err("Fastener dimensions and tolerances are invalid");
    }
    const boltSource = byId.get(bolt.nodeId)!;
    const boltAxis =
        bolt.axis && isPoint(bolt.axis.point) && isPoint(bolt.axis.direction)
            ? {
                  point: boltSource.worldTransform.ofPoint(new XYZ(bolt.axis.point)),
                  direction: boltSource.worldTransform.ofVector(new XYZ(bolt.axis.direction)).normalize(),
              }
            : undefined;
    let grip = 0;
    for (const member of members) {
        if (context.signal.aborted) return Result.err("Fastener analysis cancelled");
        const source = byId.get(member.nodeId);
        if (!source) {
            rows.push({
                label: member.nodeId,
                value: "Incomplete: source missing",
                sourceIds: [member.nodeId],
            });
            incomplete++;
            continue;
        }
        if (member.role === "part" || member.role === "washer") {
            if (typeof member.thickness === "number" && member.thickness > 0) {
                if (boltAxis?.direction && member.axis && isPoint(member.axis.point)) {
                    const entry = source.worldTransform.ofPoint(new XYZ(member.axis.point));
                    const start = entry.sub(boltAxis.point).dot(boltAxis.direction);
                    grip = Math.max(grip, start + member.thickness);
                } else grip += member.thickness;
            } else {
                rows.push({
                    label: source.node.name,
                    value: "Incomplete: thickness missing",
                    sourceIds: [member.nodeId],
                });
                incomplete++;
            }
        }
        if (member.role === "part" || member.role === "washer" || member.role === "nut") {
            if (shaftDiameter === undefined || member.holeDiameter === undefined) {
                rows.push({
                    label: source.node.name,
                    value: "Incomplete: diameter metadata missing",
                    sourceIds: [member.nodeId],
                });
                incomplete++;
            } else {
                const clearance = member.holeDiameter - shaftDiameter;
                const okay = clearance >= clearanceMin && clearance <= clearanceMax;
                rows.push({
                    label: `${source.node.name} diameter fit`,
                    value: `${clearance.toFixed(3)} mm clearance; ${okay ? "pass" : "outside limits"}`,
                    sourceIds: [bolt.nodeId, member.nodeId],
                });
                if (!okay) failed++;
            }
            if (
                !boltAxis?.direction ||
                !member.axis ||
                !isPoint(member.axis.point) ||
                !isPoint(member.axis.direction)
            ) {
                rows.push({
                    label: `${source.node.name} alignment`,
                    value: "Incomplete: local hole axis missing",
                    sourceIds: [member.nodeId],
                });
                incomplete++;
            } else {
                const point = source.worldTransform.ofPoint(new XYZ(member.axis.point));
                const direction = source.worldTransform.ofVector(new XYZ(member.axis.direction)).normalize();
                if (!direction) return Result.err(`Invalid axis for ${source.node.name}`);
                const difference = point.sub(boltAxis.point);
                const radial = difference
                    .sub(boltAxis.direction.multiply(difference.dot(boltAxis.direction)))
                    .length();
                const angle =
                    (Math.acos(Math.min(1, Math.abs(direction.dot(boltAxis.direction)))) * 180) / Math.PI;
                const okay = radial <= alignmentTolerance && angle <= angleTolerance;
                rows.push({
                    label: `${source.node.name} alignment`,
                    value: `${radial.toFixed(3)} mm radial, ${angle.toFixed(2)}°; ${okay ? "pass" : "misaligned"}`,
                    sourceIds: [bolt.nodeId, member.nodeId],
                });
                if (!okay) failed++;
            }
        }
    }
    const nut = members.find((member) => member.role === "nut");
    const nutSource = nut && byId.get(nut.nodeId);
    const nutEntry =
        nut?.axis && nutSource && boltAxis?.direction && isPoint(nut.axis.point)
            ? nutSource.worldTransform
                  .ofPoint(new XYZ(nut.axis.point))
                  .sub(boltAxis.point)
                  .dot(boltAxis.direction)
            : undefined;
    const stackEnd = nutEntry ?? grip;
    const available = boltLength - stackEnd;
    if (grip <= 0) {
        rows.push({ label: "Bolt reach", value: "Incomplete: grip thickness missing" });
        incomplete++;
    } else {
        const okay = available >= minEngagement;
        rows.push({
            label: "Bolt reach",
            value: `${available.toFixed(3)} mm beyond stack; ${okay ? "pass" : "short bolt"}`,
        });
        if (!okay) failed++;
    }
    const tappedDepth =
        context.settings["tappedDepth"] === undefined ? undefined : Number(context.settings["tappedDepth"]);
    const engagementDepth = nut?.thickness ?? tappedDepth;
    if (threadLength === undefined || engagementDepth === undefined) {
        rows.push({ label: "Thread engagement", value: "Incomplete: threaded length missing" });
        incomplete++;
    } else if (
        !Number.isFinite(threadLength) ||
        threadLength <= 0 ||
        !Number.isFinite(engagementDepth) ||
        engagementDepth <= 0
    ) {
        return Result.err("Threaded length and engagement depth must be positive");
    } else {
        // Intersect the bolt's threaded interval with the nut/tapped-hole interval,
        // both measured axially from the underside of the bolt head.
        const entry = nut ? nutEntry : grip;
        if (entry === undefined) {
            rows.push({ label: "Thread engagement", value: "Incomplete: nut axial entry placement missing" });
            incomplete++;
        } else {
            const engagement = Math.max(
                0,
                Math.min(boltLength, entry + engagementDepth) - Math.max(boltLength - threadLength, entry),
            );
            const okay = engagement >= minEngagement && engagement <= maxEngagement;
            rows.push({
                label: "Thread engagement",
                value: `${engagement.toFixed(3)} mm; ${okay ? "pass" : "outside limits"}`,
            });
            if (!okay) failed++;
        }
    }
    return Result.ok({
        rows,
        legend: [
            { label: "Failed checks", value: String(failed), color: failed ? 0xd44d4d : 0x2bad4b },
            {
                label: "Incomplete checks",
                value: String(incomplete),
                color: incomplete ? 0xffc247 : 0x2bad4b,
            },
        ],
    });
}

function meshFaceGroups(context: AnalysisContext): Result<AnalysisResult> {
    const overlays: FaceMeshData[] = [];
    const legend: NonNullable<AnalysisResult["legend"]> = [];
    const rows: NonNullable<AnalysisResult["rows"]> = [];
    for (const source of context.sources) {
        if (context.signal.aborted) return Result.err("Mesh face group display cancelled");
        const mesh = source.mesh;
        if (!mesh || mesh.meshType !== "surface" || !mesh.position) {
            rows.push({ label: source.node.name, value: "Unavailable: source is not a surface mesh" });
            continue;
        }
        const groups = mesh.semanticFaceGroups;
        if (groups.length && !mesh.semanticGroupsAreCurrent()) {
            rows.push({
                label: source.node.name,
                value: "Unavailable: mesh topology changed after group assignment",
            });
            continue;
        }
        if (!groups.length) {
            rows.push({ label: source.node.name, value: "Unavailable: no semantic face groups" });
            continue;
        }
        const indices =
            mesh.index ?? new Uint32Array(Array.from({ length: mesh.position.length / 3 }, (_, i) => i));
        const normalMatrix = source.worldTransform.invert()?.transpose();
        if (!normalMatrix) return Result.err(`Mesh ${source.node.name} has a singular transform`);
        const normals = new Float32Array(mesh.position.length);
        if (mesh.normal) {
            for (let offset = 0; offset < mesh.normal.length; offset += 3) {
                const transformed = normalMatrix
                    .ofVector(new XYZ(mesh.normal[offset], mesh.normal[offset + 1], mesh.normal[offset + 2]))
                    .normalize();
                if (!transformed) return Result.err(`Mesh ${source.node.name} has invalid normals`);
                normals.set(transformed.toArray(), offset);
            }
        }
        for (const [groupIndex, group] of groups.entries()) {
            const selected = indices.slice(
                group.startTriangle * 3,
                (group.startTriangle + group.triangleCount) * 3,
            );
            const color = group.color ?? (0x3b82f6 + groupIndex * 0x3150af) & 0xffffff;
            const positions = source.worldTransform.ofPoints(mesh.position);
            overlays.push({
                position: new Float32Array(positions),
                index: selected,
                normal: normals,
                uv: mesh.uv ? new Float32Array(mesh.uv) : new Float32Array((mesh.position.length / 3) * 2),
                range: [],
                groups: [],
                color,
            });
            legend.push({
                label: `${source.node.name}: ${group.name}`,
                value: `${group.triangleCount} triangles`,
                color,
            });
            rows.push({
                label: group.name,
                value: `${group.triangleCount} triangles`,
                sourceIds: [source.node.id],
            });
        }
    }
    if (!overlays.length)
        return Result.err(rows.map((row) => row.value).join("; ") || "No semantic mesh face groups");
    return Result.ok({ overlays, legend, rows });
}

async function designAdvice(context: AnalysisContext): Promise<Result<AnalysisResult>> {
    if (context.sources.length !== 1 || !context.sources[0].shape) {
        return Result.err("Design advice supports one closed solid at a time");
    }
    const minimumWall = Number(context.settings["minimumWall"] ?? 1);
    const nominalWall = Number(context.settings["nominalWall"] ?? 2);
    const wallVariation = Number(context.settings["wallVariation"] ?? 0.2);
    const minimumDraft = Number(context.settings["minimumDraft"] ?? 2);
    const minimumRadius = Number(context.settings["minimumRadius"] ?? 1);
    const rawPull = context.settings["pullDirection"];
    const pull = isPoint(rawPull) ? new XYZ(rawPull).normalize() : undefined;
    if (
        ![minimumWall, nominalWall, wallVariation, minimumDraft, minimumRadius].every(Number.isFinite) ||
        minimumWall <= 0 ||
        nominalWall <= 0 ||
        wallVariation < 0 ||
        minimumDraft < 0 ||
        minimumDraft > 90 ||
        minimumRadius <= 0 ||
        !pull
    ) {
        return Result.err("Set positive wall/radius limits, draft angle, and a nonzero pull direction");
    }
    const world = context.sources[0].shape.transformedMul(context.sources[0].worldTransform);
    try {
        if (
            !(
                world.shapeType === ShapeTypes.solid ||
                ShapeTypeUtils.hasCompound(world.shapeType) ||
                ShapeTypeUtils.hasCompoundSolid(world.shapeType)
            ) ||
            !world.checkShape()
        ) {
            return Result.err("Design advice requires a valid closed solid");
        }
        const mass = world.inspectionMass?.();
        if (!mass?.isOk) return Result.err(mass?.error ?? "Valid solid volume query is unavailable");
        const solids = world.findSubShapes(ShapeTypes.solid);
        const solidCount = solids.length;
        solids.forEach((solid) => solid.dispose());
        if (solidCount !== 1) return Result.err("Design advice requires exactly one closed solid");
        const faces = world.findSubShapes(ShapeTypes.face) as IFace[];
        try {
            const rows: NonNullable<AnalysisResult["rows"]> = [];
            const overlays: NonNullable<AnalysisResult["overlays"]> = [];
            let unknown = 0;
            let checked = 0;
            let findingCount = 0;
            let wallEvaluated = 0;
            let draftEvaluated = 0;
            let radiusEvaluated = 0;
            const bounds = world.boundingBox();
            const maxRayDistance =
                Math.hypot(
                    bounds.max.x - bounds.min.x,
                    bounds.max.y - bounds.min.y,
                    bounds.max.z - bounds.min.z,
                ) *
                    2 +
                1;
            for (const [faceIndex, face] of faces.entries()) {
                const mesh = face.mesh.faces;
                if (!mesh?.index.length) {
                    unknown++;
                    continue;
                }
                const uvBounds = face.inspectionUVBounds?.();
                const step = Math.max(1, Math.floor(mesh.index.length / 3 / 24));
                for (let triangle = 0; triangle < mesh.index.length / 3; triangle += step) {
                    if (checked++ % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    if (context.signal.aborted) return Result.err("Design advice cancelled");
                    const vertices = [0, 1, 2].map((corner) => mesh.index[triangle * 3 + corner]);
                    if (!uvBounds?.isOk) {
                        unknown += 3;
                        continue;
                    }
                    const uv = [0, 1].map(
                        (axis) => vertices.reduce((sum, vertex) => sum + mesh.uv[vertex * 2 + axis], 0) / 3,
                    );
                    const u = uvBounds.value.u1 + uv[0] * (uvBounds.value.u2 - uvBounds.value.u1);
                    const v = uvBounds.value.v1 + uv[1] * (uvBounds.value.v2 - uvBounds.value.v1);
                    let point: XYZ;
                    let normal: XYZ | undefined;
                    try {
                        const evaluated = face.normal(u, v);
                        point = evaluated[0];
                        normal = evaluated[1].normalize();
                    } catch {
                        unknown += 3;
                        continue;
                    }
                    if (!normal || !face.containsPoint(point, true, 1e-5)) {
                        unknown += 3;
                        continue;
                    }
                    const distances: number[] = [];
                    let rayUnknown = false;
                    for (const direction of [normal, normal.reverse()]) {
                        for (const other of faces) {
                            const hit = other.inspectionRayHit?.(
                                point,
                                direction,
                                1e-4,
                                maxRayDistance,
                                1e-6,
                            );
                            if (!hit?.isOk) {
                                rayUnknown = true;
                                continue;
                            }
                            if (hit?.isOk && hit.value) {
                                const travel = hit.value.sub(point).dot(direction);
                                if (travel > 1e-4) distances.push(travel);
                            }
                        }
                    }
                    const thickness = !rayUnknown && distances.length ? Math.min(...distances) : undefined;
                    if (thickness === undefined) unknown++;
                    else {
                        wallEvaluated++;
                        if (
                            thickness < minimumWall ||
                            Math.abs(thickness - nominalWall) > nominalWall * wallVariation
                        ) {
                            const threshold =
                                thickness < minimumWall ? minimumWall : nominalWall * wallVariation;
                            rows.push({
                                label: `Wall at face ${faceIndex + 1}`,
                                value: `${thickness.toFixed(3)} mm; ${thickness < minimumWall ? "below minimum" : "outside nominal variation"} (${threshold.toFixed(3)} mm threshold)`,
                                sourceIds: [context.sources[0].node.id],
                                overlays: [MeshDataUtils.createVertexMesh(point, 7, 0xd44d4d)],
                            });
                            findingCount++;
                        }
                    }
                    const curvature = evaluateSurfaceCurvature(face, u, v);
                    const draft = signedDraftAngle(normal, pull);
                    if (draft.isOk) {
                        draftEvaluated++;
                        if (draft.value < minimumDraft) {
                            rows.push({
                                label: `Draft at face ${faceIndex + 1}`,
                                value: `${draft.value.toFixed(2)}° ${draft.value < -minimumDraft ? "negative undercut" : "below minimum"} (${minimumDraft}° threshold)`,
                                sourceIds: [context.sources[0].node.id],
                                overlays: [MeshDataUtils.createVertexMesh(point, 7, 0xffc247)],
                            });
                            findingCount++;
                        }
                    } else unknown++;
                    if (!curvature.isOk) {
                        unknown++;
                        continue;
                    }
                    const radius = classifyMinimumRadius(curvature.value, minimumRadius);
                    if (radius.isOk) radiusEvaluated++;
                    if (radius.isOk && radius.value === "violation") {
                        const measured = curvature.value.kMin < 0 ? -1 / curvature.value.kMin : undefined;
                        rows.push({
                            label: `Concave radius at face ${faceIndex + 1}`,
                            value: `${measured?.toFixed(3) ?? "Unknown"} mm; below ${minimumRadius} mm sampled limit`,
                            sourceIds: [context.sources[0].node.id],
                            overlays: [MeshDataUtils.createVertexMesh(point, 7, 0xd44d4d)],
                        });
                        findingCount++;
                    } else if (!radius.isOk) unknown++;
                }
            }
            if (!checked) return Result.err("No sampleable face regions; design checks are unavailable");
            return Result.ok({
                rows: rows.length
                    ? rows
                    : [
                          {
                              label: "No sampled violations",
                              value:
                                  wallEvaluated && draftEvaluated && radiusEvaluated
                                      ? "Sampled rules only; not a manufacturing certification"
                                      : "Inconclusive: one or more checks had no valid samples",
                          },
                      ],
                overlays,
                legend: [
                    {
                        label: "Findings",
                        value: String(findingCount),
                        color: findingCount ? 0xd44d4d : unknown ? 0x888888 : 0x2bad4b,
                    },
                    { label: "Unknown samples", value: String(unknown), color: 0x888888 },
                    {
                        label: "Evaluated",
                        value: `wall ${wallEvaluated}, draft ${draftEvaluated}, radius ${radiusEvaluated}`,
                    },
                    {
                        label: "Scope",
                        value: "Local sampled draft, concave radius, and opposite-skin wall thickness",
                    },
                ],
            });
        } finally {
            faces.forEach((face) => face.dispose());
        }
    } finally {
        world.dispose();
    }
}

async function similarComponents(
    manager: AnalysisManager,
    context: AnalysisContext,
): Promise<Result<AnalysisResult>> {
    if (context.sources.length !== 1 || !context.sources[0].shape) {
        return Result.err("Select one solid as the similarity query");
    }
    const query = context.sources[0].shape.transformedMul(context.sources[0].worldTransform);
    let descriptor: ReturnType<typeof describeShape>;
    let queryCenter: XYZ;
    try {
        descriptor = describeShape(query);
        const bounds = query.boundingBox();
        queryCenter = new XYZ(bounds.min).add(bounds.max).multiply(0.5);
    } finally {
        query.dispose();
    }
    if (!descriptor.isOk) return Result.err(descriptor.error);
    const scaleInvariant = context.settings["scaleInvariant"] === true;
    const documents = [...manager.document.application.documents];
    const candidates: Array<{
        score: number;
        explanation: string;
        documentId: string;
        nodeId: string;
        name: string;
        mesh?: FaceMeshData;
    }> = [];
    let entries = 0;
    for (const document of documents) {
        const ids = document.userData?.["inspectLibrary"];
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (context.signal.aborted) return Result.err("Similarity search cancelled");
            if (typeof id !== "string") continue;
            const node = document.modelManager.findNode((candidate) => candidate.id === id);
            if (!(node instanceof ShapeNode) || !node.shape.isOk) continue;
            if (document === manager.document && node.id === context.sources[0].node.id) continue;
            if (entries++ >= 100) return Result.err("Local component library exceeds 100 valid entries");
            const source = document.analyses.resolveSource({ nodeId: id });
            if (!source.isOk || !source.value.shape) continue;
            try {
                const world = source.value.shape.transformedMul(source.value.worldTransform);
                try {
                    const comparison = describeShape(world);
                    if (!comparison.isOk) continue;
                    const faceMesh = world.mesh.faces;
                    const candidateBounds = world.boundingBox();
                    const delta = queryCenter.sub(
                        new XYZ(candidateBounds.min).add(candidateBounds.max).multiply(0.5),
                    );
                    const preview = faceMesh?.position.slice();
                    if (preview)
                        for (let index = 0; index < preview.length; index += 3) {
                            preview[index] += delta.x;
                            preview[index + 1] += delta.y;
                            preview[index + 2] += delta.z;
                        }
                    const score = similarityScoreParts(descriptor.value, comparison.value, scaleInvariant);
                    candidates.push({
                        score: score.total,
                        explanation: `size ${score.size.toFixed(4)}, covariance ${score.covariance.toFixed(4)}, radial ${score.radial.toFixed(4)}`,
                        documentId: document.id,
                        nodeId: node.id,
                        name: node.name,
                        mesh:
                            faceMesh && preview
                                ? { ...faceMesh, position: preview, range: [], color: 0x50b4d8 }
                                : undefined,
                    });
                } finally {
                    world.dispose();
                }
            } finally {
                source.value.dispose();
            }
        }
    }
    if (!entries || !candidates.length)
        return Result.err("No other indexed bodies are available in open documents");
    candidates.sort((left, right) => left.score - right.score);
    return Result.ok({
        rows: candidates.slice(0, 20).map((candidate, rank) => ({
            label: `${rank + 1}. ${candidate.name}`,
            value: `distance ${candidate.score.toFixed(4)} (${candidate.explanation})`,
            documentId: candidate.documentId,
            nodeId: candidate.nodeId,
            sourceIds: candidate.documentId === manager.document.id ? [candidate.nodeId] : undefined,
            overlays: candidate.mesh ? [candidate.mesh] : undefined,
        })),
        legend: [
            { label: "Library", value: `${entries} explicit local entries` },
            { label: "Ranking", value: "Lower descriptor distance is more similar" },
        ],
    });
}

export function registerPrerequisiteInspectAnalyses(manager: AnalysisManager): void {
    manager.registerEvaluator("fastenerStack", fastenerStack);
    manager.registerEvaluator("meshFaceGroups", meshFaceGroups);
    manager.registerEvaluator("designAdvice", designAdvice);
    manager.registerEvaluator("similarComponents", (context) => similarComponents(manager, context));
}
