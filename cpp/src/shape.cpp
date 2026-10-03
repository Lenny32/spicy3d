// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <BOPAlgo_CheckResult.hxx>
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
#include <Precision.hxx>
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
#include <algorithm>
#include <gp_Ax3.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "faceValidation.hpp"
#include "guard.hpp"
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

    // BOPAlgo_ArgumentAnalyzer's self-interference test intersects faces pairwise, so the
    // inspections run it on their inputs only below this many faces per shape; larger inputs
    // skip it (BRepCheck_Analyzer still runs) and the caller can opt in with
    // checkSelfIntersection.
    static constexpr size_t SELF_INTERSECTION_FACE_LIMIT = 200;

    // True when `shape` passes the self-interference test. Each solid is tested on its own,
    // so solids of one compound that touch or overlap each other are not reported; a shape
    // without solids is tested as a whole. A test that cannot complete (BOPAlgo_CheckUnknown)
    // counts as a failure.
    static bool selfIntersectionFree(const TopoDS_Shape& shape)
    {
        if (shape.IsNull())
            return false;
        auto testOne = [](const TopoDS_Shape& part) {
            BOPAlgo_ArgumentAnalyzer analyzer;
            analyzer.SetShape1(part);
            analyzer.SelfInterMode() = Standard_True;
            analyzer.StopOnFirstFaulty() = Standard_True;
            analyzer.Perform();
            return !analyzer.HasFaulty();
        };
        bool hasSolid = false;
        for (TopExp_Explorer it(shape, TopAbs_SOLID); it.More(); it.Next()) {
            hasSolid = true;
            if (!testOne(it.Current()))
                return false;
        }
        return hasSolid || testOne(shape);
    }

    // At most this many interfering pairs are located (one section or distance query each);
    // the others are only counted.
    static constexpr int MAX_LOCATED_INTERSECTIONS = 4;

    // Where two interfering sub-shapes meet: a point on their intersection and the extent of
    // the whole intersection. Two faces are sectioned (the point lies on the longest
    // intersection curve); other pairs, or faces the section misses, use their closest points,
    // and `gap` is their distance — sub-shapes interfere through their tolerances too.
    struct IntersectionRegion {
        gp_Pnt point;
        Bnd_Box extent;
        double gap = 0;
    };

    static std::optional<IntersectionRegion> locateIntersection(const TopoDS_Shape& first, const TopoDS_Shape& second)
    {
        try {
            if (first.ShapeType() == TopAbs_FACE && second.ShapeType() == TopAbs_FACE) {
                BRepAlgoAPI_Section section(first, second, false);
                section.Approximation(false);
                section.ComputePCurveOn1(false);
                section.ComputePCurveOn2(false);
                section.Build();
                if (section.IsDone() && !section.Shape().IsNull()) {
                    IntersectionRegion region;
                    double longest = -1;
                    for (TopExp_Explorer it(section.Shape(), TopAbs_EDGE); it.More(); it.Next()) {
                        const TopoDS_Edge& edge = TopoDS::Edge(it.Current());
                        if (BRep_Tool::Degenerated(edge))
                            continue;
                        BRepAdaptor_Curve curve(edge);
                        const double length = GCPnts_AbscissaPoint::Length(curve);
                        BRepBndLib::Add(edge, region.extent, false);
                        if (length > longest) {
                            longest = length;
                            region.point = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2);
                        }
                    }
                    if (longest >= 0)
                        return region;
                    for (TopExp_Explorer it(section.Shape(), TopAbs_VERTEX); it.More(); it.Next()) {
                        const gp_Pnt point = BRep_Tool::Pnt(TopoDS::Vertex(it.Current()));
                        if (region.extent.IsVoid())
                            region.point = point;
                        region.extent.Add(point);
                    }
                    if (!region.extent.IsVoid())
                        return region;
                }
            }
            BRepExtrema_DistShapeShape distance(first, second);
            if (!distance.IsDone() || distance.NbSolution() == 0)
                return std::nullopt;
            IntersectionRegion region;
            const gp_Pnt a = distance.PointOnShape1(1);
            const gp_Pnt b = distance.PointOnShape2(1);
            region.point = gp_Pnt((a.XYZ() + b.XYZ()) / 2);
            region.gap = distance.Value();
            for (int i = 1; i <= distance.NbSolution(); ++i) {
                region.extent.Add(distance.PointOnShape1(i));
                region.extent.Add(distance.PointOnShape2(i));
            }
            return region;
        } catch (const Standard_Failure&) {
            // Locating is a courtesy: the verdict stands, the caller falls back to the bounding box.
            return std::nullopt;
        }
    }

    // Empty = proven clean. Otherwise the output faces involved and, per interfering pair (the
    // first few), a point on the actual intersection and its extent; a pair that cannot be
    // located keeps the approximate bounding-box center of its sub-shapes, labelled as such.
    // Face indices belong to the queried output.
    static std::string selfIntersectionDiagnostic(const TopoDS_Shape& shape)
    {
        if (shape.IsNull())
            throw std::runtime_error("Self-intersection check requires a non-null shape");
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces;
        TopExp::MapShapes(shape, TopAbs_FACE, faces);
        // Zero-based indices of the output faces that are or contain `subshape`.
        auto owningFaces = [&](const TopoDS_Shape& subshape) {
            std::vector<int> owners;
            for (int i = 1; i <= faces.Extent(); ++i) {
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> members;
                TopExp::MapShapes(faces.FindKey(i), members);
                if (members.Contains(subshape))
                    owners.push_back(i - 1);
            }
            return owners;
        };
        auto describe = [&](const TopoDS_Shape& subshape) {
            std::ostringstream text;
            const auto owners = owningFaces(subshape);
            if (subshape.ShapeType() == TopAbs_FACE && owners.size() == 1) {
                text << "face " << owners.front();
                return text.str();
            }
            text << (subshape.ShapeType() == TopAbs_EDGE ? "edge" : subshape.ShapeType() == TopAbs_VERTEX ? "vertex"
                                                                                                          : "sub-shape");
            if (!owners.empty()) {
                text << " of face" << (owners.size() > 1 ? "s" : "");
                for (size_t k = 0; k < owners.size(); ++k)
                    text << (k ? "/" : " ") << owners[k];
            }
            return text.str();
        };
        auto point = [](std::ostringstream& text, double x, double y, double z) {
            text << "(" << x << ", " << y << ", " << z << ")";
        };
        auto testOne = [&](const TopoDS_Shape& part) -> std::string {
            BOPAlgo_ArgumentAnalyzer analyzer;
            analyzer.SetShape1(part);
            analyzer.SelfInterMode() = true;
            // Stops after the self-interference test; that test still lists every pair.
            analyzer.StopOnFirstFaulty() = true;
            analyzer.Perform();
            if (!analyzer.HasFaulty())
                return "";
            for (const auto& fault : analyzer.GetCheckResult()) {
                if (fault.GetCheckStatus() != BOPAlgo_SelfIntersect)
                    throw std::runtime_error("Self-intersection check could not complete (result unknown)");
            }
            std::ostringstream message;
            message << "Shape intersects itself; output face indices (zero-based):";
            std::vector<int> involved;
            for (const auto& fault : analyzer.GetCheckResult()) {
                for (const auto& subshape : fault.GetFaultyShapes1()) {
                    for (int owner : owningFaces(subshape)) {
                        if (std::find(involved.begin(), involved.end(), owner) == involved.end())
                            involved.push_back(owner);
                    }
                }
            }
            std::sort(involved.begin(), involved.end());
            if (involved.empty())
                message << " unavailable";
            for (int index : involved)
                message << " " << index;
            const int pairs = analyzer.GetCheckResult().Size();
            message << "; " << pairs << " intersecting pair" << (pairs == 1 ? "" : "s");
            // Crossing faces first: their section is the intersection itself, while touching
            // edges and vertices only mark where it reaches the boundary.
            std::vector<const BOPAlgo_CheckResult*> ordered;
            for (const auto& fault : analyzer.GetCheckResult())
                ordered.push_back(&fault);
            auto rank = [](const BOPAlgo_CheckResult* fault) {
                int faces = 0;
                for (const auto& subshape : fault->GetFaultyShapes1())
                    faces += subshape.ShapeType() == TopAbs_FACE;
                return -faces;
            };
            std::stable_sort(ordered.begin(), ordered.end(), [&](auto a, auto b) { return rank(a) < rank(b); });
            int located = 0;
            for (const auto* fault : ordered) {
                if (located == MAX_LOCATED_INTERSECTIONS)
                    break;
                ++located;
                const auto& faulty = fault->GetFaultyShapes1();
                message << "; ";
                if (faulty.Size() == 2) {
                    message << describe(faulty.First()) << " x " << describe(faulty.Last());
                    if (const auto region = locateIntersection(faulty.First(), faulty.Last())) {
                        if (region->gap > Precision::Confusion()) {
                            message << " overlap within their tolerances near xyz (mm): ";
                            point(message, region->point.X(), region->point.Y(), region->point.Z());
                            message << ", gap " << region->gap << " mm";
                            continue;
                        }
                        double x0, y0, z0, x1, y1, z1;
                        region->extent.Get(x0, y0, z0, x1, y1, z1);
                        message << " intersect at xyz (mm): ";
                        point(message, region->point.X(), region->point.Y(), region->point.Z());
                        message << ", intersection extent (mm): ";
                        point(message, x0, y0, z0);
                        message << " to ";
                        point(message, x1, y1, z1);
                        continue;
                    }
                } else if (!faulty.IsEmpty()) {
                    message << describe(faulty.First()) << " intersects itself";
                }
                Bnd_Box region;
                for (const auto& subshape : faulty)
                    BRepBndLib::Add(subshape, region, false);
                if (!region.IsVoid() && !region.IsOpen()) {
                    double x0, y0, z0, x1, y1, z1;
                    region.Get(x0, y0, z0, x1, y1, z1);
                    message << ", not located; approximate faulty region center xyz (mm): ";
                    point(message, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
                }
            }
            if (pairs > located)
                message << "; " << pairs - located << " more pair" << (pairs - located == 1 ? "" : "s") << " not located";
            return message.str();
        };
        bool hasSolid = false;
        for (TopExp_Explorer it(shape, TopAbs_SOLID); it.More(); it.Next()) {
            hasSolid = true;
            const auto diagnostic = testOne(it.Current());
            if (!diagnostic.empty())
                return diagnostic;
        }
        return hasSolid ? "" : testOne(shape);
    }

    // The self-interference test of an inspection input: skipped (true) above the face limit.
    static bool boundedSelfIntersectionFree(const TopoDS_Shape& shape)
    {
        if (countShape(shape, TopAbs_FACE) >= SELF_INTERSECTION_FACE_LIMIT)
            return true;
        return selfIntersectionFree(shape);
    }

public:
    static size_t ptr(const TopoDS_Shape& shape)
    {
        return size_t(shape.TShape().get());
    }

    static BoundingBox boundingBox(const TopoDS_Shape& shape, bool useTriangulation)
    {
        Bnd_Box obx;
        if (useTriangulation) {
            BRepBndLib::Add(shape, obx, true);
        } else {
            // Exact box from the geometry: plain Add is loose on B-spline / offset geometry
            // (pole hulls) and widened by the shape tolerance.
            BRepBndLib::AddOptimal(shape, obx, false, false);
        }
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
        return inspectionCommonVolumeImpl(first, second, false);
    }

    static std::optional<double> inspectionCommonVolumePrechecked(const TopoDS_Shape& firstShape, const TopoDS_Shape& second)
    {
        return inspectionCommonVolumeImpl(firstShape, second, true);
    }

    static std::optional<double> inspectionCommonVolumeImpl(const TopoDS_Shape& firstShape, const TopoDS_Shape& second, bool skipSelfIntersection)
    {
        if (!containsOnlySolids(firstShape) || !containsOnlySolids(second)
            || !BRepCheck_Analyzer(firstShape).IsValid()
            || !BRepCheck_Analyzer(second).IsValid())
            return std::nullopt;
        // BRepCheck_Analyzer does not test self-intersection, and the boolean may raise on a
        // self-intersecting solid (an offset whose faces cross). Bounded, see the face limit.
        if (!skipSelfIntersection && (!boundedSelfIntersectionFree(firstShape) || !boundedSelfIntersectionFree(second)))
            return std::nullopt;
        BRepAlgoAPI_Common common(firstShape, second);
        common.Build();
        if (!common.IsDone() || common.HasErrors() || common.Shape().IsNull())
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
        return inspectionSectionCapsImpl(shape, plane, false);
    }

    static TopoDS_Shape inspectionSectionCapsPrechecked(const TopoDS_Shape& shape, const Pln& plane)
    {
        return inspectionSectionCapsImpl(shape, plane, true);
    }

    static TopoDS_Shape inspectionSectionCapsImpl(const TopoDS_Shape& shape, const Pln& plane, bool skipSelfIntersection)
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
        // As in inspectionCommonVolume: a self-intersecting solid may make the boolean raise.
        if (!skipSelfIntersection && !boundedSelfIntersectionFree(shape))
            return TopoDS_Shape();
        BRepAlgoAPI_Common common(shape, halfSpace.Solid());
        common.Build();
        if (!common.IsDone() || common.HasErrors() || common.Shape().IsNull())
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

    // True when `shape` has no self-intersection (see selfIntersectionFree). Not bounded:
    // pairwise face intersection, expensive on shapes with many faces.
    static std::string selfIntersectionDetails(const TopoDS_Shape& shape)
    {
        return selfIntersectionDiagnostic(shape);
    }

    static bool checkSelfIntersection(const TopoDS_Shape& shape)
    {
        return selfIntersectionFree(shape);
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
            result.status = FaceValidation::collectFaceStatus(analyzer, face);
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
            // A degenerate edge has no 3D curve to wrap: report it as a catchable JS Error
            // with a clearer message than the raise guardedEntry would catch.
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
        // BRepGProp_Face reports D1U ^ D1V; return a unit vector, or zeros where it degenerates.
        // Same cutoff as MIN_NORMAL_LENGTH (1e-12 on the length) in packages/wasm/src/shape.ts.
        constexpr double minNormalLength = 1e-12;
        if (normal.SquareMagnitude() > minNormalLength * minNormalLength) {
            normal.Normalize();
        } else {
            normal = gp_Vec(0, 0, 0);
        }
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
        .class_function("ptr", guardedEntry<&Shape::ptr>("Shape.ptr"))
        .class_function("boundingBox", guardedEntry<&Shape::boundingBox>("Shape.boundingBox"))
        .class_function("orientedBoundingBox", guardedEntry<&Shape::orientedBoundingBox>("Shape.orientedBoundingBox"))
        .class_function("extremaDistance", guardedEntry<&Shape::extremaDistance>("Shape.extremaDistance"))
        .class_function("inspectionDistance", guardedEntry<&Shape::inspectionDistance>("Shape.inspectionDistance"))
        .class_function("inspectionCommonVolumePrechecked", guardedEntry<&Shape::inspectionCommonVolumePrechecked>("Shape.inspectionCommonVolumePrechecked"))
        .class_function("inspectionCommonVolume", guardedEntry<&Shape::inspectionCommonVolume>("Shape.inspectionCommonVolume"))
        .class_function("inspectionMass", guardedEntry<&Shape::inspectionMass>("Shape.inspectionMass"))
        .class_function("inspectionSectionCapsPrechecked", guardedEntry<&Shape::inspectionSectionCapsPrechecked>("Shape.inspectionSectionCapsPrechecked"))
        .class_function("inspectionSectionCaps", guardedEntry<&Shape::inspectionSectionCaps>("Shape.inspectionSectionCaps"))
        .class_function("clean", guardedEntry<&Shape::clean>("Shape.clean"))
        .class_function("clone", guardedEntry<&Shape::clone>("Shape.clone"))
        .class_function("transformed", guardedEntry<&Shape::transformed>("Shape.transformed"))
        .class_function("findAncestor", guardedEntry<&Shape::findAncestor>("Shape.findAncestor"))
        .class_function("findSubShapes", guardedEntry<&Shape::findSubShapes>("Shape.findSubShapes"))
        .class_function("getDirectSubShapes", guardedEntry<&Shape::getDirectSubShapes>("Shape.getDirectSubShapes"))
        .class_function("sectionSS", guardedEntry<&Shape::sectionSS>("Shape.sectionSS"))
        .class_function("sectionSP", guardedEntry<&Shape::sectionSP>("Shape.sectionSP"))
        .class_function("isClosed", guardedEntry<&Shape::isClosed>("Shape.isClosed"))
        .class_function("splitShapes", guardedEntry<&Shape::splitShapes>("Shape.splitShapes"))
        .class_function("check", guardedEntry<&Shape::check>("Shape.check"))
        .class_function("checkFaces", guardedEntry<&Shape::checkFaces>("Shape.checkFaces"))
        .class_function("selfIntersectionDetails", guardedEntry<&Shape::selfIntersectionDetails>("Shape.selfIntersectionDetails"))
        .class_function("checkSelfIntersection", guardedEntry<&Shape::checkSelfIntersection>("Shape.checkSelfIntersection"))
        .class_function("hlr", guardedEntry<&Shape::hlr>("Shape.hlr"))
        .class_function("shellSewing", guardedEntry<&Shape::shellSewing>("Shape.shellSewing"))
        .class_function("setTolerance", guardedEntry<&Shape::setTolerance>("Shape.setTolerance"))
        .class_function("volume", guardedEntry<&Shape::volume>("Shape.volume"));

    class_<Vertex>("Vertex").class_function("point", guardedEntry<&Vertex::point>("Vertex.point"));

    class_<Edge>("Edge")
        .class_function("fromCurve", guardedEntry<&Edge::fromCurve>("Edge.fromCurve"), allow_raw_pointers())
        .class_function("curve", guardedEntry<&Edge::curve>("Edge.curve"))
        .class_function("curveLength", guardedEntry<&Edge::curveLength>("Edge.curveLength"))
        .class_function("firstParameter", guardedEntry<&Edge::firstParameter>("Edge.firstParameter"))
        .class_function("lastParameter", guardedEntry<&Edge::lastParameter>("Edge.lastParameter"))
        .class_function("pointAt", guardedEntry<&Edge::pointAt>("Edge.pointAt"))
        .class_function("startPoint", guardedEntry<&Edge::startPoint>("Edge.startPoint"))
        .class_function("endPoint", guardedEntry<&Edge::endPoint>("Edge.endPoint"))
        .class_function("ends", guardedEntry<&Edge::ends>("Edge.ends"))
        .class_function("trim", guardedEntry<&Edge::trim>("Edge.trim"))
        .class_function("intersect", guardedEntry<&Edge::intersect>("Edge.intersect"))
        .class_function("offset", guardedEntry<&Edge::offset>("Edge.offset"));

    class_<Wire>("Wire")
        .class_function("offset", guardedEntry<&Wire::offset>("Wire.offset"))
        .class_function("makeFace", guardedEntry<&Wire::makeFace>("Wire.makeFace"))
        .class_function("edgeLoop", guardedEntry<&Wire::edgeLoop>("Wire.edgeLoop"));

    class_<Face>("Face")
        .class_function("inspectionTrimmedIso", guardedEntry<&Face::inspectionTrimmedIso>("Face.inspectionTrimmedIso"))
        .class_function("inspectionUVBounds", guardedEntry<&Face::inspectionUVBounds>("Face.inspectionUVBounds"))
        .class_function("inspectionRayHit", guardedEntry<&Face::inspectionRayHit>("Face.inspectionRayHit"))
        .class_function("area", guardedEntry<&Face::area>("Face.area"))
        .class_function("offset", guardedEntry<&Face::offset>("Face.offset"))
        .class_function("outerWire", guardedEntry<&Face::outerWire>("Face.outerWire"))
        .class_function("surface", guardedEntry<&Face::surface>("Face.surface"))
        .class_function("normal", guardedEntry<&Face::normal>("Face.normal"))
        .class_function("intersectLine", guardedEntry<&Face::intersectLine>("Face.intersectLine"))
        .class_function("curveOnSurface", guardedEntry<&Face::curveOnSurface>("Face.curveOnSurface"))
        .class_function("containsPoint", guardedEntry<&Face::containsPoint>("Face.containsPoint"));

    class_<Solid>("Solid")
        .class_function("containsPoint", guardedEntry<&Solid::containsPoint>("Solid.containsPoint"));
}
