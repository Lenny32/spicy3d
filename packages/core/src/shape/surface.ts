// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Plane, XYZ } from "../math";
import type { Continuity, ICurve } from "./curve";
import type { IGeometry } from "./geometry";

export type SurfaceType =
    | "plate"
    | "bezier"
    | "bspline"
    | "rectangularTrimmed"
    | "conical"
    | "cylinder"
    | "plane"
    | "spherical"
    | "toroidal"
    | "revolution"
    | "extrusion"
    | "offset"
    | "composite";

export interface ISurface extends IGeometry {
    nearestPoint(point: XYZ): [XYZ, number] | undefined;
    project(point: XYZ): XYZ[];
    projectCurve(curve: ICurve): ICurve | undefined;
    /** @unit length maxDistance */
    parameter(point: XYZ, maxDistance: number): { u: number; v: number } | undefined;
    continuity(): Continuity;
    /** @unit none u */
    uIso(u: number): ICurve;
    /** @unit none v */
    vIso(v: number): ICurve;
    isPlanar(): boolean;
    /** Exact GeomAdaptor analytic surface class, when available in the kernel. */
    isAnalytic?(): boolean;
    isUClosed(): boolean;
    isVClosed(): boolean;
    isUPeriodic(): boolean;
    isVPeriodic(): boolean;
    vPeriod(): number;
    uPeriod(): number;
    bounds(): {
        u1: number;
        u2: number;
        v1: number;
        v2: number;
    };
    /** @unit none n */
    isCNu(n: number): boolean;
    /** @unit none n */
    isCNv(n: number): boolean;
    /** @unit none u v */
    d0(u: number, v: number): XYZ;
    /** @unit none u v */
    d1(
        u: number,
        v: number,
    ): {
        point: XYZ;
        d1u: XYZ;
        d1v: XYZ;
    };
    /** @unit none u v */
    d2(
        u: number,
        v: number,
    ): {
        point: XYZ;
        d1u: XYZ;
        d1v: XYZ;
        d2u: XYZ;
        d2v: XYZ;
        d2uv: XYZ;
    };
    /** @unit none u v */
    d3(
        u: number,
        v: number,
    ): {
        point: XYZ;
        d1u: XYZ;
        d1v: XYZ;
        d2u: XYZ;
        d2v: XYZ;
        d2uv: XYZ;
        d3u: XYZ;
        d3v: XYZ;
        d3uuv: XYZ;
        d3uvv: XYZ;
    };
    /** @unit none u v nu nv */
    dn(u: number, v: number, nu: number, nv: number): XYZ;
    /** @unit none u v */
    value(u: number, v: number): XYZ;
}

export interface IPlateSurface extends ISurface {
    /** @unit none u1 u2 v1 v2 */
    setBounds(u1: number, u2: number, v1: number, v2: number): void;
}

export interface IBoundedSurface extends ISurface {}

export interface IElementarySurface extends ISurface {
    axis: XYZ;
    coordinates: Plane;
    location: XYZ;
}

export interface IOffsetSurface extends ISurface {
    offset: number;
    basisSurface: ISurface;
}

export interface ISweptSurface extends ISurface {
    direction(): XYZ;
    basisCurve(): ICurve;
}

export interface ICompositeSurface extends ISurface {}

export interface IBSplineSurface extends IBoundedSurface {}

export interface IBezierSurface extends IBoundedSurface {}

export interface IRectangularTrimmedSurface extends IBoundedSurface {
    basisSurface(): ISurface;
    /** @unit none u1 u2 */
    setUTrim(u1: number, u2: number): void;
    /** @unit none v1 v2 */
    setVTrim(v1: number, v2: number): void;
    /** @unit none u1 u2 v1 v2 */
    setTrim(u1: number, u2: number, v1: number, v2: number): void;
}

export interface IConicalSurface extends IElementarySurface {
    semiAngle: number;
    /** @unit length value */
    setRadius(value: number): void;
    apex(): XYZ;
    refRadius(): number;
}

export interface ICylindricalSurface extends IElementarySurface {
    radius: number;
}

export interface IPlaneSurface extends IElementarySurface {
    plane: Plane;
}

export interface ISphericalSurface extends IElementarySurface {
    radius: number;
    area(): number;
    volume(): number;
}

export interface IToroidalSurface extends IElementarySurface {
    area(): number;
    volume(): number;
    majorRadius: number;
    minorRadius: number;
}

export interface ISurfaceOfLinearExtrusion extends ISweptSurface {}

export interface ISurfaceOfRevolution extends ISweptSurface {
    location: XYZ;
    referencePlane(): Plane;
}
