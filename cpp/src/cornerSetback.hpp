// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <Adaptor3d_CurveOnSurface.hxx>
#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Curve2d.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepFill_CurveConstraint.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomLProp_SLProps.hxx>
#include <GeomPlate_BuildPlateSurface.hxx>
#include <GeomPlate_MakeApprox.hxx>
#include <GeomPlate_PlateG1Criterion.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <NCollection_IndexedMap.hxx>
#include <ShapeFix_Edge.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <vector>

struct CornerSetbackResult {
    TopoDS_Shape shape;
    bool isOk = false;
    std::string error;
    double g0Error = 0;
    double g1Error = 0;
    double fitDistanceError = 0;
    double fitAngleError = 0;
    int boundaryCount = 0;
    int patchCount = 0;
    std::vector<int> faceMap;
    std::vector<int> edgeMap;
    std::vector<int> faceEdgeMap;
    std::vector<int> faceAncestors;
    std::vector<int> edgeAncestors;
    std::vector<int> cornerFaces;
};

namespace CornerSetback {
constexpr double distanceTolerance = 1e-4;
constexpr double angularTolerance = 1e-3;

static bool finitePoint(const gp_Pnt& point)
{
    return std::isfinite(point.X()) && std::isfinite(point.Y()) && std::isfinite(point.Z());
}

static bool finiteVector(const gp_Vec& vector)
{
    return std::isfinite(vector.X()) && std::isfinite(vector.Y()) && std::isfinite(vector.Z())
        && std::isfinite(vector.Magnitude());
}

// Geometry histories remain in the kernel realm. Each stage composes actual identity,
// Modified and Generated relations, including cross-kind derivations (edge -> rolling face
// -> cut section). No proximity matcher guesses where a trimmed sub-shape came from.
struct Origin {
    TopoDS_Shape shape;
    std::vector<int> faces;
    std::vector<int> edges;
    bool corner = false;
};
using History = std::vector<Origin>;

static void mergeIndexes(std::vector<int>& target, const std::vector<int>& source)
{
    for (const int index : source)
        if (std::find(target.begin(), target.end(), index) == target.end())
            target.push_back(index);
    std::sort(target.begin(), target.end());
}

static void addOrigin(History& history, const TopoDS_Shape& shape, const Origin& source)
{
    if (shape.ShapeType() != TopAbs_FACE && shape.ShapeType() != TopAbs_EDGE)
        return;
    auto found = std::find_if(history.begin(), history.end(), [&](const Origin& value) { return value.shape.IsSame(shape); });
    if (found == history.end()) {
        history.push_back({ shape, source.faces, source.edges, source.corner });
        return;
    }
    mergeIndexes(found->faces, source.faces);
    mergeIndexes(found->edges, source.edges);
    found->corner = found->corner || source.corner;
}

static History inputHistory(const TopoDS_Shape& shape)
{
    History history;
    for (const auto type : { TopAbs_FACE, TopAbs_EDGE }) {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> shapes;
        TopExp::MapShapes(shape, type, shapes);
        for (int i = 1; i <= shapes.Extent(); ++i)
            history.push_back({ shapes.FindKey(i), type == TopAbs_FACE ? std::vector<int> { i - 1 } : std::vector<int> { },
                type == TopAbs_EDGE ? std::vector<int> { i - 1 } : std::vector<int> { }, false });
    }
    return history;
}

static History derivedHistory(BRepBuilderAPI_MakeShape& operation, const History& input, const TopoDS_Shape& output)
{
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> outputs;
    TopExp::MapShapes(output, outputs);
    History result;
    for (const auto& source : input) {
        if (outputs.Contains(source.shape))
            addOrigin(result, source.shape, source);
        const auto append = [&](const NCollection_List<TopoDS_Shape>& values) {
            for (const auto& value : values) {
                if (value.ShapeType() == TopAbs_FACE || value.ShapeType() == TopAbs_EDGE) {
                    if (outputs.Contains(value))
                        addOrigin(result, value, source);
                    continue;
                }
                // Some builders return a compound of derived sub-shapes rather than a leaf.
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> derived;
                TopExp::MapShapes(value, derived);
                for (int i = 1; i <= derived.Extent(); ++i)
                    if (outputs.Contains(derived.FindKey(i)))
                        addOrigin(result, derived.FindKey(i), source);
            }
        };
        append(operation.Modified(source.shape));
        append(operation.Generated(source.shape));
    }
    return result;
}

static void appendHistory(History& target, const History& source)
{
    for (const auto& origin : source)
        addOrigin(target, origin.shape, origin);
}

static void exportHistory(const TopoDS_Shape& shape, const History& history, CornerSetbackResult& result)
{
    for (const auto type : { TopAbs_FACE, TopAbs_EDGE }) {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> outputs;
        TopExp::MapShapes(shape, type, outputs);
        auto& map = type == TopAbs_FACE ? result.faceMap : result.edgeMap;
        auto& pairs = type == TopAbs_FACE ? result.faceAncestors : result.edgeAncestors;
        map.assign(outputs.Extent(), -1);
        if (type == TopAbs_FACE)
            result.faceEdgeMap.assign(outputs.Extent(), -1);
        for (int i = 1; i <= outputs.Extent(); ++i) {
            const auto found = std::find_if(history.begin(), history.end(), [&](const Origin& origin) { return origin.shape.IsSame(outputs.FindKey(i)); });
            if (found == history.end())
                continue;
            const auto& ancestors = type == TopAbs_FACE ? found->faces : found->edges;
            for (const int ancestor : ancestors) {
                if (map[i - 1] < 0)
                    map[i - 1] = ancestor;
                pairs.push_back(i - 1);
                pairs.push_back(ancestor);
            }
            if (type == TopAbs_FACE) {
                if (!found->edges.empty())
                    result.faceEdgeMap[i - 1] = found->edges[0];
                if (found->corner)
                    result.cornerFaces.push_back(i - 1);
            }
        }
    }
}

static CornerSetbackResult failure(const std::string& error)
{
    CornerSetbackResult result;
    result.error = "Corner setback: " + error;
    return result;
}

static std::string checkStatusName(BRepCheck_Status status)
{
    switch (status) {
    case BRepCheck_InvalidSameParameterFlag:
        return "InvalidSameParameterFlag";
    case BRepCheck_InvalidSameRangeFlag:
        return "InvalidSameRangeFlag";
    case BRepCheck_InvalidCurveOnSurface:
        return "InvalidCurveOnSurface";
    case BRepCheck_InvalidPointOnCurveOnSurface:
        return "InvalidPointOnCurveOnSurface";
    case BRepCheck_InvalidPointOnSurface:
        return "InvalidPointOnSurface";
    case BRepCheck_InvalidWire:
        return "InvalidWire";
    case BRepCheck_UnorientableShape:
        return "UnorientableShape";
    case BRepCheck_BadOrientationOfSubshape:
        return "BadOrientationOfSubshape";
    case BRepCheck_NotClosed:
        return "NotClosed";
    default:
        return "status-" + std::to_string(static_cast<int>(status));
    }
}

// Keep stage failures inspectable: edge parameter errors are often attached to the face context,
// and a face's own status can be NoError while one of its contextual edges is invalid.
static std::string validityError(const TopoDS_Shape& shape)
{
    BRepCheck_Analyzer analyzer(shape);
    if (analyzer.IsValid())
        return "";
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> subshapes;
    TopExp::MapShapes(shape, subshapes);
    std::string details;
    for (int i = 1; i <= subshapes.Extent() && details.size() < 500; ++i) {
        const auto& item = subshapes.FindKey(i);
        const auto& result = analyzer.Result(item);
        if (result.IsNull())
            continue;
        const auto append = [&](const NCollection_List<BRepCheck_Status>& statuses) {
            for (const auto status : statuses)
                if (status != BRepCheck_NoError)
                    details += " type=" + std::to_string(static_cast<int>(item.ShapeType())) + ":" + checkStatusName(status);
        };
        append(result->Status());
        for (result->InitContextIterator(); result->MoreShapeInContext(); result->NextShapeInContext())
            append(result->StatusOnShape());
    }
    return details.empty() ? "unspecified contextual topology failure" : details;
}

static Handle(Geom_Surface) basisSurface(const TopoDS_Face& face)
{
    Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
    Handle(Geom_RectangularTrimmedSurface) trimmed = Handle(Geom_RectangularTrimmedSurface)::DownCast(surface);
    while (!trimmed.IsNull()) {
        surface = trimmed->BasisSurface();
        trimmed = Handle(Geom_RectangularTrimmedSurface)::DownCast(surface);
    }
    return surface;
}

static bool oneFace(const TopoDS_Shape& shape, TopoDS_Face& face)
{
    int count = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        face = TopoDS::Face(explorer.Current());
        ++count;
    }
    return count == 1;
}

static bool clipFace(const TopoDS_Face& face, const gp_Pln& plane, TopoDS_Face& clipped, TopoDS_Edge& section,
    const History* source = nullptr, History* output = nullptr)
{
    BRepBuilderAPI_MakeFace boundary(plane);
    if (!boundary.IsDone())
        return false;
    const gp_Pnt keep = plane.Location().Translated(gp_Vec(plane.Axis().Direction()));
    BRepPrimAPI_MakeHalfSpace halfSpace(boundary.Face(), keep);
    BRepAlgoAPI_Common common(face, halfSpace.Solid());
    if (!common.IsDone() || !oneFace(common.Shape(), clipped))
        return false;
    // Identify the actual Boolean section by kernel history, not finite point samples on a plane.
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> members, sections;
    TopExp::MapShapes(clipped, TopAbs_EDGE, members);
    for (const auto& edge : common.SectionEdges()) {
        if (members.Contains(edge))
            sections.Add(edge);
        for (const auto& modified : common.Modified(edge))
            if (modified.ShapeType() == TopAbs_EDGE && members.Contains(modified))
                sections.Add(modified);
    }
    if (sections.Extent() != 1)
        return false;
    section = TopoDS::Edge(sections.FindKey(1));
    if (source != nullptr && output != nullptr)
        appendHistory(*output, derivedHistory(common, *source, clipped));
    return true;
}

struct Boundary {
    TopoDS_Edge edge;
    TopoDS_Face support;
};

static std::array<gp_Pnt, 2> ends(const TopoDS_Edge& edge)
{
    BRepAdaptor_Curve curve(edge);
    return { curve.Value(curve.FirstParameter()), curve.Value(curve.LastParameter()) };
}

static bool boundaryOrder(std::vector<Boundary>& boundary)
{
    boundary[0].edge.Orientation(TopAbs_FORWARD);
    const gp_Pnt first = ends(boundary[0].edge)[0];
    gp_Pnt last = ends(boundary[0].edge)[1];
    for (size_t i = 1; i < boundary.size(); ++i) {
        bool found = false;
        for (size_t j = i; j < boundary.size(); ++j) {
            const auto points = ends(boundary[j].edge);
            if (last.Distance(points[0]) <= distanceTolerance || last.Distance(points[1]) <= distanceTolerance) {
                const bool reverse = last.Distance(points[1]) <= distanceTolerance;
                std::swap(boundary[i], boundary[j]);
                boundary[i].edge.Orientation(reverse ? TopAbs_REVERSED : TopAbs_FORWARD);
                last = reverse ? points[0] : points[1];
                found = true;
                break;
            }
        }
        if (!found)
            return false;
    }
    return first.Distance(last) <= distanceTolerance;
}

// MakeFilling reports errors on its own discretisation. Check the resulting surface independently
// at 33 sites per supplied edge as well; incompatible constraints must never pass silently.
static bool verifyPatch(const TopoDS_Face& patch, const std::vector<Boundary>& boundary,
    double& maximumDistance, double& maximumAngle)
{
    const auto surface = BRep_Tool::Surface(patch);
    if (surface.IsNull() || !std::isfinite(maximumDistance) || maximumDistance < 0
        || !std::isfinite(maximumAngle) || maximumAngle < 0)
        return false;
    for (const auto& item : boundary) {
        BRepAdaptor_Curve curve(item.edge);
        const auto support = BRep_Tool::Surface(item.support);
        if (support.IsNull() || !std::isfinite(curve.FirstParameter()) || !std::isfinite(curve.LastParameter()))
            return false;
        for (int i = 0; i <= 32; ++i) {
            const gp_Pnt point = curve.Value(curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * i / 32);
            if (!finitePoint(point))
                return false;
            GeomAPI_ProjectPointOnSurf patchProjection(point, surface);
            GeomAPI_ProjectPointOnSurf supportProjection(point, support);
            if (patchProjection.NbPoints() == 0 || supportProjection.NbPoints() == 0)
                return false;
            const double distance = patchProjection.LowerDistance();
            const double supportDistance = supportProjection.LowerDistance();
            if (!std::isfinite(distance) || distance < 0 || !std::isfinite(supportDistance) || supportDistance < 0)
                return false;
            maximumDistance = std::max(maximumDistance, distance);
            double pu, pv, su, sv;
            patchProjection.LowerDistanceParameters(pu, pv);
            supportProjection.LowerDistanceParameters(su, sv);
            if (!std::isfinite(pu) || !std::isfinite(pv) || !std::isfinite(su) || !std::isfinite(sv))
                return false;
            GeomLProp_SLProps patchProperties(surface, pu, pv, 1, 1e-9);
            GeomLProp_SLProps supportProperties(support, su, sv, 1, 1e-9);
            if (!patchProperties.IsNormalDefined() || !supportProperties.IsNormalDefined())
                return false;
            const double dot = patchProperties.Normal().Dot(supportProperties.Normal());
            if (!std::isfinite(dot))
                return false;
            const double angle = std::acos(std::clamp(std::abs(dot), 0.0, 1.0));
            if (!std::isfinite(angle))
                return false;
            maximumAngle = std::max(maximumAngle, angle);
        }
    }
    return maximumDistance <= distanceTolerance && maximumAngle <= angularTolerance;
}

static std::string repairPatchParameters(const TopoDS_Face& patch, const std::vector<Boundary>& boundary)
{
    BRepLib::SameParameter(patch, distanceTolerance / 10, true);
    for (size_t i = 0; i < boundary.size(); ++i) {
        const auto& item = boundary[i];
        if (!std::isfinite(BRep_Tool::Tolerance(item.edge)) || BRep_Tool::Tolerance(item.edge) < 0 || BRep_Tool::Tolerance(item.edge) > distanceTolerance)
            return "boundary " + std::to_string(i) + " parameter repair exceeds the 0.0001 mm edge tolerance limit (actual="
                + std::to_string(BRep_Tool::Tolerance(item.edge)) + ")";
        for (TopExp_Explorer vertex(item.edge, TopAbs_VERTEX); vertex.More(); vertex.Next())
            if (!std::isfinite(BRep_Tool::Tolerance(TopoDS::Vertex(vertex.Current()))) || BRep_Tool::Tolerance(TopoDS::Vertex(vertex.Current())) < 0 || BRep_Tool::Tolerance(TopoDS::Vertex(vertex.Current())) > distanceTolerance)
                return "boundary parameter repair exceeds the 0.0001 mm vertex tolerance limit";
    }
    return "";
}

static CornerSetbackResult build(const TopoDS_Shape& input, const std::array<int, 3>& indexes,
    double radius, const std::array<double, 3>& distances, int maxSegments)
{
    if (input.IsNull() || input.ShapeType() != TopAbs_SOLID)
        return failure("requires a valid solid");
    if (!std::isfinite(radius) || radius <= 0)
        return failure("radius must be positive and finite");
    // Boolean trimming and sewing may update geometric tolerances. Keep the feature input's
    // geometry and display triangulations untouched even when the experimental patch fails.
    BRepBuilderAPI_Copy copy(input, true, false);
    if (!copy.IsDone())
        return failure("could not isolate the input geometry for corner reconstruction");
    const TopoDS_Shape shape = copy.Shape();
    if (!BRepCheck_Analyzer(shape).IsValid())
        return failure("requires a valid solid");
    const History copiedHistory = derivedHistory(copy, inputHistory(input), shape);
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edgeMap;
    TopExp::MapShapes(input, TopAbs_EDGE, edgeMap);
    std::array<TopoDS_Edge, 3> selected;
    for (int i = 0; i < 3; ++i) {
        if (indexes[i] < 0 || indexes[i] >= edgeMap.Extent())
            return failure("edge index is out of range");
        const TopoDS_Shape copiedEdge = copy.ModifiedShape(edgeMap.FindKey(indexes[i] + 1));
        if (copiedEdge.IsNull() || copiedEdge.ShapeType() != TopAbs_EDGE)
            return failure("selected edge has no unique copy ancestry");
        selected[i] = TopoDS::Edge(copiedEdge);
        for (int j = 0; j < i; ++j)
            if (selected[i].IsSame(selected[j]))
                return failure("three distinct incident edges are required");
    }
    TopoDS_Vertex commonVertex;
    int commonVertices = 0;
    for (TopExp_Explorer vertex(selected[0], TopAbs_VERTEX); vertex.More(); vertex.Next()) {
        bool common = true;
        for (int i = 1; i < 3; ++i) {
            bool found = false;
            for (TopExp_Explorer other(selected[i], TopAbs_VERTEX); other.More(); other.Next())
                found = found || vertex.Current().IsSame(other.Current());
            common = common && found;
        }
        if (common && (commonVertex.IsNull() || !commonVertex.IsSame(vertex.Current()))) {
            commonVertex = TopoDS::Vertex(vertex.Current());
            ++commonVertices;
        }
    }
    if (commonVertex.IsNull())
        return failure("the three edges do not share one corner vertex");
    if (commonVertices != 1)
        return failure("the selected edges share multiple vertices; the setback corner is ambiguous");
    const gp_Pnt corner = BRep_Tool::Pnt(commonVertex);
    if (!finitePoint(corner))
        return failure("corner coordinates must be finite");
    std::vector<TopoDS_Face> supports;
    for (TopExp_Explorer face(shape, TopAbs_FACE); face.More(); face.Next()) {
        int incident = 0;
        for (const auto& edge : selected) {
            for (TopExp_Explorer member(face.Current(), TopAbs_EDGE); member.More(); member.Next())
                if (edge.IsSame(member.Current()))
                    ++incident;
        }
        if (incident != 0) {
            if (incident != 2 || basisSurface(TopoDS::Face(face.Current())).IsNull())
                return failure("requires three geometric supports meeting pairwise at the selected edges");
            supports.push_back(TopoDS::Face(face.Current()));
        }
    }
    if (supports.size() != 3)
        return failure("requires a trihedral corner with three supporting faces");
    std::array<gp_Pln, 3> cuts;
    std::array<gp_Vec, 3> edgeDirections;
    for (int i = 0; i < 3; ++i) {
        const auto points = ends(selected[i]);
        BRepAdaptor_Curve curve(selected[i]);
        const bool start = corner.Distance(points[0]) < corner.Distance(points[1]);
        if (points[0].Distance(points[1]) <= distanceTolerance)
            return failure("closed or zero-length incident edges cannot define an away-from-corner setback");
        const double length = GCPnts_AbscissaPoint::Length(curve);
        if (!std::isfinite(length) || length <= distanceTolerance || !std::isfinite(distances[i]) || distances[i] <= radius + distanceTolerance || distances[i] >= length - distanceTolerance)
            return failure("each setback must exceed the radius and lie inside its selected edge");
        const double origin = start ? curve.FirstParameter() : curve.LastParameter();
        gp_Pnt initialPoint;
        curve.D1(origin, initialPoint, edgeDirections[i]);
        if (!start)
            edgeDirections[i].Reverse();
        if (!finitePoint(initialPoint) || !finiteVector(edgeDirections[i]) || edgeDirections[i].Magnitude() <= 1e-12)
            return failure("the selected edge has no regular tangent at the corner");
        edgeDirections[i].Normalize();
        GCPnts_AbscissaPoint pointAtDistance(distanceTolerance / 10, curve, start ? distances[i] : -distances[i], origin);
        if (!pointAtDistance.IsDone())
            return failure("could not resolve the setback arc length on its selected edge");
        if (!std::isfinite(pointAtDistance.Parameter()))
            return failure("resolved setback curve parameter must be finite");
        gp_Pnt point;
        gp_Vec tangent;
        curve.D1(pointAtDistance.Parameter(), point, tangent);
        if (!start)
            tangent.Reverse();
        if (!finitePoint(point) || !finiteVector(tangent) || tangent.Magnitude() <= 1e-12)
            return failure("the selected edge has no regular tangent at its setback");
        cuts[i] = gp_Pln(point, gp_Dir(tangent));
    }
    BRepFilletAPI_MakeFillet fillet(shape);
    for (const auto& edge : selected)
        fillet.Add(radius, edge);
    fillet.Build();
    if (!fillet.IsDone() || !BRepCheck_Analyzer(fillet.Shape()).IsValid())
        return failure("base rolling fillets failed or produced invalid geometry");
    const History filletHistory = derivedHistory(fillet, copiedHistory, fillet.Shape());
    History reconstructionHistory;
    std::vector<TopoDS_Face> replaced;
    std::vector<TopoDS_Face> retained;
    std::vector<Boundary> boundary;
    for (int i = 0; i < 3; ++i) {
        const auto& generated = fillet.Generated(selected[i]);
        TopoDS_Face strip;
        int count = 0;
        for (const auto& item : generated)
            if (item.ShapeType() == TopAbs_FACE) {
                strip = TopoDS::Face(item);
                ++count;
            }
        if (count != 1)
            return failure("could not identify one rolling strip per selected edge");
        TopoDS_Face clipped;
        TopoDS_Edge section;
        if (!clipFace(strip, cuts[i], clipped, section, &filletHistory, &reconstructionHistory))
            return failure("could not trim a rolling strip at its setback cross-section");
        replaced.push_back(strip);
        retained.push_back(clipped);
        boundary.push_back({ section, clipped });
    }
    for (const auto& original : supports) {
        const auto surface = BRep_Tool::Surface(original);
        std::vector<gp_Pnt> junctions;
        for (int i = 0; i < 3; ++i)
            for (const auto& point : ends(boundary[i].edge))
                if (GeomAPI_ProjectPointOnSurf projection(point, surface);
                    projection.NbPoints() != 0 && projection.LowerDistance() <= distanceTolerance)
                    junctions.push_back(point);
        if (junctions.size() != 2 || junctions[0].Distance(junctions[1]) <= distanceTolerance)
            return failure("could not locate two strip-section ends on a support");
        gp_Vec averageNormal;
        for (const auto& point : junctions) {
            GeomAPI_ProjectPointOnSurf projection(point, surface);
            double u, v;
            projection.LowerDistanceParameters(u, v);
            GeomLProp_SLProps properties(surface, u, v, 1, 1e-9);
            if (!properties.IsNormalDefined())
                return failure("a support has a singular normal at its setback junction");
            averageNormal += gp_Vec(properties.Normal());
        }
        gp_Vec normal = averageNormal.Crossed(gp_Vec(junctions[0], junctions[1]));
        if (!finiteVector(normal) || normal.Magnitude() <= 1e-12)
            return failure("support geometry cannot define a regular setback connector plane");
        if (normal.Dot(gp_Vec(junctions[0], corner)) > 0)
            normal.Reverse();
        const gp_Pln cut(junctions[0], gp_Dir(normal));
        const auto& modified = fillet.Modified(original);
        TopoDS_Face face;
        int count = 0;
        for (const auto& item : modified)
            if (item.ShapeType() == TopAbs_FACE) {
                face = TopoDS::Face(item);
                ++count;
            }
        if (count != 1)
            return failure("could not identify one retained support");
        TopoDS_Face clipped;
        TopoDS_Edge connector;
        if (!clipFace(face, cut, clipped, connector, &filletHistory, &reconstructionHistory))
            return failure("could not trim a support between setback sections");
        replaced.push_back(face);
        retained.push_back(clipped);
        boundary.push_back({ connector, clipped });
    }
    std::vector<TopoDS_Face> originalCaps;
    for (const auto& item : fillet.Generated(commonVertex))
        if (item.ShapeType() == TopAbs_FACE) {
            replaced.push_back(TopoDS::Face(item));
            originalCaps.push_back(TopoDS::Face(item));
        }
    if (originalCaps.size() != 1)
        return failure("requires one unambiguous original corner cap");
    if (!boundaryOrder(boundary))
        return failure("setback sections and support connectors do not form one closed boundary");
    std::vector<TopoDS_Face> patches;
    double maximumDistance = 0;
    double maximumAngle = 0;
    GeomPlate_BuildPlateSurface plate(3, 50, 5, 1e-6, distanceTolerance / 20, angularTolerance / 20, 0.1);
    for (const auto& item : boundary) {
        occ::handle<BRepAdaptor_Surface> support = new BRepAdaptor_Surface(item.support);
        occ::handle<BRepAdaptor_Curve2d> pcurve = new BRepAdaptor_Curve2d(item.edge, item.support);
        occ::handle<Adaptor3d_CurveOnSurface> curve = new Adaptor3d_CurveOnSurface(pcurve, support);
        plate.Add(new BRepFill_CurveConstraint(curve, GeomAbs_G1, 50, distanceTolerance / 20, angularTolerance / 20, 0.1));
    }
    plate.SetNbBounds(static_cast<int>(boundary.size()));
    plate.Perform();
    if (!plate.IsDone())
        return failure("constrained corner patch construction failed");
    NCollection_Sequence<gp_XY> sites;
    NCollection_Sequence<gp_XYZ> normals;
    plate.Disc2dContour(16, sites);
    plate.Disc3dContour(16, 1, normals);
    GeomPlate_PlateG1Criterion criterion(sites, normals, angularTolerance / 4);
    GeomPlate_MakeApprox approximation(plate.Surface(), criterion, distanceTolerance / 20, maxSegments, 14);
    const auto surface = approximation.Surface();
    if (surface.IsNull())
        return failure("G1-aware corner approximation did not produce a surface");
    const double fitDistanceError = approximation.ApproxError();
    const double fitAngleError = approximation.CriterionError();
    if (!std::isfinite(fitDistanceError) || fitDistanceError < 0
        || !std::isfinite(fitAngleError) || fitAngleError < 0)
        return failure("corner approximation returned invalid fit metrics");
    BRepBuilderAPI_MakeFace supportFace(surface, distanceTolerance / 10);
    if (!supportFace.IsDone())
        return failure("could not construct the approximated corner support");
    ShapeFix_Edge edgeFix;
    BRepBuilderAPI_MakeWire wire;
    for (const auto& item : boundary) {
        edgeFix.FixAddPCurve(item.edge, supportFace.Face(), false, distanceTolerance / 10);
        wire.Add(item.edge);
    }
    if (!wire.IsDone())
        return failure("could not construct the exact corner boundary wire");
    BRepBuilderAPI_MakeFace patchBuilder(surface, wire.Wire(), true);
    if (!patchBuilder.IsDone())
        return failure("could not trim the G1-aware corner surface");
    const auto patch = patchBuilder.Face();
    // Projected p-curves must share the 3D edge's parameterization before they become a valid BREP.
    // OCCT MakeFilling performs this same step after building its approximated surface.
    const auto repairError = repairPatchParameters(patch, boundary);
    if (!repairError.empty())
        return failure(repairError);
    maximumDistance = plate.G0Error();
    maximumAngle = plate.G1Error();
    if (!verifyPatch(patch, boundary, maximumDistance, maximumAngle))
        return failure("corner patch violates G0/G1 constraints (distance=" + std::to_string(maximumDistance)
            + ", angle=" + std::to_string(maximumAngle)
            + ", plate-distance=" + std::to_string(plate.G0Error())
            + ", plate-angle=" + std::to_string(plate.G1Error())
            + ", approximation-distance=" + std::to_string(approximation.ApproxError())
            + ", approximation-angle=" + std::to_string(approximation.CriterionError()) + ")");
    // Report the independent CAD joins even when the OCCT approximation metric rejects the fit.
    // These checks remain separate: passing boundary samples does not waive either fit limit.
    if (fitDistanceError > distanceTolerance || fitAngleError > angularTolerance)
        return failure("corner approximation violates fit limits (boundary-distance=" + std::to_string(maximumDistance)
            + ", boundary-angle=" + std::to_string(maximumAngle)
            + ", approximation-distance=" + std::to_string(fitDistanceError)
            + ", approximation-angle=" + std::to_string(fitAngleError) + ")");
    const auto patchError = validityError(patch);
    if (!patchError.empty())
        return failure("corner patch BREP is invalid:" + patchError);
    patches.push_back(patch);
    BRepBuilderAPI_Sewing sewing(distanceTolerance);
    for (TopExp_Explorer face(fillet.Shape(), TopAbs_FACE); face.More(); face.Next()) {
        bool replace = false;
        for (const auto& item : replaced)
            replace = replace || face.Current().IsSame(item);
        if (!replace) {
            sewing.Add(face.Current());
            NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> members;
            TopExp::MapShapes(face.Current(), members);
            for (const auto& origin : filletHistory)
                if (members.Contains(origin.shape))
                    addOrigin(reconstructionHistory, origin.shape, origin);
        }
    }
    for (const auto& face : retained)
        sewing.Add(face);
    for (const auto& patch : patches) {
        sewing.Add(patch);
        Origin origin { patch, { }, { }, true };
        for (const auto& item : boundary) {
            const auto found = std::find_if(reconstructionHistory.begin(), reconstructionHistory.end(), [&](const Origin& source) { return source.shape.IsSame(item.support); });
            if (found != reconstructionHistory.end()) {
                mergeIndexes(origin.faces, found->faces);
                mergeIndexes(origin.edges, found->edges);
            }
        }
        if (origin.faces.size() != 3 || origin.edges.size() != 3)
            return failure("corner boundary derivation history is incomplete or ambiguous");
        addOrigin(reconstructionHistory, patch, origin);
    }
    sewing.Perform();
    if (sewing.NbFreeEdges() != 0 || sewing.SewedShape().ShapeType() != TopAbs_SHELL)
        return failure("replacement corner does not close a single shell");
    BRepBuilderAPI_MakeSolid solid(TopoDS::Shell(sewing.SewedShape()));
    if (!solid.IsDone())
        return failure("could not construct the setback solid");
    auto output = solid.Solid();
    if (!BRepLib::OrientClosedSolid(output))
        return failure("the replacement shell cannot be oriented as a closed solid");
    const auto outputError = validityError(output);
    if (!outputError.empty())
        return failure("the final setback BREP is invalid:" + outputError);
    BOPAlgo_ArgumentAnalyzer selfInterference;
    selfInterference.SetShape1(output);
    selfInterference.SelfInterMode() = true;
    selfInterference.StopOnFirstFaulty() = true;
    selfInterference.Perform();
    if (selfInterference.HasFaulty())
        return failure("the final setback solid fails the self-interference check");
    GProp_GProps before, after;
    BRepGProp::VolumeProperties(shape, before);
    BRepGProp::VolumeProperties(output, after);
    if (!std::isfinite(before.Mass()) || !std::isfinite(after.Mass()) || !(after.Mass() > 0 && after.Mass() < before.Mass()))
        return failure("the corner patch does not define an inward rounded solid");
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> outputShapes;
    TopExp::MapShapes(output, outputShapes);
    History finalHistory;
    for (const auto& source : reconstructionHistory) {
        if (outputShapes.Contains(source.shape))
            addOrigin(finalHistory, source.shape, source);
        if (sewing.IsModified(source.shape)) {
            const auto& derived = sewing.Modified(source.shape);
            if (!derived.IsNull() && outputShapes.Contains(derived))
                addOrigin(finalHistory, derived, source);
        }
        if (sewing.IsModifiedSubShape(source.shape)) {
            const auto derived = sewing.ModifiedSubShape(source.shape);
            if (!derived.IsNull() && outputShapes.Contains(derived))
                addOrigin(finalHistory, derived, source);
        }
    }
    CornerSetbackResult result;
    result.shape = output;
    result.isOk = true;
    result.g0Error = maximumDistance;
    result.g1Error = maximumAngle;
    result.fitDistanceError = fitDistanceError;
    result.fitAngleError = fitAngleError;
    result.boundaryCount = static_cast<int>(boundary.size());
    result.patchCount = static_cast<int>(patches.size());
    exportHistory(output, finalHistory, result);
    if (result.cornerFaces.size() != patches.size())
        return failure("sewing lost the corner patch derivation history");
    return result;
}
}
