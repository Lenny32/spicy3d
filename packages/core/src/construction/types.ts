// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation";
import type { Plane, XYZ, XYZLike } from "../math";
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

export type ConstructionDefinition =
    | { kind: "plane-offset"; source: ConstructionRef; distance: number; toPoint?: ConstructionRef }
    | { kind: "plane-midplane"; first: ConstructionRef; second: ConstructionRef; solution?: 0 | 1 }
    | {
          kind: "plane-angle";
          axis: ConstructionRef;
          baseline: ConstructionRef;
          angle: number;
          offset?: number;
      }
    | { kind: "plane-two-edges"; first: ConstructionRef; second: ConstructionRef; offset?: number }
    | {
          kind: "plane-three-points";
          first: ConstructionRef;
          second: ConstructionRef;
          third: ConstructionRef;
          offset?: number;
      }
    | { kind: "plane-along-path"; path: ConstructionRef; position: PathPosition; offset?: number }
    | { kind: "plane-tangent"; face: ConstructionRef; contact: ConstructionRef; offset?: number }
    | {
          kind: "plane-perpendicular";
          source: ConstructionRef;
          contact: ConstructionRef;
          orientation: ConstructionRef;
          distance?: number;
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
    | { kind: "point-along-path"; path: ConstructionRef; position: PathPosition }
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

export type PathPosition =
    | { kind: "distance"; value: number }
    | { kind: "normalized"; value: number }
    | { kind: "to-point"; point: ConstructionRef };

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
