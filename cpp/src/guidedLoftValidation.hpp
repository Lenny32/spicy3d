// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <BRepAdaptor_CompCurve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Tool.hxx>
#include <Extrema_ExtPC.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <cmath>
#include <string>
#include <vector>

namespace GuidedLoft {
constexpr double tolerance = 1e-5;

inline bool finitePoint(const gp_Pnt& point)
{
    return std::isfinite(point.X()) && std::isfinite(point.Y()) && std::isfinite(point.Z());
}

inline bool validCurveSpan(const BRepAdaptor_CompCurve& curve)
{
    const double epsilon = curve.Resolution(tolerance);
    const double length = GCPnts_AbscissaPoint::Length(curve);
    return std::isfinite(curve.FirstParameter()) && std::isfinite(curve.LastParameter())
        && curve.LastParameter() > curve.FirstParameter() && std::isfinite(epsilon) && epsilon > 0
        && std::isfinite(length) && length > tolerance
        && finitePoint(curve.Value(curve.FirstParameter())) && finitePoint(curve.Value(curve.LastParameter()));
}

inline std::string planeStation(const TopoDS_Wire& wire, const gp_Pln& plane,
    const BRepAdaptor_CompCurve& curve, gp_Pnt& point, double& parameter)
{
    BRepAlgoAPI_Section intersection(wire, plane, false);
    intersection.Build();
    if (!intersection.IsDone())
        return "Guided loft path/section plane intersection failed";
    if (TopExp_Explorer(intersection.Shape(), TopAbs_EDGE).More())
        return "Guided loft path lies in a section plane";
    std::vector<gp_Pnt> points;
    for (TopExp_Explorer vertex(intersection.Shape(), TopAbs_VERTEX); vertex.More(); vertex.Next()) {
        const auto candidate = BRep_Tool::Pnt(TopoDS::Vertex(vertex.Current()));
        if (!finitePoint(candidate))
            return "Guided loft path station coordinates must be finite";
        bool duplicate = false;
        for (const auto& existing : points)
            duplicate |= existing.Distance(candidate) <= tolerance;
        if (!duplicate)
            points.push_back(candidate);
    }
    if (points.size() != 1)
        return "Guided loft path must intersect each section plane exactly once";
    point = points.front();
    Extrema_ExtPC projection(point, curve, curve.FirstParameter(), curve.LastParameter());
    if (!projection.IsDone())
        return "Guided loft path station could not be resolved";
    std::vector<double> parameters;
    const double parameterTolerance = curve.Resolution(tolerance);
    if (!std::isfinite(parameterTolerance) || parameterTolerance <= 0)
        return "Guided loft path parameter tolerance is invalid";
    auto add = [&](double value) {
        if (!std::isfinite(value))
            return;
        for (double existing : parameters)
            if (std::abs(existing - value) <= parameterTolerance)
                return;
        parameters.push_back(value);
    };
    if (curve.Value(curve.FirstParameter()).Distance(point) <= tolerance)
        add(curve.FirstParameter());
    if (curve.Value(curve.LastParameter()).Distance(point) <= tolerance)
        add(curve.LastParameter());
    for (int index = 1; index <= projection.NbExt(); index++)
        if (projection.SquareDistance(index) <= tolerance * tolerance)
            add(projection.Point(index).Parameter());
    if (parameters.size() != 1)
        return "Guided loft path station is missing or ambiguous";
    parameter = parameters.front();
    return "";
}

inline bool spansMonotonically(const std::vector<double>& stations, const BRepAdaptor_CompCurve& curve)
{
    const double epsilon = curve.Resolution(tolerance);
    const bool ascending = stations.back() > stations.front();
    if (std::abs(stations.front() - (ascending ? curve.FirstParameter() : curve.LastParameter())) > epsilon
        || std::abs(stations.back() - (ascending ? curve.LastParameter() : curve.FirstParameter())) > epsilon)
        return false;
    for (size_t index = 1; index < stations.size(); index++)
        if ((stations[index] - stations[index - 1]) * (ascending ? 1 : -1) <= epsilon)
            return false;
    return true;
}

inline std::string validate(const std::vector<TopoDS_Shape>& sections,
    const TopoDS_Wire& spine, const TopoDS_Wire& boundary)
{
    if (sections.size() < 2 || sections.size() > 16)
        return "Guided loft requires 2 to 16 sections";
    int totalSectionEdges = 0;
    for (const auto& section : sections) {
        if (section.IsNull())
            return "Guided loft section is missing";
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edges;
        TopExp::MapShapes(section, TopAbs_EDGE, edges);
        totalSectionEdges += edges.Extent();
        if (edges.Extent() > 512 || totalSectionEdges > 8192)
            return "Guided loft section edge inspection budget exceeded";
    }
    for (const auto& path : { spine, boundary }) {
        if (path.IsNull() || !BRepCheck_Analyzer(path).IsValid() || BRep_Tool::IsClosed(path))
            return "Guided loft paths must be valid open wires";
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edges;
        TopExp::MapShapes(path, TopAbs_EDGE, edges);
        if (edges.Extent() < 1 || edges.Extent() > 128)
            return "Guided loft paths require 1 to 128 edge pieces";
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> traversed;
        for (BRepTools_WireExplorer edge(path); edge.More(); edge.Next()) {
            if (traversed.Contains(edge.Current()))
                return "Guided loft paths must not repeat an edge";
            traversed.Add(edge.Current());
        }
        if (traversed.Extent() != edges.Extent())
            return "Guided loft paths must be connected and unbranched";
        BOPAlgo_ArgumentAnalyzer analyzer;
        analyzer.SetShape1(path);
        analyzer.SelfInterMode() = true;
        analyzer.StopOnFirstFaulty() = true;
        analyzer.Perform();
        if (analyzer.HasFaulty())
            return "Guided loft paths must not self-intersect";
    }
    const BRepAdaptor_CompCurve spineCurve(spine, true), boundaryCurve(boundary, true);
    if (!validCurveSpan(spineCurve) || !validCurveSpan(boundaryCurve))
        return "Guided loft paths must have finite nondegenerate spans";
    std::vector<double> spineStations, boundaryStations;
    for (const auto& section : sections) {
        if (section.IsNull() || section.ShapeType() != TopAbs_WIRE
            || !BRep_Tool::IsClosed(section) || !BRepCheck_Analyzer(section).IsValid())
            return "Guided loft sections must be valid closed planar wires";
        BRepBuilderAPI_MakeFace makeFace(TopoDS::Wire(section), true);
        if (!makeFace.IsDone())
            return "Guided loft sections must enclose one planar profile";
        const BRepAdaptor_Surface surface(makeFace.Face(), true);
        if (surface.GetType() != GeomAbs_Plane)
            return "Guided loft sections must be planar";
        double spineStation, boundaryStation;
        gp_Pnt spinePoint, boundaryPoint;
        auto error = planeStation(spine, surface.Plane(), spineCurve, spinePoint, spineStation);
        if (!error.empty())
            return "Spine: " + error;
        error = planeStation(boundary, surface.Plane(), boundaryCurve, boundaryPoint, boundaryStation);
        if (!error.empty())
            return "Boundary: " + error;
        if (spinePoint.Distance(boundaryPoint) <= tolerance)
            return "Guided loft boundary must be distinct from the main spine";
        const TopoDS_Vertex point = BRepBuilderAPI_MakeVertex(boundaryPoint).Vertex();
        BRepExtrema_DistShapeShape contact(point, section);
        if (!contact.IsDone() || !std::isfinite(contact.Value()) || contact.Value() > tolerance)
            return "Guided loft boundary must meet every section boundary";
        spineStations.push_back(spineStation);
        boundaryStations.push_back(boundaryStation);
    }
    if (!spansMonotonically(spineStations, spineCurve) || !spansMonotonically(boundaryStations, boundaryCurve))
        return "Guided loft paths must span the sections in one monotonic order";
    return "";
}
}
