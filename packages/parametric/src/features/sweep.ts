// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    type IWire,
    Result,
    ShapeTypes,
    sha256HexSync,
    type TrackedShape,
    VisualNode,
} from "@spicy3d/core";
import { matchEdgesInEdges } from "./edgeMatcher";
import { captureEdgeRef } from "./edgeRef";
import { findSketch } from "./extrude";
import { type FeatureContext, type FeatureHandler, registerFeature, type SweepFeatureData } from "./feature";
import { pathReferenceDependencies, type ResolvedPath, resolvePathReferences } from "./pathReferences";
import { resolveProfiles } from "./profileBuilder";
import { profileEdgeEntityIds } from "./profileEntities";
import { collectEdges } from "./profileGeometry";
import { captureProfileRef } from "./profileRef";
import { MATCH_TOLERANCE } from "./refGeometry";
import { validateSelfIntersection } from "./selfIntersectionValidation";
import { ancestorInputs, combineIds } from "./trackedId";

export interface SweepSection {
    wire: IWire;
    edges: IEdge[];
    edgeSeeds: string[];
    seed: string;
    face: IFace;
    dispose(): void;
}

export function resolveSweepSection(
    feature: Pick<SweepFeatureData, "section">,
    context: FeatureContext,
): Result<SweepSection> {
    const sketch = feature.section && findSketch(context.document, feature.section.sketchId);
    if (!sketch) return Result.err("Sweep section sketch not found");
    const profiles = resolveProfiles(sketch, feature.section.profile ? [feature.section.profile] : undefined);
    if (!profiles.isOk) return Result.err(profiles.error);
    if (profiles.value.length !== 1) return Result.err("A sweep requires one unambiguous section profile");
    const { face, seed: profileSeed } = profiles.value[0];
    if (face.findSubShapes(ShapeTypes.wire).length !== 1)
        return Result.err("A sweep section cannot have holes");
    const sourceEdges = collectEdges(face);
    const entities = profileEdgeEntityIds(face);
    if (
        !entities ||
        entities.length !== sourceEdges.length ||
        entities.some((entity) => entity === undefined)
    ) {
        return Result.err("Sweep section has no complete sketch entity ancestry");
    }
    const inverse = context.host.worldTransform().invert();
    if (!inverse) return Result.err("Host placement is not invertible");
    const placement = inverse.multiply(sketch.worldTransform());
    const seed = `sketch:${sketch.id}:${profileSeed}`;
    const owned = new Set<IShape>();
    const dispose = () => {
        for (const shape of owned) shape.dispose();
        owned.clear();
    };
    try {
        const outer = face.outerWire();
        owned.add(outer);
        const pieces = collectEdges(outer).map((edge) => {
            const indexes = sourceEdges.flatMap((candidate, index) =>
                edge.isSame(candidate) ? [index] : [],
            );
            if (indexes.length !== 1) throw new Error("Sweep section boundary ancestry is ambiguous");
            const transformed = edge.transformedMul(placement) as IEdge;
            owned.add(transformed);
            return { edge: transformed, seed: `${seed}:ent${entities[indexes[0]]}` };
        });
        const wire = shapeFactory.wire(pieces.map((piece) => piece.edge));
        if (!wire.isOk) {
            dispose();
            return Result.err(wire.error);
        }
        owned.add(wire.value);
        const edges = collectEdges(wire.value);
        const available = new Set(pieces);
        const edgeSeeds = edges.map((edge) => {
            const candidates = [...available];
            const matches = candidates.filter((piece) => edge.isSame(piece.edge));
            const matched =
                matches.length === 1
                    ? Result.ok([candidates.indexOf(matches[0])])
                    : matchEdgesInEdges(
                          candidates.map((piece) => piece.edge),
                          [captureEdgeRef(edge)],
                      );
            if (!matched.isOk || matched.value.length !== 1)
                throw new Error("Sweep section wire lost its entity ancestry");
            const piece = candidates[matched.value[0]];
            available.delete(piece);
            return piece.seed;
        });
        if (available.size) throw new Error("Sweep section wire changed the selected boundary");
        return Result.ok({ wire: wire.value, edges, edgeSeeds, seed, face, dispose });
    } catch (error) {
        dispose();
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

/** Native vertex enumeration is associated through incident source edges and endpoint roles. */
export function sectionVertexSeeds(
    wire: IWire,
    edges: readonly IEdge[],
    seeds: readonly string[],
    path?: ResolvedPath,
): string[] {
    const vertices = wire.findSubShapes(ShapeTypes.vertex) as IVertex[];
    const incidence = edges.map((edge) => edge.findSubShapes(ShapeTypes.vertex) as IVertex[]);
    const first = path?.references[0].edges[0].ends()[0];
    const lastReference = path?.references[path.references.length - 1];
    const last = lastReference?.edges[lastReference.edges.length - 1].ends()[1];
    return vertices.map((vertex) => {
        const incident = edges.flatMap((_, index) =>
            incidence[index].some((candidate) => vertex.isSame(candidate)) ? [seeds[index]] : [],
        );
        if (!incident.length) throw new Error("Sweep input vertex has no source edge ancestry");
        const point = vertex.point();
        const endpoint = first?.isEqualTo(point, MATCH_TOLERANCE)
            ? path?.closed
                ? "seam"
                : "start"
            : last?.isEqualTo(point, MATCH_TOLERANCE)
              ? "end"
              : "junction";
        return `${path ? "path" : "section"}-vertex:${endpoint}:${combineIds(incident)}`;
    });
}

function identity(featureId: string, role: string, sources: readonly string[]): string {
    const provenance = [...new Set(sources)].sort();
    return `${featureId}:sweep:${role}:${sha256HexSync(new TextEncoder().encode(JSON.stringify(provenance)))}`;
}

/** Every output ID comes from actual derivation, adjacent derived faces or exact boundary roles. */
export function trackSweep(
    feature: Pick<SweepFeatureData, "id">,
    section: SweepSection,
    path: ResolvedPath,
    result: TrackedShape,
): Result<{ faceIds: string[]; edgeIds: string[] }> {
    const history = result.pipeHistory;
    if (!history) return Result.err("Geometry kernel did not report complete sweep ancestry");
    try {
        const faces = result.shape.findSubShapes(ShapeTypes.face) as IFace[];
        const edges = collectEdges(result.shape);
        const inputEdges = [
            ...section.edgeSeeds.map((seed) => `section:${seed}`),
            ...path.edgeSeeds.map((seed) => `path:${seed}`),
        ];
        const inputVertices = [
            ...sectionVertexSeeds(section.wire, section.edges, section.edgeSeeds),
            ...sectionVertexSeeds(path.wire, path.edges, path.edgeSeeds, path),
        ];
        const faceEdges = ancestorInputs(
            faces.map(() => -1),
            history.faceEdges,
        );
        const faceVertices = ancestorInputs(
            faces.map(() => -1),
            history.faceVertices,
        );
        const edgeVertices = ancestorInputs(
            edges.map(() => -1),
            history.edgeVertices,
        );
        const edgeEdges = ancestorInputs(result.edgeMap, result.edgeAncestors);
        const origins = (indexes: readonly number[], seeds: readonly string[]): string[] =>
            indexes.map((index) => {
                if (!Number.isInteger(index) || index < 0 || index >= seeds.length)
                    throw new Error("Sweep ancestry refers to an invalid input");
                return seeds[index];
            });
        const faceIds = faces.map((_, index) => {
            if (history.startFaces.includes(index))
                return identity(feature.id, "start-cap", [section.seed, path.references[0].seed]);
            if (result.capFaces?.includes(index))
                return identity(feature.id, "end-cap", [
                    section.seed,
                    path.references[path.references.length - 1].seed,
                ]);
            const sources = [
                ...origins(faceEdges[index], inputEdges),
                ...origins(faceVertices[index], inputVertices),
            ];
            if (!sources.length)
                throw new Error("Sweep face has no source ancestry; re-pick an unambiguous section and path");
            return identity(feature.id, "side", sources);
        });
        const faceBoundaries = faces.map((face) => collectEdges(face));
        const edgeIds = edges.map((edge, index) => {
            const adjacent = faces.flatMap((_, faceIndex) =>
                faceBoundaries[faceIndex].some((candidate) => edge.isSame(candidate))
                    ? [faceIds[faceIndex]]
                    : [],
            );
            const sources = [
                ...origins(edgeEdges[index], inputEdges),
                ...origins(edgeVertices[index], inputVertices),
                ...adjacent,
            ];
            const start = history.startEdges.includes(index),
                end = history.endEdges.includes(index);
            const role = start && end ? "section-seam" : start ? "start-edge" : end ? "end-edge" : "edge";
            if (!sources.length) throw new Error("Sweep edge has no source ancestry");
            return identity(feature.id, role, sources);
        });
        return Result.ok({ faceIds, edgeIds });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

const handler: FeatureHandler<SweepFeatureData> = {
    display: "command.feature.sweep",
    icon: "icon-sweep",
    reselectable: true,
    nodeIds: (feature) => [
        ...new Set(
            [feature.section?.sketchId, feature.path?.nodeId].filter(
                (id): id is string => typeof id === "string",
            ),
        ),
    ],
    cacheKey: (feature, document) => {
        const host = hostOf(feature, document);
        const node = host && document.modelManager.findNode((candidate) => candidate.id === host);
        return node instanceof VisualNode
            ? JSON.stringify([
                  node.worldTransform().toArray(),
                  pathReferenceDependencies(feature.path, document, node.id).key,
              ])
            : undefined;
    },
    cacheRefIds: (feature, document) => {
        const host = hostOf(feature, document);
        const ids = host
            ? pathReferenceDependencies(feature.path, document, host).refIds
            : [feature.path.nodeId];
        return [...new Set([feature.section.sketchId, ...ids])];
    },
    references: (feature) => [
        { key: "section", display: "body.sketch", nodeId: feature.section.sketchId },
        { key: "path", display: "body.sweep", nodeId: feature.path.nodeId },
    ],
    parameters: (feature) => [
        { key: "solid", display: "option.command.isSolid", value: feature.solid !== false },
        { key: "roundCorner", display: "option.command.roundCorner", value: feature.roundCorner === true },
    ],
    setParameter: (feature, key, value) =>
        (key === "solid" || key === "roundCorner") && typeof value === "boolean"
            ? { ...feature, [key]: value }
            : feature,
    applyResolvedRefs: (feature, refs) => ({
        ...feature,
        section:
            refs.resolvedProfiles?.[0] && feature.section.profile
                ? { ...feature.section, profile: refs.resolvedProfiles[0] }
                : feature.section,
        path: refs.resolvedEdges ? { ...feature.path, edges: refs.resolvedEdges } : feature.path,
    }),
    evaluate(feature, context) {
        if (!shapeFactory.sweepTracked)
            return Result.err("Tracked path sweep requires a newer geometry kernel");
        const section = resolveSweepSection(feature, context);
        if (!section.isOk) return Result.err(section.error);
        const path = resolvePathReferences(feature.path, context);
        if (!path.isOk) {
            section.value.dispose();
            return Result.err(path.error);
        }
        try {
            const swept = shapeFactory.sweepTracked(
                section.value.wire,
                path.value.wire,
                feature.solid !== false,
                feature.roundCorner === true,
            );
            if (!swept.isOk) return Result.err(swept.error);
            const shape = swept.value.shape;
            const faces = shape.findSubShapes(ShapeTypes.face);
            const faceCount = faces.length;
            for (const face of faces) face.dispose();
            if (faceCount > 256) {
                shape.dispose();
                return Result.err("Sweep exceeds the 256-face validation limit");
            }
            const clean = validateSelfIntersection(shape, context.warn);
            if (!clean?.isOk || !clean.value) {
                shape.dispose();
                return Result.err(
                    clean && !clean.isOk ? clean.error : "Sweep intersects itself or cannot be validated",
                );
            }
            const ids = trackSweep(feature, section.value, path.value, swept.value);
            if (!ids.isOk) {
                shape.dispose();
                return Result.err(ids.error);
            }
            if (context.tracking) {
                context.tracking.outputFaceIds = ids.value.faceIds;
                context.tracking.outputEdgeIds = ids.value.edgeIds;
                context.tracking.resolvedProfiles = [captureProfileRef(section.value.face)];
                context.tracking.resolvedEdges = path.value.references.map((reference) => reference.anchor);
            }
            return Result.ok(shape);
        } finally {
            path.value.dispose();
            section.value.dispose();
        }
    },
};

registerFeature("sweep", handler);

function hostOf(feature: SweepFeatureData, document: IDocument): string | undefined {
    return document.modelManager.findNode((node) => {
        const features = (node as { features?: unknown }).features;
        return Array.isArray(features) && features.some((item: { id: string }) => item.id === feature.id);
    })?.id;
}
