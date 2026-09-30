// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation";
import type { Plane, XYZ, XYZLike } from "../math";
import type { ParameterValue } from "../parameters/expression";
import type { ICurve, IEdge, IFace } from "../shape";

export type ConstructionKind = "plane" | "axis" | "point" | "ucs";
export type ConstructionGeometry =
    | { kind: "plane"; plane: Plane }
    | { kind: "axis"; origin: XYZ; direction: XYZ }
    | { kind: "point"; point: XYZ }
    | { kind: "ucs"; origin: XYZ; x: XYZ; y: XYZ; z: XYZ };

export type ConstructionRef =
    | { kind: "origin-plane"; plane: "XY" | "YZ" | "ZX" }
    | { kind: "datum"; nodeId: string; member?: "XY" | "YZ" | "ZX" | "X" | "Y" | "Z" }
    | {
          kind: "shape";
          nodeId: string;
          shapeType: "face" | "edge" | "vertex";
          index: number;
          trackedId?: string;
          /** Vertex identity as the intersection of tracked incident edges. */
          incidentEdgeIds?: string[];
          /** Captured local normal/direction keeps orientation stable if source topology reverses. */
          orientation?: XYZLike;
          /** Unique semantic identity for untracked primitives that change dimensions. */
          semantic?:
              | { kind: "analytic-face"; surface: "cylinder" | "cone" | "sphere" | "torus" }
              | { kind: "circle-edge" }
              | { kind: "extreme-vertex"; signs: [-1 | 1, -1 | 1, -1 | 1] };
          /** Required when no tracked id exists; reject a changed index rather than reattach. */
          fingerprint?: string;
          /** Feature position in the referenced parametric body, when applicable. */
          featureIndex?: number;
      }
    | { kind: "snap"; source: ConstructionRef; snap: "start" | "end" | "middle" | "center" }
    | { kind: "path"; segments: ConstructionRef[]; branch?: number; reversed?: boolean }
    | { kind: "fixed"; geometry: ConstructionGeometry }
    | { kind: "face-point"; face: ConstructionRef; u: number; v: number };

/**
 * A construction definition over its numeric parameter type `N`: lengths (`distance`, `offset`, a
 * path `distance` position) and angles (`angle`) are stored as a `ParameterValue` — a number or an
 * expression of the document's variables, like a feature's `depth` — and resolved to plain numbers
 * before evaluation. Counts, solution indices and normalized path positions stay numbers.
 */
export type ConstructionDefinitionOf<N> =
    | { kind: "plane-offset"; source: ConstructionRef; distance: N; toPoint?: ConstructionRef }
    | { kind: "plane-midplane"; first: ConstructionRef; second: ConstructionRef; solution?: 0 | 1 }
    | {
          kind: "plane-angle";
          axis: ConstructionRef;
          baseline: ConstructionRef;
          angle: N;
          offset?: N;
      }
    | { kind: "plane-two-edges"; first: ConstructionRef; second: ConstructionRef; offset?: N }
    | {
          kind: "plane-three-points";
          first: ConstructionRef;
          second: ConstructionRef;
          third: ConstructionRef;
          offset?: N;
      }
    | { kind: "plane-along-path"; path: ConstructionRef; position: PathPositionOf<N>; offset?: N }
    | { kind: "plane-tangent"; face: ConstructionRef; contact: ConstructionRef; offset?: N }
    | {
          kind: "plane-perpendicular";
          source: ConstructionRef;
          contact: ConstructionRef;
          orientation: ConstructionRef;
          distance?: N;
      }
    | { kind: "axis-analytic"; face: ConstructionRef }
    | { kind: "axis-normal"; source: ConstructionRef; contact: ConstructionRef }
    | { kind: "axis-two-planes"; first: ConstructionRef; second: ConstructionRef }
    | { kind: "axis-two-points"; first: ConstructionRef; second: ConstructionRef }
    | { kind: "axis-edge"; edge: ConstructionRef }
    | { kind: "point-vertex"; vertex: ConstructionRef }
    | { kind: "point-two-edges"; first: ConstructionRef; second: ConstructionRef; solution?: number }
    | { kind: "point-three-planes"; first: ConstructionRef; second: ConstructionRef; third: ConstructionRef }
    | { kind: "point-center"; source: ConstructionRef }
    | { kind: "point-edge-plane"; edge: ConstructionRef; plane: ConstructionRef }
    | { kind: "point-along-path"; path: ConstructionRef; position: PathPositionOf<N> }
    | {
          kind: "ucs";
          origin: ConstructionRef;
          first: ConstructionRef;
          second: ConstructionRef;
          firstAxis?: "X" | "Y" | "Z";
          secondAxis?: "X" | "Y" | "Z";
          reverseFirst?: boolean;
          reverseSecond?: boolean;
      };

/** A stored definition: its lengths and angles may be expressions. */
export type ConstructionDefinition = ConstructionDefinitionOf<ParameterValue>;
/** A definition whose lengths and angles are resolved against the variable scope. */
export type ResolvedConstructionDefinition = ConstructionDefinitionOf<number>;

export type PathPositionOf<N> =
    | { kind: "distance"; value: N }
    | { kind: "normalized"; value: number }
    | { kind: "to-point"; point: ConstructionRef };
export type PathPosition = PathPositionOf<ParameterValue>;

/** A resolver supplies exact, already world-transformed source geometry. */
export type ResolvedConstructionSource =
    | ConstructionGeometry
    | { kind: "curve"; curve: ICurve; start?: number; end?: number }
    | {
          kind: "path";
          segments: Array<{ curve: ICurve; start?: number; end?: number }>;
          reversed?: boolean;
          branch?: number;
      }
    | { kind: "face"; face: IFace; normalSign?: 1 | -1 }
    | { kind: "edge"; start: XYZ; end: XYZ; curve?: ICurve; edge?: IEdge }
    | { kind: "vertex"; point: XYZ };

export interface IConstructionResolver {
    resolve(ref: ConstructionRef): Result<ResolvedConstructionSource>;
    dispose?(): void;
}

export interface ConstructionPointLike {
    point: XYZLike;
}
