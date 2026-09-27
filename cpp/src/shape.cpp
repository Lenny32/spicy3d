// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepExtrema_ExtCC.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepOffsetAPI_MakeOffset.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <BRepPrim_Builder.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_OBB.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GProp_GProps.hxx>
#include <GeomAbs_JoinType.hxx>
#include <Geom_OffsetCurve.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <HLRAlgo_Projector.hxx>
#include <HLRBRep_Algo.hxx>
#include <HLRBRep_HLRToShape.hxx>
#include <IntCurvesFace_Intersector.hxx>
#include <ShapeAnalysis.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_CompSolid.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax3.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include "shared.hpp"
#include "utils.hpp"
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Wire.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <ShapeAnalysis_Edge.hxx>
#include <ShapeFix_ShapeTolerance.hxx>
#include <ShapeUpgrade_ShellSewing.hxx>

using namespace emscripten;

struct InspectionDistance {
    double distance;
    Vector3 first;
    Vector3 second;
};

struct InspectionMass {
    double volume;
    Vector3 center;
};

struct InspectionUVBounds {
    double u1;
    double u2;
    double v1;
    double v2;
};

struct InspectionRayResult {
    bool valid;
    bool hasHit;
    Vector3 point;
};

class Shape {
    static bool containsOnlySolids(const TopoDS_Shape& shape)
    {
        if (shape.IsNull())
            return false;
        if (shape.ShapeType() == TopAbs_SOLID)
            return true;
        if (shape.ShapeType() != TopAbs_COMPOUND && shape.ShapeType() != TopAbs_COMPSOLID)
            return false;
        bool hasChild = false;
        for (TopoDS_Iterator child(shape); child.More(); child.Next()) {
            hasChild = true;
            if (!containsOnlySolids(child.Value()))
                return false;
        }
        return hasChild;
    }

public:
    static size_t ptr(const TopoDS_Shape& shape)
    {
        return size_t(shape.TShape().get());
    }

    static BoundingBox boundingBox(const TopoDS_Shape& shape, bool useTriangulation)
    {
        Bnd_Box obx;
        BRepBndLib::Add(shape, obx, useTriangulation);
        // A shape without geometry (e.g. an empty compound) leaves a void box, whose corners raise.
        if (obx.IsVoid()) {
            return BoundingBox { Vector3 { 0.0, 0.0, 0.0 }, Vector3 { 0.0, 0.0, 0.0 } };
        }

        return BoundingBox {
            Vector3::fromPnt(obx.CornerMin()),
            Vector3::fromPnt(obx.CornerMax())
        };
    }

    static OrientedBoundingBox orientedBoundingBox(const TopoDS_Shape& shape, bool useTriangulation)
    {
        Bnd_OBB obb;
        BRepBndLib::AddOBB(shape, obb, useTriangulation);
        // A shape without geometry leaves a void OBB with undefined axes.
        if (obb.IsVoid()) {
            return OrientedBoundingBox { Ax3::fromAx3(gp_Ax3()), Vector3 { 0.0, 0.0, 0.0 } };
        }

        return OrientedBoundingBox {
            Ax3::fromAx3(obb.Position()),
            Vector3 { obb.XHSize(), obb.YHSize(), obb.ZHSize() }
        };
    }

    static TopoDS_Shape clone(const TopoDS_Shape& shape)
    {
        BRepBuilderAPI_Copy copy(shape);
        return copy.Shape();
    }

    static TopoDS_Shape transformed(const TopoDS_Shape& shape, const gp_Trsf& trsf)
    {
        BRepBuilderAPI_Transform transform(trsf);
        transform.Perform(shape, true);
        return transform.Shape();
    }

    static void clean(TopoDS_Shape& shape)
    {
        BRepTools::Clean(shape, true);
    }

    static bool isClosed(const TopoDS_Shape& shape)
    {
        return BRep_Tool::IsClosed(shape);
    }

    static ShapeArray findAncestor(const TopoDS_Shape& from, const TopoDS_Shape& subShape,
        const TopAbs_ShapeEnum& ancestorType)
    {
        NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher> map;
        TopExp::MapShapesAndAncestors(from, subShape.ShapeType(), ancestorType, map);
        auto index = map.FindIndex(subShape);
        if (index < 1) {
            return ShapeArray(val::array());
        }
        auto shapes = map.FindFromIndex(index);

        return ShapeArray(val::array(shapes.begin(), shapes.end()));
    }

    static ShapeArray findSubShapes(const TopoDS_Shape& shape, const TopAbs_ShapeEnum& shapeType)
    {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> indexShape;
        TopExp::MapShapes(shape, shapeType, indexShape);

        return ShapeArray(val::array(indexShape.cbegin(), indexShape.cend()));
    }

    static ShapeArray getDirectSubShapes(const TopoDS_Shape& shape)
    {
        val subShapes = val::array();
        for (TopoDS_Iterator iter(shape); iter.More(); iter.Next()) {
            subShapes.call<void>("push", iter.Value());
        }
        return ShapeArray(subShapes);
    }

    static TopoDS_Shape sectionSS(const TopoDS_Shape& shape, const TopoDS_Shape& otherShape)
    {
        BRepAlgoAPI_Section section(shape, otherShape);
        return section.Shape();
    }

    static TopoDS_Shape sectionSP(const TopoDS_Shape& shape, const Pln& ax3)
    {
        gp_Pln pln = Pln::toPln(ax3);
        BRepAlgoAPI_Section section(shape, pln);
        return section.Shape();
    }

    static TopoDS_Shape splitShapes(const ShapeArray& arguments, const ShapeArray& tools, double tolerance)
    {
        NCollection_List<TopoDS_Shape> argumentsList = shapeArrayToListOfShape(arguments);
        NCollection_List<TopoDS_Shape> toolsList = shapeArrayToListOfShape(tools);
        BRepAlgoAPI_Splitter splitter;
        splitter.SetFuzzyValue(tolerance);
        splitter.SetToFillHistory(false);
        splitter.SetArguments(argumentsList);
        splitter.SetTools(toolsList);
        splitter.SimplifyResult();
        splitter.Build();

        return splitter.Shape();
    }

    static double extremaDistance(const TopoDS_Shape& shape, const TopoDS_Shape& otherShape)
    {
        BRepExtrema_DistShapeShape extrema(shape, otherShape);
        // No solution (e.g. a shape without geometry): Value() raises StdFail_NotDone.
        if (!extrema.IsDone()) {
            return -1.0;
        }
        return extrema.Value();
    }

    static std::optional<InspectionDistance> inspectionDistance(const TopoDS_Shape& shape, const TopoDS_Shape& other)
    {
        if (shape.IsNull() || other.IsNull())
            return std::nullopt;
        BRepExtrema_DistShapeShape extrema(shape, other);
        if (!extrema.IsDone() || extrema.NbSolution() < 1)
            return std::nullopt;
        return InspectionDistance { extrema.Value(), Vector3::fromPnt(extrema.PointOnShape1(1)),
            Vector3::fromPnt(extrema.PointOnShape2(1)) };
    }

    static std::optional<double> inspectionCommonVolume(const TopoDS_Shape& first, const TopoDS_Shape& second)
    {
        if (!containsOnlySolids(first) || !containsOnlySolids(second)
            || !BRepCheck_Analyzer(first).IsValid()
            || !BRepCheck_Analyzer(second).IsValid())
            return std::nullopt;
        BRepAlgoAPI_Common common(first, second);
        common.Build();
        if (!common.IsDone() || common.Shape().IsNull())
            return std::nullopt;
        GProp_GProps props;
        BRepGProp::VolumeProperties(common.Shape(), props);
        double volume = std::abs(props.Mass());
        return std::isfinite(volume) ? std::optional<double>(volume) : std::nullopt;
    }

    static std::optional<InspectionMass> inspectionMass(const TopoDS_Shape& shape)
    {
        if (!containsOnlySolids(shape) || !BRepCheck_Analyzer(shape).IsValid())
            return std::nullopt;
        GProp_GProps props;
        BRepGProp::VolumeProperties(shape, props);
        if (!std::isfinite(props.Mass()) || std::abs(props.Mass()) < 1e-12)
            return std::nullopt;
        const gp_Pnt center = props.CentreOfMass();
        if (!std::isfinite(center.X()) || !std::isfinite(center.Y()) || !std::isfinite(center.Z()))
            return std::nullopt;
        return InspectionMass { std::abs(props.Mass()), Vector3::fromPnt(center) };
    }

    static TopoDS_Shape inspectionSectionCaps(const TopoDS_Shape& shape, const Pln& plane)
    {
        const Vector3& o = plane.location;
        const Vector3& n = plane.direction;
        const Vector3& x = plane.xDirection;
        const double normalLengthSq = n.x * n.x + n.y * n.y + n.z * n.z;
        const double xLengthSq = x.x * x.x + x.y * x.y + x.z * x.z;
        if (!containsOnlySolids(shape) || !BRepCheck_Analyzer(shape).IsValid()
            || !std::isfinite(o.x) || !std::isfinite(o.y) || !std::isfinite(o.z)
            || !std::isfinite(n.x) || !std::isfinite(n.y) || !std::isfinite(n.z)
            || !std::isfinite(x.x) || !std::isfinite(x.y) || !std::isfinite(x.z)
            || !std::isfinite(normalLengthSq) || normalLengthSq < 1e-24
            || !std::isfinite(xLengthSq) || xLengthSq < 1e-24)
            return TopoDS_Shape();
        gp_Dir normal = Vector3::toDir(n);
        gp_Dir xDirection = Vector3::toDir(x);
        if (std::abs(normal.Dot(xDirection)) > 1.0 - 1e-8)
            return TopoDS_Shape();
        Bnd_Box box;
        BRepBndLib::Add(shape, box, false);
        if (box.IsVoid())
            return TopoDS_Shape();
        const gp_Pnt low = box.CornerMin();
        const gp_Pnt high = box.CornerMax();
        double radius = std::max(low.Distance(Vector3::toPnt(o)), high.Distance(Vector3::toPnt(o))) * 3.0 + 1.0;
        if (!std::isfinite(radius) || radius > 1e12)
            return TopoDS_Shape();
        gp_Pln cut = Pln::toPln(plane);
        BRepBuilderAPI_MakeFace faceBuilder(cut, -radius, radius, -radius, radius);
        if (!faceBuilder.IsDone())
            return TopoDS_Shape();
        BRepPrimAPI_MakeHalfSpace halfSpace(faceBuilder.Face(),
            Vector3::toPnt(o).Translated(gp_Vec(normal).Multiplied(radius)));
        if (!halfSpace.IsDone() || halfSpace.Solid().IsNull())
            return TopoDS_Shape();
        BRepAlgoAPI_Common common(shape, halfSpace.Solid());
        common.Build();
        if (!common.IsDone() || common.Shape().IsNull())
            return TopoDS_Shape();
        BRep_Builder builder;
        TopoDS_Compound caps;
        builder.MakeCompound(caps);
        for (TopExp_Explorer it(common.Shape(), TopAbs_FACE); it.More(); it.Next()) {
            const TopoDS_Face face = TopoDS::Face(it.Current());
            BRepAdaptor_Surface surface(face, true);
            if (surface.GetType() != GeomAbs_Plane || std::abs(surface.Plane().Axis().Direction().Dot(normal)) < 1.0 - 1e-7)
                continue;
            GProp_GProps props;
            BRepGProp::SurfaceProperties(face, props);
            if (std::abs(cut.Distance(props.CentreOfMass())) <= 1e-6)
                builder.Add(caps, face);
        }
        return caps;
    }

    static size_t countShape(const TopoDS_Shape& shape, TopAbs_ShapeEnum shapeType)
    {
        size_t size = 0;
        TopExp_Explorer explorer;
        for (explorer.Init(shape, shapeType); explorer.More(); explorer.Next()) {
            size += 1;
        }
        return size;
    }

    static TopoDS_Shape shellSewing(const TopoDS_Shape& shape, double tolerance)
    {
        ShapeUpgrade_ShellSewing sewing;
        return sewing.ApplySewing(shape, tolerance);
    }

    static bool check(const TopoDS_Shape& shape)
    {
        BRepCheck_Analyzer analyzer(shape);
        return analyzer.IsValid();
    }

    static const char* checkStatusName(BRepCheck_Status status)
    {
        switch (status) {
        case BRepCheck_NoError:
            return "No Error";
        case BRepCheck_InvalidPointOnCurve:
            return "Invalid Point On Curve";
        case BRepCheck_InvalidPointOnCurveOnSurface:
            return "Invalid Point On Curve On Surface";
        case BRepCheck_InvalidPointOnSurface:
            return "Invalid Point On Surface";
        case BRepCheck_No3DCurve:
            return "No 3D Curve";
        case BRepCheck_Multiple3DCurve:
            return "Multiple 3D Curve";
        case BRepCheck_Invalid3DCurve:
            return "Invalid 3D Curve";
        case BRepCheck_NoCurveOnSurface:
            return "No Curve On Surface";
        case BRepCheck_InvalidCurveOnSurface:
            return "Invalid Curve On Surface";
        case BRepCheck_InvalidCurveOnClosedSurface:
            return "Invalid Curve On Closed Surface";
        case BRepCheck_InvalidSameRangeFlag:
            return "Invalid Same Range Flag";
        case BRepCheck_InvalidSameParameterFlag:
            return "Invalid Same Parameter Flag";
        case BRepCheck_InvalidDegeneratedFlag:
            return "Invalid Degenerated Flag";
        case BRepCheck_FreeEdge:
            return "Free Edge";
        case BRepCheck_InvalidMultiConnexity:
            return "Invalid Multi Connexity";
        case BRepCheck_InvalidRange:
            return "Invalid Range";
        case BRepCheck_EmptyWire:
            return "Empty Wire";
        case BRepCheck_RedundantEdge:
            return "Redundant Edge";
        case BRepCheck_SelfIntersectingWire:
            return "Self Intersecting Wire";
        case BRepCheck_NoSurface:
            return "No Surface";
        case BRepCheck_InvalidWire:
            return "Invalid Wire";
        case BRepCheck_RedundantWire:
            return "Redundant Wire";
        case BRepCheck_IntersectingWires:
            return "Intersecting Wires";
        case BRepCheck_InvalidImbricationOfWires:
            return "Invalid Imbrication Of Wires";
        case BRepCheck_EmptyShell:
            return "Empty Shell";
        case BRepCheck_RedundantFace:
            return "Redundant Face";
        case BRepCheck_InvalidImbricationOfShells:
            return "Invalid Imbrication Of Shells";
        case BRepCheck_UnorientableShape:
            return "Unorientable Shape";
        case BRepCheck_NotClosed:
            return "Not Closed";
        case BRepCheck_NotConnected:
            return "Not Connected";
        case BRepCheck_SubshapeNotInShape:
            return "Subshape Not In Shape";
        case BRepCheck_BadOrientation:
            return "Bad Orientation";
        case BRepCheck_BadOrientationOfSubshape:
            return "Bad Orientation Of Subshape";
        case BRepCheck_InvalidPolygonOnTriangulation:
            return "Invalid Polygon On Triangulation";
        case BRepCheck_InvalidToleranceValue:
            return "Invalid Tolerance Value";
        case BRepCheck_EnclosedRegion:
            return "Enclosed Region";
        case BRepCheck_CheckFail:
            return "Check Fail";
        default:
            return "Unknown";
        }
    }

    static std::string joinStatusNames(const NCollection_List<BRepCheck_Status>& statusList)
    {
        std::string result;
        for (auto it = statusList.begin(); it != statusList.end(); ++it) {
            if (!result.empty()) {
                result += ", ";
            }
            result += checkStatusName(*it);
        }
        return result;
    }

    static std::string collectFaceStatus(const BRepCheck_Analyzer& analyzer, const TopoDS_Shape& face)
    {
        std::string statuses;
        const auto& faceResult = analyzer.Result(face);
        if (!faceResult.IsNull()) {
            statuses = joinStatusNames(faceResult->Status());
        }
        return statuses;
    }

    static std::vector<FaceCheckResult> checkFaces(const TopoDS_Shape& shape)
    {
        BRepCheck_Analyzer analyzer(shape);

        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faceMap;
        TopExp::MapShapes(shape, TopAbs_FACE, faceMap);

        std::vector<FaceCheckResult> results;
        for (int i = 1; i <= faceMap.Extent(); i++) {
            const TopoDS_Shape& face = faceMap.FindKey(i);

            FaceCheckResult result;
            result.index = i - 1;
            result.isValid = analyzer.IsValid(face);
            result.status = collectFaceStatus(analyzer, face);
            results.push_back(result);
        }

        return results;
    }

    static TopoDS_Shape
    hlr(const TopoDS_Shape& shape, const gp_Pnt& point, const gp_Dir& direction, const gp_Dir& xDirection)
    {
        gp_Ax3 ax3(point, direction, xDirection);
        gp_Trsf trsf;
        trsf.SetTransformation(ax3);

        HLRAlgo_Projector projector(trsf, false, false);
        Handle(HLRBRep_Algo) algo = new HLRBRep_Algo();
        algo->Add(shape);
        algo->Projector(projector);
        algo->Update();

        HLRBRep_HLRToShape hlrToShape(algo);
        return hlrToShape.VCompound();
    }

    static void setTolerance(const TopoDS_Shape& shape, double tolerance)
    {
        ShapeFix_ShapeTolerance aFixTol;
        aFixTol.SetTolerance(shape, tolerance);
    }

    static double volume(const TopoDS_Shape& shape)
    {
        GProp_GProps props;
        BRepGProp::VolumeProperties(shape, props);
        return props.Mass();
    }
};

class Vertex {
public:
    static Vector3 point(const TopoDS_Vertex& vertex)
    {
        return Vector3::fromPnt(BRep_Tool::Pnt(vertex));
    }
};

class Edge {
public:
    static TopoDS_Edge fromCurve(const Geom_Curve* curve)
    {
        Handle(Geom_Curve) handleCurve(curve);
        BRepBuilderAPI_MakeEdge builder(handleCurve);
        return builder.Edge();
    }

    static double curveLength(const TopoDS_Edge& edge)
    {
        GProp_GProps props;
        BRepGProp::LinearProperties(edge, props);
        return props.Mass();
    }

    static double firstParameter(const TopoDS_Edge& edge)
    {
        // BRepAdaptor_Curve raises on an edge with neither a 3D curve nor a pcurve.
        if (!BRep_Tool::IsGeometric(edge)) {
            return 0.0;
        }
        BRepAdaptor_Curve adaptor(edge);
        return adaptor.FirstParameter();
    }

    static double lastParameter(const TopoDS_Edge& edge)
    {
        if (!BRep_Tool::IsGeometric(edge)) {
            return 0.0;
        }
        BRepAdaptor_Curve adaptor(edge);
        return adaptor.LastParameter();
    }

    static Vector3 pointAt(const TopoDS_Edge& edge, double parameter)
    {
        if (!BRep_Tool::IsGeometric(edge)) {
            // A degenerate edge collapses to its vertex point.
            ShapeAnalysis_Edge analysis;
            TopoDS_Vertex vertex = analysis.FirstVertex(edge);
            return vertex.IsNull() ? Vector3 { 0.0, 0.0, 0.0 } : Vector3::fromPnt(BRep_Tool::Pnt(vertex));
        }
        BRepAdaptor_Curve adaptor(edge);
        return Vector3::fromPnt(adaptor.Value(parameter));
    }

    static Vector3 pointOfVertex(const TopoDS_Vertex& vertex)
    {
        // An edge built on an infinite curve has no vertices; BRep_Tool::Pnt raises on a null vertex.
        if (vertex.IsNull()) {
            return Vector3 { 0.0, 0.0, 0.0 };
        }
        return Vector3::fromPnt(BRep_Tool::Pnt(vertex));
    }

    static Vector3 startPoint(const TopoDS_Edge& edge)
    {
        ShapeAnalysis_Edge analysis;
        return pointOfVertex(analysis.FirstVertex(edge));
    }

    static Vector3 endPoint(const TopoDS_Edge& edge)
    {
        ShapeAnalysis_Edge analysis;
        return pointOfVertex(analysis.LastVertex(edge));
    }

    static Vector3Array ends(const TopoDS_Edge& edge)
    {
        ShapeAnalysis_Edge analysis;
        std::vector<Vector3> points = {
            pointOfVertex(analysis.FirstVertex(edge)),
            pointOfVertex(analysis.LastVertex(edge)),
        };
        return Vector3Array(val::array(points));
    }

    static Handle(Geom_TrimmedCurve) curve(const TopoDS_Edge& edge)
    {
        double start(0.0), end(0.0);
        Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, start, end);
        if (curve.IsNull()) {
            // A degenerate edge has no 3D curve to wrap. A C++ raise would abort the WASM
            // module (exceptions are disabled), so report as a catchable JS Error instead.
            val::global("Error").new_(std::string("Edge.curve: degenerate edge has no 3D curve")).throw_();
        }
        Handle(Geom_TrimmedCurve) trimmedCurve = new Geom_TrimmedCurve(curve, start, end);
        return trimmedCurve;
    }

    static TopoDS_Edge trim(const TopoDS_Edge& edge, double start, double end)
    {
        double u1(0.0), u2(0.0);
        Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, u1, u2);
        if (curve.IsNull()) {
            return TopoDS_Edge();
        }
        // A Geom_OffsetCurve on a trimmed basis is bounded by the basis trim range,
        // rebase it on the untrimmed basis so trimming beyond the edge range works.
        Handle(Geom_OffsetCurve) offsetCurve = Handle(Geom_OffsetCurve)::DownCast(curve);
        if (!offsetCurve.IsNull()) {
            Handle(Geom_TrimmedCurve) trimmedBasis = Handle(Geom_TrimmedCurve)::DownCast(offsetCurve->BasisCurve());
            if (!trimmedBasis.IsNull()) {
                curve = new Geom_OffsetCurve(trimmedBasis->BasisCurve(), offsetCurve->Offset(), offsetCurve->Direction());
            }
        }
        BRepBuilderAPI_MakeEdge builder(curve, start, end);
        if (!builder.IsDone()) {
            return TopoDS_Edge();
        }
        return builder.Edge();
    }

    static TopoDS_Edge offset(const TopoDS_Edge& edge, const gp_Dir& dir, double offset)
    {
        double start(0.0), end(0.0);
        Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, start, end);
        if (curve.IsNull()) {
            return TopoDS_Edge();
        }
        Handle(Geom_TrimmedCurve) trimmedCurve = new Geom_TrimmedCurve(curve, start, end);
        Handle(Geom_OffsetCurve) offsetCurve = new Geom_OffsetCurve(trimmedCurve, offset, dir);
        BRepBuilderAPI_MakeEdge builder(offsetCurve);
        return builder.Edge();
    }

    static PointAndParameterArray intersect(const TopoDS_Edge& edge, const TopoDS_Edge& otherEdge)
    {
        std::vector<PointAndParameter> points;
        if (edge.IsNull() || otherEdge.IsNull() || BRep_Tool::Degenerated(edge)
            || BRep_Tool::Degenerated(otherEdge)) {
            return PointAndParameterArray(val::array(points));
        }

        double start1(0.0), end1(0.0), start2(0.0), end2(0.0);
        Handle(Geom_Curve) curve1 = BRep_Tool::Curve(edge, start1, end1);
        Handle(Geom_Curve) curve2 = BRep_Tool::Curve(otherEdge, start2, end2);
        if (curve1.IsNull() || curve2.IsNull()) {
            return PointAndParameterArray(val::array(points));
        }

        BRepExtrema_ExtCC cc(edge, otherEdge);
        if (cc.IsDone() && cc.NbExt() > 0 && !cc.IsParallel()) {
            for (int i = 1; i <= cc.NbExt(); i++) {
                if (cc.SquareDistance(i) > Precision::Intersection()) {
                    continue;
                }
                PointAndParameter pointAndParameter = {
                    Vector3::fromPnt(cc.PointOnE1(i)),
                    cc.ParameterOnE1(i),
                };
                points.push_back(pointAndParameter);
            }
        }

        return PointAndParameterArray(val::array(points));
    }
};

class Wire {
public:
    static TopoDS_Shape offset(const TopoDS_Wire& wire, double distance, const GeomAbs_JoinType& joinType)
    {
        BRepOffsetAPI_MakeOffset offsetter(wire, joinType);
        offsetter.Perform(distance);
        if (offsetter.IsDone()) {
            return offsetter.Shape();
        }
        return TopoDS_Shape();
    }

    static TopoDS_Face makeFace(const TopoDS_Wire& wire)
    {
        BRepBuilderAPI_MakeFace face(wire);
        return face.Face();
    }

    static EdgeArray edgeLoop(const TopoDS_Wire& wire)
    {
        std::vector<TopoDS_Edge> edges;
        BRepTools_WireExplorer explorer(wire);
        for (; explorer.More(); explorer.Next()) {
            edges.push_back(TopoDS::Edge(explorer.Current()));
        }
        return EdgeArray(val::array(edges));
    }
};

class Face {
public:
    static TopoDS_Shape inspectionTrimmedIso(const TopoDS_Face& face, bool isU, double parameter)
    {
        if (face.IsNull() || !std::isfinite(parameter) || BRep_Tool::Surface(face).IsNull()
            || BRepTools::OuterWire(face).IsNull())
            return TopoDS_Shape();
        double u1, u2, v1, v2;
        BRepTools::UVBounds(face, u1, u2, v1, v2);
        if (!std::isfinite(u1) || !std::isfinite(u2) || !std::isfinite(v1) || !std::isfinite(v2)
            || u1 >= u2 || v1 >= v2 || parameter < (isU ? u1 : v1) || parameter > (isU ? u2 : v2)) {
            return TopoDS_Shape();
        }
        Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
        Handle(Geom_Curve) iso = isU ? surface->UIso(parameter) : surface->VIso(parameter);
        if (iso.IsNull())
            return TopoDS_Shape();
        BRepBuilderAPI_MakeEdge edgeBuilder(iso, isU ? v1 : u1, isU ? v2 : u2);
        if (!edgeBuilder.IsDone())
            return TopoDS_Shape();
        BRepAlgoAPI_Common common(face, edgeBuilder.Edge());
        common.Build();
        return common.IsDone() ? common.Shape() : TopoDS_Shape();
    }

    static std::optional<InspectionUVBounds> inspectionUVBounds(const TopoDS_Face& face)
    {
        if (face.IsNull() || BRep_Tool::Surface(face).IsNull() || BRepTools::OuterWire(face).IsNull()) {
            return std::nullopt;
        }
        double u1, u2, v1, v2;
        BRepTools::UVBounds(face, u1, u2, v1, v2);
        if (!std::isfinite(u1) || !std::isfinite(u2) || !std::isfinite(v1) || !std::isfinite(v2)
            || u1 >= u2 || v1 >= v2)
            return std::nullopt;
        return InspectionUVBounds { u1, u2, v1, v2 };
    }

    static InspectionRayResult inspectionRayHit(const TopoDS_Face& face, const Vector3& point,
        const Vector3& direction, double minDistance, double maxDistance, double tolerance)
    {
        if (face.IsNull() || BRep_Tool::Surface(face).IsNull() || !std::isfinite(direction.x) || !std::isfinite(direction.y) || !std::isfinite(direction.z) || !std::isfinite(point.x) || !std::isfinite(point.y) || !std::isfinite(point.z) || direction.x * direction.x + direction.y * direction.y + direction.z * direction.z < 1e-24 || !std::isfinite(minDistance) || !std::isfinite(maxDistance) || minDistance < 0 || minDistance >= maxDistance || !std::isfinite(tolerance) || tolerance <= 0) {
            return InspectionRayResult { false, false, Vector3 { 0.0, 0.0, 0.0 } };
        }
        gp_Lin line(Vector3::toPnt(point), Vector3::toDir(direction));
        IntCurvesFace_Intersector intersector(face, tolerance);
        intersector.Perform(line, minDistance, maxDistance);
        if (!intersector.IsDone())
            return InspectionRayResult { false, false, Vector3 { 0.0, 0.0, 0.0 } };
        if (intersector.NbPnt() < 1)
            return InspectionRayResult { true, false, Vector3 { 0.0, 0.0, 0.0 } };
        double nearest = maxDistance;
        std::optional<Vector3> result;
        for (int i = 1; i <= intersector.NbPnt(); ++i) {
            double parameter = intersector.WParameter(i);
            if (parameter >= minDistance && parameter < nearest) {
                nearest = parameter;
                result = Vector3::fromPnt(intersector.Pnt(i));
            }
        }
        return result.has_value()
            ? InspectionRayResult { true, true, result.value() }
            : InspectionRayResult { true, false, Vector3 { 0.0, 0.0, 0.0 } };
    }

    static double area(const TopoDS_Face& face)
    {
        GProp_GProps props;
        BRepGProp::SurfaceProperties(face, props);
        return props.Mass();
    }

    static TopoDS_Shape offset(const TopoDS_Face& face, double distance, const GeomAbs_JoinType& joinType)
    {
        BRepOffsetAPI_MakeOffset offsetter(face, joinType);
        offsetter.Perform(distance);
        if (offsetter.IsDone()) {
            return offsetter.Shape();
        }
        return TopoDS_Shape();
    }

    static Domain curveOnSurface(const TopoDS_Face& face, const TopoDS_Edge& edge)
    {
        double start(0.0), end(0.0);
        if (BRep_Tool::CurveOnSurface(edge, face, start, end).IsNull()) {
            return Domain();
        }
        Domain domain = { start, end };
        return domain;
    }

    static bool containsPoint(const TopoDS_Face& face, const Vector3& point, bool containsEdge, double tolerance)
    {
        // A face without a geometric surface (e.g. an STL-imported face) contains nothing.
        if (BRep_Tool::Surface(face).IsNull()) {
            return false;
        }
        gp_Pnt pnt(point.x, point.y, point.z);

        auto aPuv = pointToFaceUV(face, pnt, tolerance);
        if (!aPuv.has_value()) {
            return false;
        }

        BRepClass_FaceClassifier classifier(face, aPuv.value(), tolerance);
        auto state = classifier.State();
        if (containsEdge && state == TopAbs_ON) {
            return true;
        }
        return state == TopAbs_IN;
    }

    static std::optional<Vector3> intersectLine(const TopoDS_Face& face, const Vector3& point, const Vector3& direction, double tolerance)
    {
        if (BRep_Tool::Surface(face).IsNull()) {
            return std::nullopt;
        }
        gp_Lin line(gp_Pnt(point.x, point.y, point.z), gp_Dir(direction.x, direction.y, direction.z));

        IntCurvesFace_Intersector anIntersector(face, tolerance);
        anIntersector.Perform(line, -1e12, 1e12);
        if (anIntersector.IsDone() && anIntersector.NbPnt() > 0) {
            return Vector3::fromPnt(anIntersector.Pnt(1));
        }
        return std::nullopt;
    }

    static void normal(const TopoDS_Face& face, double u, double v, gp_Pnt& point, gp_Vec& normal)
    {
        // A face without a geometric surface has no normal; leave the zero-initialized outputs.
        if (BRep_Tool::Surface(face).IsNull()) {
            return;
        }
        BRepGProp_Face gpProp(face);
        gpProp.Normal(u, v, point, normal);
    }

    static WireArray wires(const TopoDS_Face& face)
    {
        std::vector<TopoDS_Wire> wires;
        TopExp_Explorer explorer;
        for (explorer.Init(face, TopAbs_WIRE); explorer.More(); explorer.Next()) {
            wires.push_back(TopoDS::Wire(explorer.Current()));
        }
        return WireArray(val::array(wires));
    }

    static TopoDS_Wire outerWire(const TopoDS_Face& face)
    {
        return BRepTools::OuterWire(face);
    }

    static Handle(Geom_Surface) surface(const TopoDS_Face& face)
    {
        return BRep_Tool::Surface(face);
    }
};

class Solid {
public:
    static bool containsPoint(const TopoDS_Shape& shape, const Vector3& point, bool containsSurface, double tolerance)
    {
        gp_Pnt pnt(point.x, point.y, point.z);
        BRepClass3d_SolidClassifier classifier(shape, pnt, tolerance);
        TopAbs_State state = classifier.State();
        if (state == TopAbs_IN) {
            return true;
        } else if (state == TopAbs_OUT) {
            return false;
        } else if (state == TopAbs_ON && containsSurface) {
            return true;
        }

        return false;
    }
};

EMSCRIPTEN_BINDINGS(Shape)
{
    register_optional<InspectionDistance>();
    register_optional<InspectionMass>();
    value_object<InspectionDistance>("InspectionDistance")
        .field("distance", &InspectionDistance::distance)
        .field("first", &InspectionDistance::first)
        .field("second", &InspectionDistance::second);
    value_object<InspectionMass>("InspectionMass")
        .field("volume", &InspectionMass::volume)
        .field("center", &InspectionMass::center);
    register_optional<InspectionUVBounds>();
    value_object<InspectionUVBounds>("InspectionUVBounds")
        .field("u1", &InspectionUVBounds::u1)
        .field("u2", &InspectionUVBounds::u2)
        .field("v1", &InspectionUVBounds::v1)
        .field("v2", &InspectionUVBounds::v2);
    value_object<InspectionRayResult>("InspectionRayResult")
        .field("valid", &InspectionRayResult::valid)
        .field("hasHit", &InspectionRayResult::hasHit)
        .field("point", &InspectionRayResult::point);
    class_<Shape>("Shape")
        .class_function("ptr", &Shape::ptr)
        .class_function("boundingBox", &Shape::boundingBox)
        .class_function("orientedBoundingBox", &Shape::orientedBoundingBox)
        .class_function("extremaDistance", &Shape::extremaDistance)
        .class_function("inspectionDistance", &Shape::inspectionDistance)
        .class_function("inspectionCommonVolume", &Shape::inspectionCommonVolume)
        .class_function("inspectionMass", &Shape::inspectionMass)
        .class_function("inspectionSectionCaps", &Shape::inspectionSectionCaps)
        .class_function("clean", &Shape::clean)
        .class_function("clone", &Shape::clone)
        .class_function("transformed", &Shape::transformed)
        .class_function("findAncestor", &Shape::findAncestor)
        .class_function("findSubShapes", &Shape::findSubShapes)
        .class_function("getDirectSubShapes", &Shape::getDirectSubShapes)
        .class_function("sectionSS", &Shape::sectionSS)
        .class_function("sectionSP", &Shape::sectionSP)
        .class_function("isClosed", &Shape::isClosed)
        .class_function("splitShapes", &Shape::splitShapes)
        .class_function("check", &Shape::check)
        .class_function("checkFaces", &Shape::checkFaces)
        .class_function("hlr", &Shape::hlr)
        .class_function("shellSewing", &Shape::shellSewing)
        .class_function("setTolerance", &Shape::setTolerance)
        .class_function("volume", &Shape::volume);

    class_<Vertex>("Vertex").class_function("point", &Vertex::point);

    class_<Edge>("Edge")
        .class_function("fromCurve", &Edge::fromCurve, allow_raw_pointers())
        .class_function("curve", &Edge::curve)
        .class_function("curveLength", &Edge::curveLength)
        .class_function("firstParameter", &Edge::firstParameter)
        .class_function("lastParameter", &Edge::lastParameter)
        .class_function("pointAt", &Edge::pointAt)
        .class_function("startPoint", &Edge::startPoint)
        .class_function("endPoint", &Edge::endPoint)
        .class_function("ends", &Edge::ends)
        .class_function("trim", &Edge::trim)
        .class_function("intersect", &Edge::intersect)
        .class_function("offset", &Edge::offset);

    class_<Wire>("Wire")
        .class_function("offset", &Wire::offset)
        .class_function("makeFace", &Wire::makeFace)
        .class_function("edgeLoop", &Wire::edgeLoop);

    class_<Face>("Face")
        .class_function("inspectionTrimmedIso", &Face::inspectionTrimmedIso)
        .class_function("inspectionUVBounds", &Face::inspectionUVBounds)
        .class_function("inspectionRayHit", &Face::inspectionRayHit)
        .class_function("area", &Face::area)
        .class_function("offset", &Face::offset)
        .class_function("outerWire", &Face::outerWire)
        .class_function("surface", &Face::surface)
        .class_function("normal", &Face::normal)
        .class_function("intersectLine", &Face::intersectLine)
        .class_function("curveOnSurface", &Face::curveOnSurface)
        .class_function("containsPoint", &Face::containsPoint);

    class_<Solid>("Solid")
        .class_function("containsPoint", &Solid::containsPoint);
}
