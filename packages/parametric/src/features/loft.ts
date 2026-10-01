// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type IWire, Result, ShapeTypes } from "@spicy3d/core";
import { shapeEntityIds } from "../sketch/sketchModel";
import type { SketchNode } from "../sketch/sketchNode";
import { findSketch } from "./extrude";
import {
    type FeatureContext,
    type FeatureHandler,
    type LoftFeatureData,
    type LoftSection,
    registerFeature,
    type ShapeTracking,
    trackedIds,
} from "./feature";
import { evaluateGuidedLoft, guidedLoftDependencies } from "./guidedLoft";
import { completeEdgeHistory, completeFaceHistory } from "./historyCompletion";
import { resolveProfiles } from "./profileBuilder";
import { collectEdges, groupConnected, hasBranchVertex, needsKernelSplit } from "./profileGeometry";
import { captureProfileRef } from "./profileRef";
import { profileEdgeSeeds } from "./profileSeeds";
import { MATCH_TOLERANCE } from "./refGeometry";

/** A section resolved for one rebuild: a closed profile or open wire, with sketch-scoped identity. */
interface ResolvedLoftSection {
    readonly sketch: SketchNode;
    readonly face?: IFace;
    readonly wire: IWire;
    readonly edgeSeeds?: string[];
    readonly seed: string;
}

/** The stored sections; a malformed payload (no list) reads as none, which the evaluation reports. */
function sectionsOf(feature: LoftFeatureData): readonly LoftSection[] {
    return Array.isArray(feature.sections) ? feature.sections : [];
}

const loftHandler: FeatureHandler<LoftFeatureData> = {
    display: "command.feature.loft",
    icon: "icon-loft",

    nodeIds: (feature) => [
        ...new Set([
            ...sectionsOf(feature).map((section) => section.sketchId),
            ...(feature.guided?.spine?.nodeId ? [feature.guided.spine.nodeId] : []),
            ...(feature.guided?.boundary?.nodeId ? [feature.guided.boundary.nodeId] : []),
        ]),
    ],
    cacheRefIds: (feature, document) => guidedLoftDependencies(feature, document).refIds,
    cacheKey: (feature, document) => guidedLoftDependencies(feature, document).key,

    references: (feature) => [
        ...sectionsOf(feature).map((section, index) => ({
            key: `sections.${index}`,
            display: "body.sketch" as const,
            nodeId: section.sketchId,
        })),
        ...(feature.guided?.spine && feature.guided?.boundary
            ? [
                  {
                      key: "guided.spine",
                      display: "loft.spine" as const,
                      nodeId: feature.guided.spine.nodeId,
                  },
                  {
                      key: "guided.boundary",
                      display: "loft.boundary" as const,
                      nodeId: feature.guided.boundary.nodeId,
                  },
              ]
            : []),
    ],

    parameters: (feature) => [
        { key: "solid", display: "option.command.isSolid", value: feature.solid !== false },
        ...(feature.guided
            ? []
            : [{ key: "ruled", display: "option.command.isRuled" as const, value: feature.ruled === true }]),
    ],

    setParameter: (feature, key, value) =>
        (key === "solid" || (key === "ruled" && !feature.guided)) && typeof value === "boolean"
            ? { ...feature, [key]: value }
            : feature,

    applyResolvedRefs: (feature, { resolvedProfiles, resolvedEdges }) => {
        // Only picked profiles are re-anchored: an absent one keeps meaning "the sketch's only profile".
        return {
            ...feature,
            sections:
                resolvedProfiles?.length === feature.sections.length
                    ? feature.sections.map((section, index) =>
                          section.profile === undefined
                              ? section
                              : { ...section, profile: resolvedProfiles[index] },
                      )
                    : feature.sections,
            ...(feature.guided &&
            resolvedEdges?.length === feature.guided.spine.edges.length + feature.guided.boundary.edges.length
                ? {
                      guided: {
                          spine: {
                              ...feature.guided.spine,
                              edges: resolvedEdges.slice(0, feature.guided.spine.edges.length),
                          },
                          boundary: {
                              ...feature.guided.boundary,
                              edges: resolvedEdges.slice(feature.guided.spine.edges.length),
                          },
                      },
                  }
                : {}),
        };
    },

    evaluate(feature, context): Result<IShape> {
        if (feature.guided !== undefined) return evaluateGuidedLoft(feature, context);
        const owned = new Set<IShape>();
        try {
            const sections = resolveLoftSections(feature, context, owned);
            if (!sections.isOk) return Result.err(sections.error);
            const tracking = context.tracking;
            if (
                tracking !== undefined &&
                sectionsOf(feature).some((section) => section.profile !== undefined)
            ) {
                // Only closed sections can carry picked profile refs.
                tracking.resolvedProfiles = sections.value.map(({ face }) => captureProfileRef(face!));
            }
            const lofted = shapeFactory.loft(
                sections.value.map(({ wire }) => wire),
                feature.solid !== false,
                feature.ruled === true,
                feature.continuity ?? "c2",
            );
            if (!lofted.isOk) return Result.err(lofted.error);
            if (tracking !== undefined) trackLoft(feature, sections.value, lofted.value, tracking);
            return lofted;
        } finally {
            for (const shape of owned) shape.dispose();
        }
    },
};

/**
 * The wire of every section, in loft order. Checked here rather than left to the kernel,
 * which raises on some degenerate inputs (fatal before -fwasm-exceptions; the checks stay for
 * clearer messages and modules built without that handling): at least two sections, each a
 * single hole-free profile or (surface only) simple open wire, no consecutive coplanar sections.
 * Every temporary wire is added to `owned` for release after evaluation, including failed builds.
 */
function resolveLoftSections(
    feature: LoftFeatureData,
    context: Pick<FeatureContext, "document">,
    owned: Set<IShape>,
): Result<ResolvedLoftSection[]> {
    const sections = sectionsOf(feature);
    if (sections.length < 2) return Result.err("A loft needs at least two sections");
    const resolved: ResolvedLoftSection[] = [];
    for (const section of sections) {
        const sketch = findSketch(context.document, section.sketchId);
        if (sketch === undefined) return Result.err("Sketch not found");
        const profiles = resolveProfiles(
            sketch,
            section.profile === undefined ? undefined : [section.profile],
        );
        if (feature.solid === false && section.profile === undefined) {
            const source = sketch.shape;
            if (!source.isOk) return Result.err(source.error);
            const edges = collectEdges(source.value);
            const groups = groupConnected(edges);
            const branched = hasBranchVertex(edges);
            // Preserve closed-profile resolution (including holes and loose scaffolding).
            // Only an unambiguous single chain can denote a new open section.
            if (groups.length !== 1 || branched) {
                if (!profiles.isOk)
                    return Result.err(
                        branched
                            ? "An open loft section must not branch or self-intersect"
                            : "A loft section must be a single profile or open wire",
                    );
            } else {
                const built = shapeFactory.wire(edges);
                if (!built.isOk) return Result.err(built.error);
                owned.add(built.value);
                if (!built.value.isClosed()) {
                    if (needsKernelSplit(edges))
                        return Result.err("An open loft section must not self-intersect");
                    // The existing binding answers true when the wire is free of self-intersection.
                    const checked = built.value.checkSelfIntersection?.();
                    if (!checked?.isOk)
                        return Result.err(
                            checked?.error ?? "Open loft sections require self-intersection checking",
                        );
                    if (!checked.value) return Result.err("An open loft section must not self-intersect");
                    const entities = shapeEntityIds(sketch.data);
                    const wireEdges = collectEdges(built.value);
                    const map = completeEdgeHistory(
                        edges,
                        wireEdges,
                        wireEdges.map(() => -1),
                    );
                    if (map.some((index) => index < 0 || entities[index] === undefined)) {
                        return Result.err("Open loft section lost its sketch entity ancestry");
                    }
                    const seed = `sketch:${sketch.id}:open`;
                    resolved.push({
                        sketch,
                        wire: built.value,
                        seed,
                        edgeSeeds: map.map((index) => `${seed}:ent${entities[index]}`),
                    });
                    continue;
                }
            }
        }
        if (!profiles.isOk) return Result.err(profiles.error);
        if (profiles.value.length !== 1) return Result.err("A loft section must be a single profile");
        const { face, seed } = profiles.value[0];
        if (face.findSubShapes(ShapeTypes.wire).length > 1) {
            return Result.err("A loft section cannot have holes");
        }
        const wire = face.outerWire();
        owned.add(wire);
        resolved.push({ sketch, face, wire, seed: `sketch:${sketch.id}:${seed}` });
    }
    if (resolved.some(({ face }) => face === undefined) && resolved.some(({ face }) => face !== undefined)) {
        return Result.err("Loft sections must be all open or all closed");
    }
    for (let index = 1; index < resolved.length; index++) {
        if (samePlane(resolved[index - 1].sketch, resolved[index].sketch)) {
            return Result.err("Consecutive loft sections must not lie in the same plane");
        }
    }
    return Result.ok(resolved);
}

function samePlane(a: SketchNode, b: SketchNode): boolean {
    const normal = a.plane.normal;
    if (!normal.isParallelTo(b.plane.normal)) return false;
    return Math.abs(b.plane.origin.sub(a.plane.origin).dot(normal)) < MATCH_TOLERANCE;
}

/**
 * Stable ids of the loft's faces and edges. The kernel reports no loft history, so it is
 * recovered from the geometry, which a loft leaves unchanged on its boundary:
 *
 * - **Caps and section edges.** An end cap is geometrically its section's profile face, a
 *   section's boundary edges are the profile's edges — history completion claims them back,
 *   so a cap takes its section's seed and a section edge its sketch entity's seed.
 * - **Side faces.** Each side face is bounded by one edge of every section; it takes the seed of
 *   the first section's edge it touches (the lowest input index, sections being enumerated in
 *   loft order), so it keeps its id however the kernel enumerates the faces.
 * - **Anything else** (the rails between sections, a side face whose section edges the kernel
 *   re-approximated) takes a feature-scoped positional id.
 */
function trackLoft(
    feature: LoftFeatureData,
    sections: readonly ResolvedLoftSection[],
    shape: IShape,
    tracking: ShapeTracking,
): void {
    const closedSections = sections.filter((section) => section.face !== undefined);
    const inputFaces = closedSections.map(({ face }) => face!);
    const inputEdges: IEdge[] = [];
    const edgeSeeds: string[] = [];
    for (const { face, wire, seed, edgeSeeds: openSeeds } of sections) {
        const edges = (face ?? wire).findSubShapes(ShapeTypes.edge) as IEdge[];
        inputEdges.push(...edges);
        // Entity-derived edge seeds survive wire re-enumeration (see profileEdgeSeeds).
        edgeSeeds.push(...(openSeeds ?? profileEdgeSeeds(face!, seed, edges)));
    }
    const outputFaces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const outputEdges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const faceMap = completeFaceHistory(inputFaces, outputFaces, new Array(outputFaces.length).fill(-1));
    const edgeMap = completeEdgeHistory(inputEdges, outputEdges, new Array(outputEdges.length).fill(-1));

    tracking.outputEdgeIds = trackedIds(feature.id, edgeSeeds, edgeMap);
    tracking.outputFaceIds = outputFaces.map((face, index) => {
        // A curved profile's mesh bounds can differ from its cap's exact bounds.
        // Recognize end caps by their plane and area before the bbox matcher.
        const cap = feature.solid === false ? undefined : capSection(face, sections);
        if (cap !== undefined) return cap.seed;
        if (faceMap[index] >= 0) return closedSections[faceMap[index]].seed;
        const sectionEdge = lowestSectionEdge(face, outputEdges, edgeMap);
        return sectionEdge === undefined ? `${feature.id}:${index}` : edgeSeeds[sectionEdge];
    });
}

/** Only the first and last sections can be caps; side faces must never inherit a cap's id. */
function capSection(face: IFace, sections: readonly ResolvedLoftSection[]): ResolvedLoftSection | undefined {
    if (!face.surface().isPlanar()) return undefined;
    const [point, normal] = face.normal(0, 0);
    const area = face.area();
    return [sections[0], sections[sections.length - 1]].find(({ sketch, face: profile }) => {
        const plane = sketch.plane;
        if (!normal.isParallelTo(plane.normal)) return false;
        if (Math.abs(point.sub(plane.origin).dot(plane.normal)) >= MATCH_TOLERANCE) return false;
        if (!profile) return false;
        const profileArea = profile.area();
        return Math.abs(area - profileArea) / Math.max(Math.sqrt(profileArea), 1e-9) < MATCH_TOLERANCE;
    });
}

/** The lowest input edge index among the section edges bounding `face`; undefined when it touches none. */
function lowestSectionEdge(face: IFace, outputEdges: readonly IEdge[], edgeMap: readonly number[]) {
    let lowest: number | undefined;
    for (const edge of face.findSubShapes(ShapeTypes.edge)) {
        const index = outputEdges.findIndex((output) => output.isSame(edge));
        const input = index < 0 ? -1 : edgeMap[index];
        if (input >= 0 && (lowest === undefined || input < lowest)) lowest = input;
    }
    return lowest;
}

registerFeature("loft", loftHandler);
