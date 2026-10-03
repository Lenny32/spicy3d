// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepLib.hxx>
#include <BRepLib_CheckCurveOnSurface.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GeomFill_Generator.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <NCollection_IndexedMap.hxx>
#include <Precision.hxx>
#include <ShapeFix_Shell.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <algorithm>
#include <cmath>

namespace LoftThicken {
constexpr double tolerance = 1e-6;

// BuildCurve3d's default segment budget looks only at the surface's immediate type:
// an OffsetSurface gets 30 segments regardless of its B-spline basis' knot count. Rebuild
// its spatial boundary curves with a budget that accounts for the underlying knot spans.
// The supporting offset surface and its p-curves stay unchanged.
inline bool rebuildBoundaryCurves(const TopoDS_Face& face, int segments)
{
    const auto surface = BRep_Tool::Surface(face);
    if (surface.IsNull())
        return false;
    BRep_Builder builder;
    for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next()) {
        const TopoDS_Edge edge = TopoDS::Edge(edges.Current());
        double first, last;
        const auto pcurve = BRep_Tool::CurveOnSurface(edge, face, first, last);
        if (pcurve.IsNull() || !std::isfinite(first) || !std::isfinite(last) || last <= first)
            return false;
        BRepBuilderAPI_MakeEdge rebuilt(pcurve, surface, first, last);
        if (!rebuilt.IsDone()
            || !BRepLib::BuildCurve3d(rebuilt.Edge(), Precision::Confusion(), GeomAbs_C1, 14, segments))
            return false;
        double curveFirst, curveLast;
        auto curve = BRep_Tool::Curve(rebuilt.Edge(), curveFirst, curveLast);
        if (curve.IsNull())
            return false;
        curve = Handle(Geom_Curve)::DownCast(curve->Transformed(edge.Location().Transformation().Inverted()));
        builder.UpdateEdge(edge, curve, Precision::Confusion());
        builder.SameParameter(edge, true);
        // Check the actual error independently of the edge's inherited tolerance.
        BRepLib_CheckCurveOnSurface consistency(edge, face);
        consistency.Perform();
        if (!consistency.IsDone() || !std::isfinite(consistency.MaxDistance())
            || consistency.MaxDistance() > tolerance)
            return false;
    }
    return BRepCheck_Analyzer(face, true, false, true).IsValid();
}

// One bounded retry for a non-periodic, single-patch open B-spline skin. Refit neither
// the input nor its offset surface; rebuild the boundary curves and the connecting rims.
// Null leaves the caller's original offset diagnostic intact. More complex skins keep
// using the existing offset path rather than attempting unrestricted surface healing.
inline TopoDS_Shape recover(const TopoDS_Shape& input, double thickness)
{
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces, solids, edges;
    TopExp::MapShapes(input, TopAbs_FACE, faces);
    TopExp::MapShapes(input, TopAbs_SOLID, solids);
    TopExp::MapShapes(input, TopAbs_EDGE, edges);
    if (faces.Extent() != 1 || !solids.IsEmpty() || edges.IsEmpty() || edges.Extent() > 16)
        return { };
    const auto surface = Handle(Geom_BSplineSurface)::DownCast(BRep_Tool::Surface(TopoDS::Face(faces.FindKey(1))));
    if (surface.IsNull() || surface->IsUPeriodic() || surface->IsVPeriodic())
        return { };
    const int knots = surface->NbUKnots() + surface->NbVKnots();
    if (knots > 256)
        return { };
    const int segments = std::max(64, 4 * knots);
    BRepBuilderAPI_Copy copy(input, true, false);
    const TopoDS_Shape source = copy.Shape();
    BRepOffsetAPI_MakeOffsetShape offset;
    offset.PerformBySimple(source, thickness);
    if (!offset.IsDone() || offset.Shape().IsNull())
        return { };
    for (TopExp_Explorer offsetFaces(offset.Shape(), TopAbs_FACE); offsetFaces.More(); offsetFaces.Next())
        if (!rebuildBoundaryCurves(TopoDS::Face(offsetFaces.Current()), segments))
            return { };

    BRepBuilderAPI_Sewing sewing(tolerance);
    sewing.SetMaxTolerance(tolerance);
    sewing.Add(source);
    sewing.Add(offset.Shape());
    for (TopExp_Explorer boundaries(source, TopAbs_EDGE); boundaries.More(); boundaries.Next()) {
        const TopoDS_Edge edge = TopoDS::Edge(boundaries.Current());
        const auto generated = offset.Generated(edge);
        if (generated.Size() != 1 || generated.First().ShapeType() != TopAbs_EDGE)
            return { };
        double first, last, offsetFirst, offsetLast;
        const auto curve = BRep_Tool::Curve(edge, first, last);
        const auto offsetCurve = BRep_Tool::Curve(TopoDS::Edge(generated.First()), offsetFirst, offsetLast);
        if (curve.IsNull() || offsetCurve.IsNull())
            return { };
        GeomFill_Generator rim;
        rim.AddCurve(new Geom_TrimmedCurve(curve, first, last));
        rim.AddCurve(new Geom_TrimmedCurve(offsetCurve, offsetFirst, offsetLast));
        // Union the full knot layouts, including nearby distinct knots. The profiler's
        // tolerance-based fallback can otherwise average knots and move the boundary.
        rim.Perform(0);
        BRepBuilderAPI_MakeFace makeFace(rim.Surface(), Precision::Confusion());
        if (!makeFace.IsDone())
            return { };
        sewing.Add(makeFace.Face());
    }
    sewing.Perform();
    const TopoDS_Shape sewn = sewing.SewedShape();
    if (sewn.IsNull() || sewn.ShapeType() != TopAbs_SHELL || sewing.NbFreeEdges() != 0)
        return { };
    ShapeFix_Shell orient(TopoDS::Shell(sewn));
    orient.FixFaceOrientation(TopoDS::Shell(sewn));
    if (orient.NbShells() != 1)
        return { };
    BRepBuilderAPI_MakeSolid solid(orient.Shell());
    if (!solid.IsDone())
        return { };
    TopoDS_Solid result = solid.Solid();
    if (!BRepLib::OrientClosedSolid(result) || !BRepCheck_Analyzer(result, true, false, true).IsValid())
        return { };
    return result;
}
}
