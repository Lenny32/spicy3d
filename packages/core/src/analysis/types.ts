// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation";
import type { Matrix4, XYZLike } from "../math";
import type { INode } from "../model";
import type { IShape, Mesh, ShapeMeshData } from "../shape";

export type AnalysisStatus = "idle" | "running" | "ready" | "invalid";

export interface AnalysisSourceRef {
    nodeId: string;
    subShape?: {
        kind: "face" | "edge" | "vertex";
        stableId?: string;
        index?: number;
        /** Geometry fingerprint required when no stable parametric id is available. */
        signature?: string;
    };
}

export interface AnalysisDefinition {
    id: string;
    name: string;
    kind: string;
    sources: AnalysisSourceRef[];
    settings: Record<string, unknown>;
    visible: boolean;
}

export interface ResolvedAnalysisSource {
    reference: AnalysisSourceRef;
    node: INode;
    shape?: IShape;
    mesh?: Mesh;
    subShape?: IShape;
    worldTransform: Matrix4;
    /** Releases temporary topology wrappers, never the node's borrowed base shape. */
    dispose(): void;
}

export interface AnalysisContext {
    analysisId: string;
    sources: ResolvedAnalysisSource[];
    settings: Record<string, unknown>;
    signal: AbortSignal;
}

export interface AnalysisLegendEntry {
    label: string;
    value?: string;
    color?: number;
}

export interface AnalysisResult {
    /** Temporary overlay meshes. The manager removes them when invalidated or hidden. */
    overlays?: ShapeMeshData[];
    legend?: AnalysisLegendEntry[];
    /** Named geometry results, kept outside the document feature chain. */
    rows?: Array<{
        label: string;
        value?: string;
        sourceIds?: string[];
        overlays?: ShapeMeshData[];
        documentId?: string;
        nodeId?: string;
    }>;
    /** Geometry owned by this result; disposed when superseded. */
    dispose?: () => void;
    /** Additional viewport state owned by the evaluator. */
    display?: (context: AnalysisContext) => (() => void) | void;
    /** Optional point marker that measurement can use directly. Coordinates are millimetres. */
    marker?: XYZLike;
}

export type AnalysisEvaluator = (
    context: AnalysisContext,
) => Result<AnalysisResult> | Promise<Result<AnalysisResult>>;
