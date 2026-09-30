// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, Result, ShapeTypes } from "@spicy3d/core";
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
import { completeEdgeHistory, completeFaceHistory } from "./historyCompletion";
import { resolveProfiles } from "./profileBuilder";
import { captureProfileRef } from "./profileRef";
import { profileEdgeSeeds } from "./profileSeeds";
import { MATCH_TOLERANCE } from "./refGeometry";

/** A section resolved for one rebuild: its profile face and the sketch-scoped seed of that face. */
export interface ResolvedLoftSection {
    readonly sketch: SketchNode;
    readonly face: IFace;
    readonly seed: string;
}

/** The stored sections; a malformed payload (no list) reads as none, which the evaluation reports. */
function sectionsOf(feature: LoftFeatureData): readonly LoftSection[] {
    return Array.isArray(feature.sections) ? feature.sections : [];
}

const loftHandler: FeatureHandler<LoftFeatureData> = {
    display: "command.feature.loft",
    icon: "icon-loft",

    nodeIds: (feature) => [...new Set(sectionsOf(feature).map((section) => section.sketchId))],

    references: (feature) =>
        sectionsOf(feature).map((section, index) => ({
            key: `sections.${index}`,
            display: "body.sketch",
            nodeId: section.sketchId,
        })),

    parameters: (feature) => [
        { key: "solid", display: "option.command.isSolid", value: feature.solid !== false },
        { key: "ruled", display: "option.command.isRuled", value: feature.ruled === true },
    ],

    setParameter: (feature, key, value) => ({ ...feature, [key]: value }),

    applyResolvedRefs: (feature, { resolvedProfiles }) => {
        if (resolvedProfiles === undefined || resolvedProfiles.length !== feature.sections.length) {
            return feature;
        }
        // Only picked profiles are re-anchored: an absent one keeps meaning "the sketch's only profile".
        return {
            ...feature,
            sections: feature.sections.map((section, index) =>
                section.profile === undefined ? section : { ...section, profile: resolvedProfiles[index] },
            ),
        };
    },

    evaluate(feature, context): Result<IShape> {
        const sections = resolveLoftSections(feature, context);
        if (!sections.isOk) return Result.err(sections.error);
        const tracking = context.tracking;
        if (tracking !== undefined && sectionsOf(feature).some((section) => section.profile !== undefined)) {
            // Re-anchored refs for the body's write-back (see ShapeTracking).
            tracking.resolvedProfiles = sections.value.map(({ face }) => captureProfileRef(face));
        }
        const lofted = shapeFactory.loft(
            sections.value.map(({ face }) => face.outerWire()),
            feature.solid !== false,
            feature.ruled === true,
            feature.continuity ?? "c2",
        );
        if (!lofted.isOk) return Result.err(lofted.error);
        if (tracking !== undefined) trackLoft(feature, sections.value, lofted.value, tracking);
        return lofted;
    },
};

/**
 * The profile face of every section, in loft order. Checked here rather than left to the kernel,
 * which raises on some degenerate inputs (fatal before -fwasm-exceptions; the checks stay for
 * clearer messages and modules built without that handling): at least two sections, each a
 * single hole-free profile, no two consecutive ones on the same plane.
 */
export function resolveLoftSections(
    feature: LoftFeatureData,
    context: Pick<FeatureContext, "document">,
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
        if (!profiles.isOk) return Result.err(profiles.error);
        if (profiles.value.length !== 1) return Result.err("A loft section must be a single profile");
        const { face, seed } = profiles.value[0];
        if (face.findSubShapes(ShapeTypes.wire).length > 1) {
            return Result.err("A loft section cannot have holes");
        }
        resolved.push({ sketch, face, seed: `sketch:${sketch.id}:${seed}` });
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
    const inputFaces = sections.map(({ face }) => face);
    const inputEdges: IEdge[] = [];
    const edgeSeeds: string[] = [];
    for (const { face, seed } of sections) {
        const edges = face.findSubShapes(ShapeTypes.edge) as IEdge[];
        inputEdges.push(...edges);
        // Entity-derived edge seeds survive wire re-enumeration (see profileEdgeSeeds).
        edgeSeeds.push(...profileEdgeSeeds(face, seed, edges));
    }
    const outputFaces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const outputEdges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const faceMap = completeFaceHistory(inputFaces, outputFaces, new Array(outputFaces.length).fill(-1));
    const edgeMap = completeEdgeHistory(inputEdges, outputEdges, new Array(outputEdges.length).fill(-1));

    tracking.outputEdgeIds = trackedIds(feature.id, edgeSeeds, edgeMap);
    tracking.outputFaceIds = outputFaces.map((face, index) => {
        if (faceMap[index] >= 0) return sections[faceMap[index]].seed;
        const sectionEdge = lowestSectionEdge(face, outputEdges, edgeMap);
        return sectionEdge === undefined ? `${feature.id}:${index}` : edgeSeeds[sectionEdge];
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
