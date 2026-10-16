// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <TopoDS_Shape.hxx>
#include <cmath>

// Volume and area integration (issue #177). BRepGProp's default VolumeProperties and
// SurfaceProperties use a fixed Gauss order per face over its whole parameter range: on
// faces made from periodic B-spline outlines (a planar cap trimmed by one, a loft through
// them) that was 1-15% off, with no error estimate. The adaptive VolumeProperties(Eps) can
// still be 10% off on such a cap while reporting a 1e-16 error. Gauss-Kronrod integrated
// span by span converges to fine tessellations; analytic shapes cost the same.
namespace MassProperties {
constexpr double relativeEpsilon = 1e-7;

// Fills props and returns the estimated relative error of the volume, or -1 when the
// adaptive integration failed and the fixed-order fallback (no estimate) was used.
inline double volume(const TopoDS_Shape& shape, GProp_GProps& props)
{
    GProp_GProps adaptive;
    const double error = BRepGProp::VolumePropertiesGK(shape, adaptive, relativeEpsilon, false, true);
    if (error >= 0 && std::isfinite(error) && std::isfinite(adaptive.Mass())) {
        props = adaptive;
        return error;
    }
    props = GProp_GProps();
    BRepGProp::VolumeProperties(shape, props);
    return -1;
}

inline double volume(const TopoDS_Shape& shape)
{
    GProp_GProps props;
    volume(shape, props);
    return props.Mass();
}

// Same contract as volume() for surface area.
inline double area(const TopoDS_Shape& shape, GProp_GProps& props)
{
    GProp_GProps adaptive;
    const double error = BRepGProp::SurfaceProperties(shape, adaptive, relativeEpsilon);
    if (error >= 0 && std::isfinite(error) && std::isfinite(adaptive.Mass())) {
        props = adaptive;
        return error;
    }
    props = GProp_GProps();
    BRepGProp::SurfaceProperties(shape, props);
    return -1;
}
}
