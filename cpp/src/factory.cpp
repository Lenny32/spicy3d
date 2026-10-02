// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include "cornerSetback.hpp"
#include "faceValidation.hpp"
#include "guard.hpp"
#include "guidedLoftValidation.hpp"
#include "shared.hpp"
#include "utils.hpp"
#include <BOPAlgo_BuilderFace.hxx>
#include <BOPAlgo_Splitter.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeShape.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepFeat_MakePrism.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepLib_CheckCurveOnSurface.hxx>
#include <BRepOffsetAPI_MakePipe.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepOffset_Error.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <BRepOffset_Mode.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeSweep.hxx>
#include <BRepProj_Projection.hxx>
#include <BRepTools.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <ChFi2d_Builder.hxx>
#include <ChFi2d_ChamferAPI.hxx>
#include <ChFi2d_FilletAPI.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
#include <GeomProjLib.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_Line.hxx>
#include <Geom_OffsetCurve.hxx>
#include <Geom_Plane.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <HelixBRep_BuilderHelix.hxx>
#include <IntCurvesFace_ShapeIntersector.hxx>
#include <NCollection_Array1.hxx>
#include <NCollection_IndexedMap.hxx>
#include <Precision.hxx>
#include <ShapeAnalysis_Edge.hxx>
#include <ShapeFix_Edge.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_FixSmallFace.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_ShapeTolerance.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeFix_Wire.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <algorithm>
#include <cmath>
#include <deque>
#include <gp.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Lin.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Trsf.hxx>
#include <iomanip>
#include <memory>
#include <set>
#include <sstream>
#include <string>

using namespace emscripten;

struct ShapeResult {
    TopoDS_Shape shape;
    bool isOk;
    std::string error;
};

struct RemoveFilletResult {
    TopoDS_Shape shape;
    bool isOk;
    std::string error;
    ShapeArray newEdges;
};

struct ShapesResult {
    ShapeArray shapes;
    bool isOk;
    std::string error;
};

// Minimal bounded regions with per-region source identity: region k is bounded by
// segments of the input edges sourceIds[sum(counts<k) .. +counts[k]] (sorted, unique).
struct RegionsResult {
    ShapeArray faces;
    std::vector<int> sourceCounts;
    std::vector<int> sourceIds;
    bool isOk;
    std::string error;
};

struct TrackedShapeResult {
    TopoDS_Shape shape;
    bool isOk;
    std::string error;
    // output face/edge index (TopExp::MapShapes order) -> input index, -1 = new sub-shape
    std::vector<int> faceMap;
    std::vector<int> edgeMap;
    // output face index -> input edge index for faces Generated from an input edge
    // (a sweep's side faces), -1 = not edge-generated
    std::vector<int> faceEdgeMap = { };
    // Every (output, input) derivation as flat pairs (out0, in0, out1, in1, ...) — the
    // maps above keep only the FIRST ancestor; these keep them all, so a face MERGED
    // from several input faces records each of them. Filled for booleans only (merges
    // are a boolean phenomenon); empty for sweeps/fillets, where the maps suffice.
    std::vector<int> faceAncestors = { };
    std::vector<int> edgeAncestors = { };
    // Output face indexes (same MapShapes order as the maps) of a sweep's end cap —
    // BRepPrimAPI's LastShape(): a prism's top face, a PARTIAL revolve's end cap. A
    // separate channel on purpose: the cap must not go through faceMap's derivation
    // (it would claim the profile face's index and collide with the identical
    // bottom/start face). Empty for non-sweeps and for a full 360° revolve, where the
    // first and last shapes coincide and there is no distinct cap.
    std::vector<int> capFaces = { };
    int nextTargetIndex = -1;
    int nextFaceIndex = -1;
    // Pipe-shell ancestry uses section inputs first, then spine inputs,
    // separately for edges and vertices. These runtime channels retain BOTH
    // source roles.
    std::vector<int> pipeFaceEdges = { };
    std::vector<int> pipeFaceVertices = { };
    std::vector<int> pipeEdgeVertices = { };
    std::vector<int> pipeStartEdges = { };
    std::vector<int> pipeEndEdges = { };
    std::vector<int> pipeStartFaces = { };
};

// Error results of a raise caught by guardedEntry (guard.hpp).
CornerSetbackResult failedResult(GuardTag<CornerSetbackResult>, const std::string& error)
{
    return CornerSetback::failure(error);
}

ShapeResult failedResult(GuardTag<ShapeResult>, const std::string& error)
{
    return ShapeResult { TopoDS_Shape(), false, error };
}

RemoveFilletResult failedResult(GuardTag<RemoveFilletResult>, const std::string& error)
{
    return RemoveFilletResult { TopoDS_Shape(), false, error, ShapeArray(val::array()) };
}

ShapesResult failedResult(GuardTag<ShapesResult>, const std::string& error)
{
    return ShapesResult { ShapeArray(val::array()), false, error };
}

RegionsResult failedResult(GuardTag<RegionsResult>, const std::string& error)
{
    return RegionsResult { ShapeArray(val::array()), { }, { }, false, error };
}

TrackedShapeResult failedResult(GuardTag<TrackedShapeResult>, const std::string& error)
{
    TrackedShapeResult result { };
    result.isOk = false;
    result.error = error;
    return result;
}

// Marks output sub-shapes identical to or derived (Modified/Generated — guarded, some
// algorithms only implement Generated) from `inShape` with its input index. The map keeps
// the first ancestor per output; `ancestors` (when given) records every derivation, so a
// merge of several inputs into one output is fully preserved.
static void mapInputShape(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& inShape, int inIndex,
    const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& outMap, std::vector<int>& map,
    std::vector<int>* ancestors)
{
    auto markDerived = [&](const NCollection_List<TopoDS_Shape>& derived) {
        for (const TopoDS_Shape& shape : derived) {
            int outIndex = outMap.FindIndex(shape);
            if (outIndex > 0) {
                if (map[outIndex - 1] < 0) {
                    map[outIndex - 1] = inIndex;
                }
                if (ancestors != nullptr) {
                    ancestors->push_back(outIndex - 1);
                    ancestors->push_back(inIndex);
                }
            }
        }
    };
    int identical = outMap.FindIndex(inShape);
    if (identical > 0) {
        if (map[identical - 1] < 0) {
            map[identical - 1] = inIndex;
        }
        if (ancestors != nullptr) {
            ancestors->push_back(identical - 1);
            ancestors->push_back(inIndex);
        }
    }
    try {
        markDerived(algo.Modified(inShape));
    } catch (const Standard_Failure&) {
    }
    try {
        markDerived(algo.Generated(inShape));
    } catch (const Standard_Failure&) {
    }
}

// Maps each output sub-shape of `type` to the input sub-shape it derives from (identity
// first — some algorithms keep input shapes as-is, e.g. the prism bottom face).
// Sub-shapes without an input origin keep -1. When `ancestors` is given it additionally
// receives every (output, input) derivation as flat pairs — including derivations the
// returned map dropped as non-first ancestors.
static std::vector<int> shapeHistory(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& input,
    const TopoDS_Shape& output, TopAbs_ShapeEnum type, std::vector<int>* ancestors = nullptr)
{
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> inMap;
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> outMap;
    TopExp::MapShapes(input, type, inMap);
    TopExp::MapShapes(output, type, outMap);
    std::vector<int> map(outMap.Extent(), -1);
    for (int i = 1; i <= inMap.Extent(); i++) {
        mapInputShape(algo, inMap.FindKey(i), i - 1, outMap, map, ancestors);
    }
    return map;
}

static std::vector<int> faceHistory(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& input,
    const TopoDS_Shape& output, std::vector<int>* ancestors = nullptr)
{
    return shapeHistory(algo, input, output, TopAbs_FACE, ancestors);
}

static std::vector<int> edgeHistory(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& input,
    const TopoDS_Shape& output, std::vector<int>* ancestors = nullptr)
{
    return shapeHistory(algo, input, output, TopAbs_EDGE, ancestors);
}

// Maps each output face Generated from an input edge (a prism/revol side face) to that
// edge's input index, so the caller can seed the side face with the edge's stable id —
// face enumeration order is not stable across rebuilds, the generating edge is.
// Faces without an edge origin keep -1.
static std::vector<int> faceFromEdgeHistory(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& input,
    const TopoDS_Shape& output)
{
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> inEdges;
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> outFaces;
    TopExp::MapShapes(input, TopAbs_EDGE, inEdges);
    TopExp::MapShapes(output, TopAbs_FACE, outFaces);
    std::vector<int> map(outFaces.Extent(), -1);
    for (int i = 1; i <= inEdges.Extent(); i++) {
        try {
            for (const TopoDS_Shape& generated : algo.Generated(inEdges.FindKey(i))) {
                int outIndex = outFaces.FindIndex(generated);
                if (outIndex > 0 && map[outIndex - 1] < 0) {
                    map[outIndex - 1] = i - 1;
                }
            }
        } catch (const Standard_Failure&) {
        }
    }
    return map;
}

// Face indexes (MapShapes order on `output`, matching the history maps) of a sweep's
// end shape — BRepPrimAPI's LastShape(): a prism's top face, a partial revolve's end
// cap. Empty when the sweep has no distinct end shape: a null LastShape (degenerate
// input) or a full 360° revolve, whose first and last shapes coincide (LastShape
// returns the start shape there, so the IsSame check filters it out). Faces of the
// end shape that are not in the output are skipped.
static std::vector<int> sweepCapFaces(BRepPrimAPI_MakeSweep& sweep, const TopoDS_Shape& output)
{
    std::vector<int> capFaces;
    const TopoDS_Shape lastShape = sweep.LastShape();
    if (lastShape.IsNull() || lastShape.IsSame(sweep.FirstShape())) {
        return capFaces;
    }
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> outFaces;
    TopExp::MapShapes(output, TopAbs_FACE, outFaces);
    for (TopExp_Explorer explorer(lastShape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        int outIndex = outFaces.FindIndex(explorer.Current());
        if (outIndex > 0) {
            capFaces.push_back(outIndex - 1);
        }
    }
    return capFaces;
}

// ---- Bounded prisms: up to a face / through all ---------------------------------------
//
// A bounded prism is built as a TOOL solid — a long BRepPrimAPI prism split by the bounding
// surface (BRepAlgoAPI_Splitter), keeping the piece that holds the profile — which the caller
// combines with the body through the tracked booleans, exactly like a blind extrude. Its
// history channels stay profile-relative (faceMap / edgeMap / faceEdgeMap as prismTracked),
// with the cap (the piece of the bounding surface) in capFaces, so sketch-seeded ids survive
// any change of the target (a resized cube keeps the same ids).
//
// BRepFeat_MakePrism::Perform(Until) / PerformThruAll was evaluated and not used: it fuses or
// cuts inside the feature, so its history mixes base and profile derivations (no clean
// profile-relative channels), it controls the until-face extension itself (the face must
// fully intercept the profile, no fallback), and its LocOpe internals raise in paths that
// cannot be pre-checked (caught by guardedEntry now, but as an unexplained failure).

using ShapeIndexMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;

// Direction vectors below this magnitude (or not finite) are rejected before gp_Dir, whose
// constructor raises on a null vector.
static bool isUsableDirection(const Vector3& v)
{
    double magnitude = std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    return std::isfinite(magnitude) && magnitude > Precision::Confusion();
}

// Range of `shape` projected on `dir` (coordinates of dir from the origin). The shape is
// rotated so dir becomes Z and boxed exactly (AddOptimal, no triangulation), which stays
// tight for any direction — an axis-aligned box projected on a slanted dir would not.
static bool projectedRange(const TopoDS_Shape& shape, const gp_Dir& dir, double& low, double& high)
{
    if (shape.IsNull()) {
        return false;
    }
    gp_Trsf toLocal;
    toLocal.SetTransformation(gp_Ax3(gp::Origin(), dir));
    Bnd_Box box;
    BRepBndLib::AddOptimal(shape.Moved(TopLoc_Location(toLocal)), box, false, false);
    if (box.IsVoid()) {
        return false;
    }
    double xmin, ymin, zmin, xmax, ymax, zmax;
    box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    low = zmin;
    high = zmax;
    return true;
}

static bool boxOf(const TopoDS_Shape& shape, Bnd_Box& box)
{
    BRepBndLib::AddOptimal(shape, box, false, false);
    return !box.IsVoid();
}

static Handle(Geom_Surface) untrimmedSurface(Handle(Geom_Surface) surface)
{
    Handle(Geom_RectangularTrimmedSurface) trimmed = Handle(Geom_RectangularTrimmedSurface)::DownCast(surface);
    while (!trimmed.IsNull()) {
        surface = trimmed->BasisSurface();
        trimmed = Handle(Geom_RectangularTrimmedSurface)::DownCast(surface);
    }
    return surface;
}

// Validates the profile of a bounded prism: faces with a surface, none lying along `dir`
// (a prism along its own plane has no volume). Returns the error, empty when valid.
static std::string profileError(const TopoDS_Shape& profile, const gp_Dir& dir)
{
    if (profile.IsNull()) {
        return "The profile is empty";
    }
    bool hasFace = false;
    for (TopExp_Explorer explorer(profile, TopAbs_FACE); explorer.More(); explorer.Next()) {
        hasFace = true;
        Handle(Geom_Surface) surface = BRep_Tool::Surface(TopoDS::Face(explorer.Current()));
        if (surface.IsNull()) {
            return "The profile face has no surface";
        }
        Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(untrimmedSurface(surface));
        if (!plane.IsNull() && std::abs(plane->Pln().Axis().Direction().Dot(dir)) < 1e-6) {
            return "The extrude direction lies in the profile plane";
        }
    }
    return hasFace ? "" : "The profile has no face";
}

// True when a prism along `dir` can never cross `surface`: a plane containing dir, or a
// cylinder whose axis is dir.
static bool isParallelTo(const Handle(Geom_Surface) & surface, const gp_Dir& dir)
{
    Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(surface);
    if (!plane.IsNull()) {
        return std::abs(plane->Pln().Axis().Direction().Dot(dir)) < 1e-6;
    }
    Handle(Geom_CylindricalSurface) cylinder = Handle(Geom_CylindricalSurface)::DownCast(surface);
    if (!cylinder.IsNull()) {
        return std::abs(cylinder->Axis().Direction().Dot(dir)) > 1.0 - 1e-9;
    }
    return false;
}

// The face's surface untrimmed: periodic directions over one full period, infinite ones
// (a plane, a cylinder's axis) extended by `margin` past the face's own UV range, finite
// natural bounds (a sphere, a B-spline patch) kept; a cone stops at its apex. Null when the
// face cannot be rebuilt.
static TopoDS_Face extendedFace(const TopoDS_Face& face, double margin)
{
    Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
    if (surface.IsNull()) {
        return TopoDS_Face();
    }
    surface = untrimmedSurface(surface);
    double u1, u2, v1, v2;
    surface->Bounds(u1, u2, v1, v2);
    double fu1, fu2, fv1, fv2;
    BRepTools::UVBounds(face, fu1, fu2, fv1, fv2);
    if (surface->IsUPeriodic()) {
        u1 = fu1;
        u2 = fu1 + surface->UPeriod();
    } else {
        u1 = Precision::IsInfinite(u1) ? fu1 - margin : u1;
        u2 = Precision::IsInfinite(u2) ? fu2 + margin : u2;
    }
    if (surface->IsVPeriodic()) {
        v1 = fv1;
        v2 = fv1 + surface->VPeriod();
    } else {
        v1 = Precision::IsInfinite(v1) ? fv1 - margin : v1;
        v2 = Precision::IsInfinite(v2) ? fv2 + margin : v2;
    }
    Handle(Geom_ConicalSurface) cone = Handle(Geom_ConicalSurface)::DownCast(surface);
    if (!cone.IsNull()) {
        double sine = std::sin(cone->SemiAngle());
        if (std::abs(sine) > Precision::Angular()) {
            double apex = -cone->RefRadius() / sine;
            if (sine > 0) {
                v1 = std::max(v1, apex);
            } else {
                v2 = std::min(v2, apex);
            }
        }
    }
    if (!(u2 - u1 > Precision::PConfusion()) || !(v2 - v1 > Precision::PConfusion())) {
        return TopoDS_Face();
    }
    BRepBuilderAPI_MakeFace makeFace(surface, u1, u2, v1, v2, Precision::Confusion());
    return makeFace.IsDone() ? makeFace.Face() : TopoDS_Face();
}

// Output indexes (MapShapes order of `outMap`) of `shape` after `algo`: itself when kept
// as is, plus what it was modified into.
static std::vector<int> imagesOf(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& shape, const ShapeIndexMap& outMap)
{
    std::vector<int> images;
    int identical = outMap.FindIndex(shape);
    if (identical > 0) {
        images.push_back(identical - 1);
    }
    try {
        for (const TopoDS_Shape& modified : algo.Modified(shape)) {
            int index = outMap.FindIndex(modified);
            if (index > 0) {
                images.push_back(index - 1);
            }
        }
    } catch (const Standard_Failure&) {
    }
    return images;
}

// Carries a history map over `stage`'s sub-shapes (e.g. the prism's faceMap) through `algo`
// onto `output`'s sub-shapes of `type`: an output piece takes the value of the stage
// sub-shape it is (or was modified from); pieces without a mapped origin keep -1.
static std::vector<int> composeHistory(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& stage,
    const std::vector<int>& stageMap, const TopoDS_Shape& output, TopAbs_ShapeEnum type)
{
    ShapeIndexMap stageShapes;
    ShapeIndexMap outShapes;
    TopExp::MapShapes(stage, type, stageShapes);
    TopExp::MapShapes(output, type, outShapes);
    std::vector<int> map(outShapes.Extent(), -1);
    int count = std::min(stageShapes.Extent(), static_cast<int>(stageMap.size()));
    for (int i = 1; i <= count; i++) {
        if (stageMap[i - 1] < 0) {
            continue;
        }
        for (int index : imagesOf(algo, stageShapes.FindKey(i), outShapes)) {
            if (map[index] < 0) {
                map[index] = stageMap[i - 1];
            }
        }
    }
    return map;
}

static std::set<int> faceImagesOf(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& shape, const ShapeIndexMap& outFaces)
{
    std::set<int> images;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        for (int index : imagesOf(algo, explorer.Current(), outFaces)) {
            images.insert(index);
        }
    }
    return images;
}

static bool solidHasAny(const TopoDS_Shape& solid, const ShapeIndexMap& allFaces, const std::set<int>& faces)
{
    for (TopExp_Explorer explorer(solid, TopAbs_FACE); explorer.More(); explorer.Next()) {
        int index = allFaces.FindIndex(explorer.Current());
        if (index > 0 && faces.count(index - 1) > 0) {
            return true;
        }
    }
    return false;
}

// Sweeps `profile` by `vec` and splits the prism by `tool`, keeping the solids on the profile
// side: an image of the prism's start face and of the tool, none of its end face. isOk is
// false with an EMPTY error when the tool does not bound the prism (misses it or only
// notches it) — the caller may retry with a larger tool — and with a message on a failure.
static TrackedShapeResult boundedPrism(const TopoDS_Shape& profile, const gp_Vec& vec, const TopoDS_Face& tool)
{
    BRepPrimAPI_MakePrism prism(profile, vec);
    if (!prism.IsDone()) {
        return TrackedShapeResult { TopoDS_Shape(), false, "Failed to create prism", { }, { } };
    }
    const TopoDS_Shape swept = prism.Shape();
    const TopoDS_Shape startShape = prism.FirstShape();
    const TopoDS_Shape endShape = prism.LastShape();
    if (swept.IsNull() || startShape.IsNull() || endShape.IsNull()) {
        return TrackedShapeResult { TopoDS_Shape(), false, "Failed to create prism", { }, { } };
    }

    BRepAlgoAPI_Splitter splitter;
    NCollection_List<TopoDS_Shape> arguments;
    NCollection_List<TopoDS_Shape> tools;
    arguments.Append(swept);
    tools.Append(tool);
    splitter.SetArguments(arguments);
    splitter.SetTools(tools);
    splitter.SetNonDestructive(true);
    splitter.Build();
    if (!splitter.IsDone() || splitter.HasErrors() || splitter.Shape().IsNull()) {
        return TrackedShapeResult { TopoDS_Shape(), false, "Failed to split the prism by the target face", { }, { } };
    }

    const TopoDS_Shape split = splitter.Shape();
    ShapeIndexMap splitFaces;
    TopExp::MapShapes(split, TopAbs_FACE, splitFaces);
    std::set<int> startFaces = faceImagesOf(splitter, startShape, splitFaces);
    std::set<int> endFaces = faceImagesOf(splitter, endShape, splitFaces);
    std::set<int> toolFaces = faceImagesOf(splitter, tool, splitFaces);

    std::vector<TopoDS_Shape> kept;
    for (TopExp_Explorer explorer(split, TopAbs_SOLID); explorer.More(); explorer.Next()) {
        const TopoDS_Shape& solid = explorer.Current();
        if (solidHasAny(solid, splitFaces, startFaces) && solidHasAny(solid, splitFaces, toolFaces)
            && !solidHasAny(solid, splitFaces, endFaces)) {
            kept.push_back(solid);
        }
    }
    if (kept.empty()) {
        return TrackedShapeResult { TopoDS_Shape(), false, "", { }, { } };
    }
    TopoDS_Shape output = kept.front();
    if (kept.size() > 1) {
        TopoDS_Compound compound;
        BRep_Builder builder;
        builder.MakeCompound(compound);
        for (const TopoDS_Shape& solid : kept) {
            builder.Add(compound, solid);
        }
        output = compound;
    }

    TrackedShapeResult result { output, true, "",
        composeHistory(splitter, swept, faceHistory(prism, profile, swept), output, TopAbs_FACE),
        composeHistory(splitter, swept, edgeHistory(prism, profile, swept), output, TopAbs_EDGE),
        composeHistory(splitter, swept, faceFromEdgeHistory(prism, profile, swept), output, TopAbs_FACE) };
    ShapeIndexMap outFaces;
    TopExp::MapShapes(output, TopAbs_FACE, outFaces);
    for (int index : faceImagesOf(splitter, tool, outFaces)) {
        result.capFaces.push_back(index);
    }
    return result;
}

static TrackedShapeResult trackedError(const std::string& error)
{
    return TrackedShapeResult { TopoDS_Shape(), false, error, { }, { } };
}

// A witness selects a split cell; the complete bounding faces, never this point, make its caps.
static bool profileWitness(const TopoDS_Face& profile, gp_Pnt& witness)
{
    Handle(Geom_Surface) surface = BRep_Tool::Surface(profile);
    double u0, u1, v0, v1;
    BRepTools::UVBounds(profile, u0, u1, v0, v1);
    for (int i = 0; i < 121; i++) {
        double u = i == 0 ? (u0 + u1) / 2 : u0 + (u1 - u0) * ((i - 1) % 11 + 0.5) / 11;
        double v = i == 0 ? (v0 + v1) / 2 : v0 + (v1 - v0) * ((i - 1) / 11 + 0.5) / 11;
        BRepClass_FaceClassifier classifier(profile, gp_Pnt2d(u, v), Precision::Confusion());
        if (classifier.State() == TopAbs_IN) {
            witness = surface->Value(u, v);
            return true;
        }
    }
    return false;
}

static std::vector<double> rayParameters(const TopoDS_Face& face, const gp_Pnt& origin, const gp_Dir& dir, double reach)
{
    IntCurvesFace_ShapeIntersector intersections;
    intersections.Load(face, Precision::Confusion());
    intersections.Perform(gp_Lin(origin, dir), -reach, reach);
    std::vector<double> values;
    if (!intersections.IsDone())
        return values;
    for (int i = 1; i <= intersections.NbPnt(); i++)
        values.push_back(intersections.WParameter(i));
    std::sort(values.begin(), values.end());
    values.erase(std::unique(values.begin(), values.end(), [](double a, double b) {
        return std::abs(a - b) <= Precision::Confusion();
    }),
        values.end());
    return values;
}

// Split a generous planar-profile prism by BOTH limiting surfaces. Its projected footprint
// stays the sketch's; the cell containing the selected branch witness has exact curved caps.
static TrackedShapeResult prismBetweenFaces(const TopoDS_Face& profile, const gp_Dir& dir,
    const TopoDS_Face& from, const TopoDS_Face& until, double exactDepth = 0, bool strictEnd = false)
{
    Bnd_Box scene;
    double profileLow, profileHigh, fromLow, fromHigh, untilLow, untilHigh;
    if (!boxOf(profile, scene) || !boxOf(from, scene) || !boxOf(until, scene)
        || !projectedRange(profile, dir, profileLow, profileHigh)
        || !projectedRange(from, dir, fromLow, fromHigh) || !projectedRange(until, dir, untilLow, untilHigh))
        return trackedError("The starting face or profile has no extent");
    double margin = 2 * std::sqrt(scene.SquareExtent()) + 1;
    gp_Pnt origin;
    if (!profileWitness(profile, origin))
        return trackedError("The profile has no interior witness");
    double low = std::min({ profileLow, fromLow, untilLow }) - margin;
    double high = std::max({ profileHigh, fromHigh, untilHigh }) + margin;
    gp_Trsf shift;
    shift.SetTranslation(gp_Vec(dir) * (low - profileLow));
    TopoDS_Shape proxy = profile.Moved(TopLoc_Location(shift));
    BRepPrimAPI_MakePrism prism(proxy, gp_Vec(dir) * (high - low));
    if (!prism.IsDone())
        return trackedError("Failed to create the from-face prism");
    const TopoDS_Shape swept = prism.Shape();

    for (int pass = 0; pass < (strictEnd ? 1 : 2); pass++) {
        // The picked starting patch must cover the profile; extending it could silently
        // create a boss outside the selected face. Only an up-to ending surface may extend.
        TopoDS_Face start = from;
        TopoDS_Face end = pass == 0 || strictEnd || exactDepth > 0 ? until : extendedFace(until, margin);
        if (start.IsNull() || end.IsNull())
            continue;
        auto starts = rayParameters(start, origin, dir, 2 * (high - low));
        auto ends = rayParameters(end, origin, dir, 2 * (high - low));
        if (starts.empty() || ends.empty())
            continue;
        // Prefer the first forward hit; when the sketch lies beyond the surface, the nearest
        // backward hit selects the wall. Equal geometric hits were deduplicated above.
        auto forward = std::find_if(starts.begin(), starts.end(), [](double t) { return t >= -Precision::Confusion(); });
        double fromT = forward == starts.end() ? starts.back() : *forward;
        double endT = 0;
        if (exactDepth > 0)
            endT = fromT + exactDepth;
        else {
            auto beyond = std::find_if(ends.begin(), ends.end(), [fromT](double t) { return t > fromT + Precision::Confusion(); });
            if (beyond == ends.end())
                continue;
            endT = *beyond;
        }
        gp_Pnt witness = origin.Translated(gp_Vec(dir) * ((fromT + endT) / 2));
        BRepAlgoAPI_Splitter splitter;
        NCollection_List<TopoDS_Shape> arguments, tools;
        arguments.Append(swept);
        tools.Append(start);
        tools.Append(end);
        splitter.SetArguments(arguments);
        splitter.SetTools(tools);
        splitter.SetNonDestructive(true);
        splitter.Build();
        if (!splitter.IsDone() || splitter.HasErrors() || splitter.Shape().IsNull())
            continue;
        ShapeIndexMap splitFaces;
        TopExp::MapShapes(splitter.Shape(), TopAbs_FACE, splitFaces);
        auto fromImages = faceImagesOf(splitter, start, splitFaces);
        auto untilImages = faceImagesOf(splitter, end, splitFaces);
        auto originalStart = faceImagesOf(splitter, prism.FirstShape(), splitFaces);
        auto originalEnd = faceImagesOf(splitter, prism.LastShape(), splitFaces);
        std::vector<TopoDS_Shape> kept;
        for (TopExp_Explorer it(splitter.Shape(), TopAbs_SOLID); it.More(); it.Next()) {
            const TopoDS_Shape& solid = it.Current();
            if (!solidHasAny(solid, splitFaces, fromImages) || !solidHasAny(solid, splitFaces, untilImages)
                || solidHasAny(solid, splitFaces, originalStart) || solidHasAny(solid, splitFaces, originalEnd))
                continue;
            BRepClass3d_SolidClassifier classifier(solid, witness, Precision::Confusion());
            if (classifier.State() == TopAbs_IN || classifier.State() == TopAbs_ON)
                kept.push_back(solid);
        }
        if (kept.size() > 1)
            return trackedError("The starting face has ambiguous extrusion intersections");
        if (kept.empty())
            continue;
        const TopoDS_Shape output = kept.front();
        if (!BRepCheck_Analyzer(output).IsValid())
            continue;
        // For translated bounding surfaces the exact volume is projected profile area * depth.
        // This rejects a cap that only intercepted part of the profile without approximating it.
        if (exactDepth > 0) {
            GProp_GProps area, volume;
            BRepGProp::SurfaceProperties(profile, area);
            BRepGProp::VolumeProperties(output, volume);
            Handle(Geom_Plane) profilePlane = Handle(Geom_Plane)::DownCast(
                untrimmedSurface(BRep_Tool::Surface(profile)));
            double expected = area.Mass() * std::abs(profilePlane->Pln().Axis().Direction().Dot(dir)) * exactDepth;
            if (std::abs(std::abs(volume.Mass()) - expected) > 1e-6 * std::max(1.0, expected))
                continue;
        }
        TrackedShapeResult result { output, true, "",
            composeHistory(splitter, swept, faceHistory(prism, proxy, swept), output, TopAbs_FACE),
            composeHistory(splitter, swept, edgeHistory(prism, proxy, swept), output, TopAbs_EDGE),
            composeHistory(splitter, swept, faceFromEdgeHistory(prism, proxy, swept), output, TopAbs_FACE) };
        ShapeIndexMap faces, edges;
        TopExp::MapShapes(output, TopAbs_FACE, faces);
        TopExp::MapShapes(output, TopAbs_EDGE, edges);
        auto bottom = faceImagesOf(splitter, start, faces);
        for (int index : bottom)
            result.faceMap[index] = 0;
        for (int index : faceImagesOf(splitter, end, faces))
            result.capFaces.push_back(index);
        // Intersection edges no longer contain the proxy's original edges. Recover each curved
        // bottom edge from its uniquely seeded side face, retaining the sketch entity's identity.
        for (int e = 1; e <= edges.Extent(); e++) {
            bool onBottom = false;
            std::set<int> origins;
            for (int f = 1; f <= faces.Extent(); f++) {
                bool adjacent = false;
                for (TopExp_Explorer it(faces.FindKey(f), TopAbs_EDGE); it.More(); it.Next())
                    if (it.Current().IsSame(edges.FindKey(e))) {
                        adjacent = true;
                        break;
                    }
                if (!adjacent)
                    continue;
                if (bottom.count(f - 1))
                    onBottom = true;
                if (result.faceEdgeMap[f - 1] >= 0)
                    origins.insert(result.faceEdgeMap[f - 1]);
            }
            if (onBottom && origins.size() == 1)
                result.edgeMap[e - 1] = *origins.begin();
        }
        return result;
    }
    return trackedError("The starting and ending faces do not fully bound the extrusion, or their intersections are ambiguous");
}

// Project exact cap boundary curves along the extrusion axis onto the profile plane. This
// proves full footprint coverage even when two curved caps have no common axial section.
static bool capCoversProfile(const TrackedShapeResult& tool, const TopoDS_Face& profile, const gp_Dir& dir, std::string& failure)
{
    Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(untrimmedSurface(BRep_Tool::Surface(profile)));
    auto fail = [&](const char* reason) { failure = reason; return false; };
    if (plane.IsNull())
        return fail("Profile projection plane is unavailable");
    ShapeIndexMap faces;
    TopExp::MapShapes(tool.shape, TopAbs_FACE, faces);
    TopoDS_Shape shadow;
    double piecesArea = 0;
    for (int index : tool.capFaces) {
        const TopoDS_Face cap = TopoDS::Face(faces.FindKey(index + 1));
        const TopoDS_Wire outer = BRepTools::OuterWire(cap);

        auto projectWire = [&](const TopoDS_Wire& wire) -> TopoDS_Wire {
            BRepBuilderAPI_MakeWire makeWire;
            for (BRepTools_WireExplorer edges(wire, cap); edges.More(); edges.Next()) {
                const TopoDS_Edge edge = edges.Current();
                double first, last;
                Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, first, last);
                if (curve.IsNull())
                    continue;
                // Bound the curve before projection: parameter-preserving tilted lines otherwise
                // become splines over an infinite domain and lose endpoint precision.
                Handle(Geom_TrimmedCurve) bounded = new Geom_TrimmedCurve(curve, first, last);
                Handle(Geom_Curve) projected = GeomProjLib::ProjectOnPlane(bounded, plane, dir, true);
                if (projected.IsNull()) {
                    failure = "Cap curve projection failed";
                    return TopoDS_Wire();
                }
                BRepBuilderAPI_MakeEdge makeEdge(projected);
                if (!makeEdge.IsDone()) {
                    failure = "Projected cap edge is invalid";
                    return TopoDS_Wire();
                }
                TopoDS_Edge next = makeEdge.Edge();
                GProp_GProps length;
                BRepGProp::LinearProperties(next, length);
                if (length.Mass() <= Precision::Confusion())
                    continue;
                next.Orientation(edge.Orientation());
                makeWire.Add(next);
                if (!makeWire.IsDone()) {
                    failure = "Projected cap edges do not connect";
                    return TopoDS_Wire();
                }
            }
            return makeWire.IsDone() ? makeWire.Wire() : TopoDS_Wire();
        };
        TopoDS_Wire projectedOuter = projectWire(outer);
        if (projectedOuter.IsNull())
            return fail(failure.empty() ? "Projected cap outer wire is empty" : failure.c_str());
        BRepBuilderAPI_MakeFace makeFace(plane->Pln(), projectedOuter, true);
        for (TopExp_Explorer wires(cap, TopAbs_WIRE); wires.More(); wires.Next()) {
            if (wires.Current().IsSame(outer))
                continue;
            TopoDS_Wire inner = projectWire(TopoDS::Wire(wires.Current()));
            if (inner.IsNull())
                return fail("Projected cap inner wire is invalid");
            makeFace.Add(inner);
        }
        if (!makeFace.IsDone() || !BRepCheck_Analyzer(makeFace.Face()).IsValid())
            return fail("Projected cap face is invalid");
        GProp_GProps area;
        BRepGProp::SurfaceProperties(makeFace.Face(), area);
        piecesArea += std::abs(area.Mass());
        if (shadow.IsNull())
            shadow = makeFace.Face();
        else {
            BRepAlgoAPI_Fuse merge(shadow, makeFace.Face());
            merge.SetNonDestructive(true);
            merge.Build();
            if (!merge.IsDone() || merge.HasErrors())
                return fail("Projected cap union failed");
            shadow = merge.Shape();
        }
    }
    if (shadow.IsNull())
        return fail("The bounded tool has no ending cap history");
    GProp_GProps footprint, unionArea, commonArea;
    BRepGProp::SurfaceProperties(profile, footprint);
    BRepGProp::SurfaceProperties(shadow, unionArea);
    const double tolerance = 1e-6 * std::max(1.0, std::abs(footprint.Mass()));
    // Folded caps can project multiple layers onto the same footprint: explicitly unsupported.
    if (std::abs(piecesArea - std::abs(unionArea.Mass())) > tolerance)
        return fail("The ending cap folds across its projected footprint");
    BRepAlgoAPI_Common common(shadow, profile);
    common.SetNonDestructive(true);
    common.Build();
    if (!common.IsDone() || common.HasErrors())
        return fail("Projected footprint intersection failed");
    BRepGProp::SurfaceProperties(common.Shape(), commonArea);
    if (std::abs(std::abs(commonArea.Mass()) - std::abs(footprint.Mass())) > tolerance)
        return fail("The ending cap does not cover the full profile footprint");
    return true;
}

// Conservative bounds pruning in the extrusion's transverse plane, preserving candidate order.
static bool intersectsProfileRayBounds(const TopoDS_Shape& profile, const TopoDS_Shape& target,
    const gp_Dir& dir, double startLow)
{
    gp_Ax2 axes(gp_Pnt(0, 0, 0), dir);
    auto range = [](const TopoDS_Shape& shape, const gp_Dir& axis, double& low, double& high) {
        return projectedRange(shape, axis, low, high);
    };
    double low, high;
    if (!range(target, dir, low, high) || high <= startLow + Precision::Confusion())
        return false;
    for (const gp_Dir& axis : { axes.XDirection(), axes.YDirection() }) {
        double profileLow, profileHigh;
        if (!range(profile, axis, profileLow, profileHigh) || !range(target, axis, low, high))
            return false;
        if (high < profileLow - Precision::Confusion() || low > profileHigh + Precision::Confusion())
            return false;
    }
    return true;
}

// Compute the plane formed by two edges at their shared vertex from their tangent vectors.
static std::optional<gp_Dir> computeNormal(const TopoDS_Edge& edge1, const TopoDS_Edge& edge2, const TopoDS_Vertex& vertex)
{
    double p1 = BRep_Tool::Parameter(vertex, edge1);
    double p2 = BRep_Tool::Parameter(vertex, edge2);

    double cf, cl;
    Handle(Geom_Curve) curve1 = BRep_Tool::Curve(edge1, cf, cl);
    Handle(Geom_Curve) curve2 = BRep_Tool::Curve(edge2, cf, cl);

    gp_Pnt pt;
    gp_Vec tan1, tan2;
    curve1->D1(p1, pt, tan1);
    curve2->D1(p2, pt, tan2);

    gp_Vec normal = tan1.Crossed(tan2);
    if (normal.Magnitude() < Precision::Angular()) {
        return std::nullopt;
    }

    return gp_Dir(normal);
}

// Find the common vertex shared by two edges. Returns null if none.
static TopoDS_Vertex findCommonVertex(const TopoDS_Edge& edge1, const TopoDS_Edge& edge2)
{
    TopExp_Explorer v1(edge1, TopAbs_VERTEX);
    for (; v1.More(); v1.Next()) {
        auto vertex1 = v1.Current();
        TopExp_Explorer v2(edge2, TopAbs_VERTEX);
        for (; v2.More(); v2.Next()) {
            if (vertex1.IsSame(v2.Current())) {
                return TopoDS::Vertex(vertex1);
            }
        }
    }
    return TopoDS_Vertex();
}

// Build a JS array [edge1, edge2, edge3] from three edges.
static val buildEdgeTriple(const TopoDS_Edge& a, const TopoDS_Edge& b, const TopoDS_Edge& c)
{
    val edges = val::array();
    edges.call<void>("push", a);
    edges.call<void>("push", b);
    edges.call<void>("push", c);
    return edges;
}

// Line equivalent of a curve, unwrapping trimmed and offset curves (an offset of a line
// is the same line translated, with the same parametrization). Null when not linear.
static Handle(Geom_Line) asLine(const Handle(Geom_Curve) & curve)
{
    if (auto trimmed = Handle(Geom_TrimmedCurve)::DownCast(curve))
        return asLine(trimmed->BasisCurve());
    if (auto line = Handle(Geom_Line)::DownCast(curve))
        return line;
    if (auto offset = Handle(Geom_OffsetCurve)::DownCast(curve)) {
        if (auto basisLine = asLine(offset->BasisCurve())) {
            gp_Vec shift(basisLine->Value(0.0), offset->Value(0.0));
            return new Geom_Line(
                gp_Lin(basisLine->Lin().Location().Translated(shift), basisLine->Lin().Direction()));
        }
    }
    return nullptr;
}

// The curve underlying an edge with its parameter range, unwrapping trimmed curves. An
// offset of a line is replaced by the equivalent plain line, so that fillet/chamfer
// operate at the offset position instead of the pre-offset one.
static Handle(Geom_Curve) basisCurve(const TopoDS_Edge& edge, double& first, double& last)
{
    Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, first, last);
    if (auto line = asLine(curve))
        return line;
    if (auto trimmed = Handle(Geom_TrimmedCurve)::DownCast(curve))
        curve = trimmed->BasisCurve();
    return curve;
}

struct CornerPlane {
    gp_Pnt point; // intersection of the two support lines
    gp_Dir normal; // normal of the plane containing both edges
    double param1 = 0.0; // corner parameter on the first support line
    double param2 = 0.0; // corner parameter on the second support line
};

// Compute the corner reference point and the plane for a 2D fillet/chamfer between two
// edges. Only straight edges are supported: they must be coplanar and non-parallel, and
// the corner is the intersection of their support lines, which need not lie on the
// edges themselves.
static std::optional<CornerPlane> computeCornerPlane(const TopoDS_Edge& edge1, const TopoDS_Edge& edge2,
    std::string& error)
{
    double f, l;
    Handle(Geom_Line) line1 = Handle(Geom_Line)::DownCast(basisCurve(edge1, f, l));
    Handle(Geom_Line) line2 = Handle(Geom_Line)::DownCast(basisCurve(edge2, f, l));
    if (line1.IsNull() || line2.IsNull()) {
        error = "Edges must be Line";
        return std::nullopt;
    }

    gp_Vec d1(line1->Lin().Direction());
    gp_Vec d2(line2->Lin().Direction());
    gp_Vec normal = d1.Crossed(d2);
    if (normal.Magnitude() < Precision::Angular()) {
        error = "Edges must not be parallel";
        return std::nullopt;
    }

    gp_Vec p12(line1->Lin().Location(), line2->Lin().Location());
    if (std::abs(p12.Dot(normal) / normal.Magnitude()) > Precision::Confusion()) {
        error = "Edges must be coplanar";
        return std::nullopt;
    }

    // intersection of the support lines: p12 = t1 * d1 - t2 * d2, solved by crossing with d2 and d1 respectively
    double denom = normal.SquareMagnitude();
    double t1 = p12.Crossed(d2).Dot(normal) / denom;
    double t2 = p12.Crossed(d1).Dot(normal) / denom;
    return CornerPlane { line1->Lin().Location().Translated(d1.Multiplied(t1)), gp_Dir(normal), t1, t2 };
}

// Build an edge whose range covers the corner parameter p. When p cuts the edge in two,
// only the longer side is kept, so that fillets/chamfers consume the shorter side; when p
// lies outside, the edge is extended up to p (OCCT fillets can trim but never prolongate).
static TopoDS_Edge edgeThroughCorner(const Handle(Geom_Curve) & basis, double first, double last, double p)
{
    if (p > first && p < last) {
        return p - first >= last - p ? BRepBuilderAPI_MakeEdge(basis, first, p).Edge()
                                     : BRepBuilderAPI_MakeEdge(basis, p, last).Edge();
    }
    return BRepBuilderAPI_MakeEdge(basis, std::min(first, p), std::max(last, p)).Edge();
}

// Endpoints of an edge, evaluated on its underlying curve.
static void edgeEndPoints(const TopoDS_Edge& edge, gp_Pnt& start, gp_Pnt& end)
{
    double first, last;
    Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, first, last);
    start = curve->Value(first);
    end = curve->Value(last);
}

// ChFi2d may trim either side of the corner, so the kept side is rebuilt
// deterministically: from the fillet tangent point (whichever arc endpoint lies on this
// curve) to the end of the edge farthest from the corner.
static TopoDS_Edge edgeToFarEnd(const Handle(Geom_Curve) & basis, double first, double last,
    double cornerParam, const gp_Pnt& arcStart, const gp_Pnt& arcEnd)
{
    GeomAPI_ProjectPointOnCurve fromStart(arcStart, basis);
    GeomAPI_ProjectPointOnCurve fromEnd(arcEnd, basis);
    double tangent = fromStart.LowerDistance() <= fromEnd.LowerDistance()
        ? fromStart.LowerDistanceParameter()
        : fromEnd.LowerDistanceParameter();
    double farEnd = cornerParam - first >= last - cornerParam ? first : last;
    return BRepBuilderAPI_MakeEdge(basis, std::min(tangent, farEnd), std::max(tangent, farEnd)).Edge();
}

static std::string mapBuildWireError(const BRepBuilderAPI_WireError& error)
{
    switch (error) {
    case BRepBuilderAPI_EmptyWire:
        return "Empty Wire";
    case BRepBuilderAPI_DisconnectedWire:
        return "Disconnected Wire";
    case BRepBuilderAPI_NonManifoldWire:
        return "Non Mainfold Wire";
    default:
        return "Done";
    }
};

// Helpers for ShapeFactory::facesFromEdges (FreeCAD's FaceMakerBuildFace recipe).

// The split edges plus a map from each split segment to its input edge index.
struct SplitEdgesResult {
    TopoDS_Shape shape;
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> segments;
    std::vector<int> segmentSources;
    bool isOk;
    std::string error;
};

// Adds both orientations of `segment` to the map (lookups ignore orientation, but be
// explicit), extending the parallel source array only on real insertions — the map
// dedupes shapes that are IsSame.
static void addSegment(SplitEdgesResult& splitEdges, const TopoDS_Shape& segment, int inputIndex)
{
    const int added = splitEdges.segments.Add(segment.Oriented(TopAbs_FORWARD));
    splitEdges.segments.Add(segment.Oriented(TopAbs_REVERSED));
    if (added == splitEdges.segments.Extent()) {
        splitEdges.segmentSources.push_back(inputIndex);
    }
}

// Splits `edges` at their mutual intersections, recording which input edge each split
// segment comes from (an unmodified edge maps to itself).
static SplitEdgesResult splitAtIntersections(const NCollection_List<TopoDS_Shape>& edges)
{
    BOPAlgo_Splitter splitter;
    splitter.SetArguments(edges);
    splitter.SetRunParallel(true);
    splitter.SetNonDestructive(true);
    splitter.Perform();
    if (splitter.HasErrors()) {
        return SplitEdgesResult { TopoDS_Shape(), { }, { }, false, "Failed to split edges at intersections" };
    }

    SplitEdgesResult splitEdges { splitter.Shape(), { }, { }, true, "" };
    int inputIndex = 0;
    for (const TopoDS_Shape& edge : edges) {
        const NCollection_List<TopoDS_Shape>& modified = splitter.Modified(edge);
        if (modified.IsEmpty()) {
            addSegment(splitEdges, edge, inputIndex);
        } else {
            for (const TopoDS_Shape& segment : modified) {
                addSegment(splitEdges, segment, inputIndex);
            }
        }
        inputIndex++;
    }
    return splitEdges;
}

// Builds a base face dwarfing the split edges so BuilderFace can tell bounded regions from
// the unbounded exterior (FORWARD orientation required). `faceEdges` receives every edge in
// both orientations — so every region boundary is found — with pcurves on the base face.
static TopoDS_Face baseFaceForRegions(const TopoDS_Shape& splitEdges, const gp_Pln& pln,
    NCollection_List<TopoDS_Shape>& faceEdges, double& extent)
{
    Bnd_Box geomBox;
    for (TopExp_Explorer explorer(splitEdges, TopAbs_EDGE); explorer.More(); explorer.Next()) {
        const TopoDS_Edge& edge = TopoDS::Edge(explorer.Current());
        BRepBndLib::Add(edge, geomBox);
        faceEdges.Append(edge.Oriented(TopAbs_FORWARD));
        faceEdges.Append(edge.Oriented(TopAbs_REVERSED));
    }
    extent = std::max(1.0e8, 10.0 * std::sqrt(geomBox.SquareExtent()));
    TopoDS_Face baseFace = BRepBuilderAPI_MakeFace(pln, -extent, extent, -extent, extent).Face();
    baseFace.Orientation(TopAbs_FORWARD);
    BRepLib::BuildPCurveForEdgesOnPlane(faceEdges, baseFace);
    return baseFace;
}

// Recovers every minimal bounded area covered by `faceEdges` on `baseFace`, with the
// sorted unique input edge indexes bounding each region (see SplitEdgesResult).
static RegionsResult boundedAreas(const TopoDS_Face& baseFace, const NCollection_List<TopoDS_Shape>& faceEdges,
    double extent, const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& segments,
    const std::vector<int>& segmentSources)
{
    // AvoidInternalShapes keeps dangling edges from becoming internal wires.
    BOPAlgo_BuilderFace faceBuilder;
    faceBuilder.SetFace(baseFace);
    faceBuilder.SetShapes(faceEdges);
    faceBuilder.SetAvoidInternalShapes(true);
    faceBuilder.Perform();
    if (faceBuilder.HasErrors()) {
        return RegionsResult { ShapeArray(val::array()), { }, { }, false, "Failed to build faces from edges" };
    }

    const double outerThreshold = extent * extent;
    val faces = val::array();
    std::vector<int> sourceCounts;
    std::vector<int> sourceIds;
    for (const TopoDS_Shape& area : faceBuilder.Areas()) {
        Bnd_Box box;
        BRepBndLib::Add(area, box);
        GProp_GProps props;
        BRepGProp::SurfaceProperties(area, props);
        if (box.SquareExtent() > outerThreshold || props.Mass() < Precision::Confusion()) {
            continue;
        }
        faces.call<void>("push", area);
        std::set<int> sources;
        for (TopExp_Explorer explorer(area, TopAbs_EDGE); explorer.More(); explorer.Next()) {
            const int index = segments.FindIndex(explorer.Current());
            if (index > 0) {
                sources.insert(segmentSources[index - 1]);
            }
        }
        sourceCounts.push_back(static_cast<int>(sources.size()));
        sourceIds.insert(sourceIds.end(), sources.begin(), sources.end());
    }
    if (sourceCounts.empty()) {
        return RegionsResult { ShapeArray(val::array()), { }, { }, false, "No bounded regions found" };
    }
    return RegionsResult { ShapeArray(faces), sourceCounts, sourceIds, true, "" };
}

static std::string cornerSize(double amount, const char* dimension)
{
    std::ostringstream message;
    message << dimension << "=" << std::setprecision(12) << amount;
    return message.str();
}

static std::string cornerInputFailure(const TopoDS_Shape& shape, const NumberArray& edges,
    double amount, const char* operation, const char* dimension,
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& edgeMap)
{
    const std::string prefix = std::string("Failed to ") + operation + ": ";
    if (shape.IsNull())
        return prefix + "input shape is null";
    if (!std::isfinite(amount) || amount <= 0)
        return prefix + dimension + " must be positive and finite";
    const int count = edges["length"].as<int>();
    if (count == 0)
        return prefix + "select at least one edge";
    TopExp::MapShapes(shape, TopAbs_EDGE, edgeMap);
    for (int i = 0; i < count; ++i) {
        const double index = edges[i].as<double>();
        if (!std::isfinite(index) || std::floor(index) != index || index < 0 || index >= edgeMap.Extent())
            return prefix + "edge indexes must be integers in the current shape's edge range";
        if (BRep_Tool::Degenerated(TopoDS::Edge(edgeMap.FindKey(static_cast<int>(index) + 1))))
            return prefix + "selected edge " + std::to_string(static_cast<int>(index))
                + " is degenerate; select a non-degenerate edge";
    }
    return "";
}

static std::string cornerContourFailure(const TopoDS_Shape& shape, const TopoDS_Edge& edge,
    int index, const char* operation, double amount, const char* dimension)
{
    std::string message = std::string("Failed to ") + operation + ": selected edge "
        + std::to_string(index) + " was not accepted into an OCCT contour (" + cornerSize(amount, dimension) + ")";
    NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher> mapEF;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, mapEF);
    if (mapEF.Contains(edge)) {
        const auto& faces = mapEF.FindFromKey(edge);
        if (faces.Size() == 2 && !faces.First().IsSame(faces.Last())) {
            const auto first = TopoDS::Face(faces.First());
            const auto last = TopoDS::Face(faces.Last());
            if (BRep_Tool::HasContinuity(edge, first, last)
                && BRep_Tool::Continuity(edge, first, last) >= GeomAbs_G1)
                return message + "; adjoining faces are marked tangent (G1 or higher). Select a sharp edge instead";
        } else if (faces.Size() < 2) {
            return message + "; edge has fewer than two adjoining faces. Select an edge shared by suitable faces";
        }
    }
    return message + "; inspect adjoining faces and tangency, or choose a different edge. No specific cause was reported";
}

static std::string filletBuildFailure(BRepFilletAPI_MakeFillet& builder, double radius)
{
    std::string message = "Failed to fillet: OCCT build failed (" + cornerSize(radius, "radius")
        + ", contours=" + std::to_string(builder.NbContours()) + ")";
    const int faulty = builder.NbFaultyContours();
    for (int i = 1; i <= std::min(faulty, 8); ++i) {
        const int contour = builder.FaultyContour(i);
        message += "; contour " + std::to_string(contour) + ": ";
        switch (builder.StripeStatus(contour)) {
        case ChFiDS_StartsolFailure:
            message += "start solution failed; radius may be too large or incompatible with the local geometry";
            break;
        case ChFiDS_TwistedSurface:
            message += "twisted surface; inspect adjoining face geometry and tangency";
            break;
        case ChFiDS_WalkingFailure:
            message += "surface walking failed; inspect the contour, radius and face transitions";
            break;
        case ChFiDS_Ok:
            message += "stripe reports OK; final topology or corner construction failed";
            break;
        default:
            message += "unspecified OCCT stripe error";
            break;
        }
    }
    if (faulty > 8)
        message += "; additional faulty contours=" + std::to_string(faulty - 8);
    const int vertices = builder.NbFaultyVertices();
    if (vertices > 0)
        message += "; faulty corner vertices=" + std::to_string(vertices);
    if (faulty == 0 && vertices == 0)
        message += "; no detailed failure status was reported. Try a smaller radius or another edge selection";
    if (builder.HasResult())
        message += FaceValidation::invalidFaces(builder.BadShape());
    else
        message += "; no result faces available for BRepCheck";
    return message;
}

static std::string chamferBuildFailure(BRepFilletAPI_MakeChamfer& builder, double distance)
{
    return "Failed to chamfer: OCCT build failed (" + cornerSize(distance, "distance")
        + ", contours=" + std::to_string(builder.NbContours())
        + "). The chamfer builder provides no specific failure status; try a smaller distance or another edge selection";
}

static std::string prepareVariableFillet(BRepFilletAPI_MakeFillet& builder, const TopoDS_Shape& shape,
    const NumberArray& edges, const NumberArray& law, double& maximumRadius)
{
    const int count = law["length"].as<int>();
    if (count < 4 || count > 128 || count % 2 != 0)
        return "Variable-radius fillet requires 2 to 64 position/radius pairs";
    if (law[0].as<double>() != 0 || law[count - 2].as<double>() != 1)
        return "Radius law must start at position 0 and end at position 1";
    double previous = -1;
    maximumRadius = 0;
    for (int i = 0; i < count; i += 2) {
        const double position = law[i].as<double>();
        const double radius = law[i + 1].as<double>();
        if (!std::isfinite(position) || position < 0 || position > 1 || position <= previous)
            return "Radius law positions must be finite and strictly increasing from 0 to 1";
        if (!std::isfinite(radius) || radius <= 0)
            return "Radius law radii must be positive and finite";
        previous = position;
        maximumRadius = std::max(maximumRadius, radius);
    }
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edgeMap;
    const auto inputFailure = cornerInputFailure(shape, edges, maximumRadius,
        "variable-radius fillet", "maximum radius", edgeMap);
    if (!inputFailure.empty())
        return inputFailure;
    std::set<int> selectedContours;
    for (const auto index : vecFromJSArray<int>(edges)) {
        const auto selected = TopoDS::Edge(edgeMap.FindKey(index + 1));
        builder.Add(selected);
        const int contour = builder.Contour(selected);
        if (contour == 0)
            return cornerContourFailure(shape, selected, index, "variable-radius fillet", maximumRadius, "maximum radius");
        if (!selectedContours.insert(contour).second)
            return "Variable-radius fillet requires one selected edge per tangent contour; select only one of the tangent-connected edges";
        if (builder.Closed(contour) && law[1].as<double>() != law[count - 1].as<double>())
            return "A closed fillet contour requires equal radius-law endpoint values";
        int edgeInContour = 0;
        for (int i = 1; i <= builder.NbEdges(contour); ++i) {
            if (builder.Edge(contour, i).IsSame(selected)) {
                edgeInContour = i;
                break;
            }
        }
        if (edgeInContour == 0)
            return "Variable-radius fillet could not locate the selected edge in its contour";
        // UandR is relative arc length of this edge in contour direction; API samples use natural curve direction.
        const bool reverse = builder.Edge(contour, edgeInContour).Orientation() == TopAbs_REVERSED;
        NCollection_Array1<gp_Pnt2d> samples(1, count / 2);
        for (int i = 0; i < count / 2; ++i) {
            const int source = reverse ? count - 2 - 2 * i : 2 * i;
            const double position = law[source].as<double>();
            samples(i + 1) = gp_Pnt2d(reverse ? 1 - position : position, law[source + 1].as<double>());
        }
        builder.SetRadius(samples, contour, edgeInContour);
    }
    return "";
}

class ShapeFactory {
public:
    static CornerSetbackResult filletCornerSetbackTracked(const TopoDS_Shape& shape, const NumberArray& edges,
        double radius, const NumberArray& distances)
    {
        if (edges["length"].as<int>() != 3 || distances["length"].as<int>() != 3)
            return CornerSetback::failure("three selected edges and three setback lengths are required");
        std::array<int, 3> indexes;
        std::array<double, 3> offsets;
        for (int i = 0; i < 3; ++i) {
            const double index = edges[i].as<double>();
            if (!std::isfinite(index) || index < 0 || index != std::floor(index) || index > 2147483646)
                return CornerSetback::failure("edge indexes must be finite nonnegative integers");
            indexes[i] = static_cast<int>(index);
            offsets[i] = distances[i].as<double>();
        }
        // A fixed finite fit budget; live callers also enforce a 180-second corner-worker deadline.
        return CornerSetback::build(shape, indexes, radius, offsets, 512);
    }
    static ShapeResult box(const Pln& ax3, double x, double y, double z)
    {
        gp_Pln pln = Pln::toPln(ax3);
        BRepBuilderAPI_MakeFace makeFace(pln, 0, x, 0, y);
        if (!makeFace.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create box" };
        }

        gp_Vec vec(pln.Axis().Direction());
        vec.Multiply(z);
        BRepPrimAPI_MakePrism box(makeFace.Face(), vec);
        if (!box.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create box" };
        }
        return ShapeResult { box.Shape(), true, "" };
    }

    static ShapeResult cone(const Vector3& normal, const Vector3& center, double radius, double radiusUp, double height)
    {
        gp_Ax2 ax2(Vector3::toPnt(center), Vector3::toDir(normal));
        TopoDS_Shape cone = BRepPrimAPI_MakeCone(ax2, radius, radiusUp, height).Shape();
        return ShapeResult { cone, true, "" };
    }

    static ShapeResult sphere(const Vector3& center, double radius)
    {
        TopoDS_Shape sphere = BRepPrimAPI_MakeSphere(Vector3::toPnt(center), radius).Shape();
        return ShapeResult { sphere, true, "" };
    }

    static ShapeResult ellipse(const Vector3& normal, const Vector3& center, const Vector3& xvec, double majorRadius,
        double minorRadius)
    {
        gp_Ax2 ax2(Vector3::toPnt(center), Vector3::toDir(normal), Vector3::toDir(xvec));
        gp_Elips ellipse(ax2, majorRadius, minorRadius);
        BRepBuilderAPI_MakeEdge edge(ellipse);
        if (!edge.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create ellipse" };
        }
        return ShapeResult { edge.Edge(), true, "" };
    }

    /**
     * TODO
     */
    static ShapeResult ellipsoid(const Vector3& normal, const Vector3& center, const Vector3& xvec, double xRadius,
        double yRadius, double zRadius)
    {
        TopoDS_Shape sphere = BRepPrimAPI_MakeSphere(1).Solid();

        gp_GTrsf transform;
        transform.SetValue(1, 1, xRadius);
        transform.SetValue(2, 2, yRadius);
        transform.SetValue(3, 3, zRadius);
        transform.SetTranslationPart(gp_XYZ(center.x, center.y, center.z));

        BRepBuilderAPI_GTransform builder(sphere, transform);
        if (builder.IsDone()) {
            TopoDS_Shape ellipsoid = builder.Shape();
            return ShapeResult { ellipsoid, true, "" };
        }
        return ShapeResult { TopoDS_Shape(), false, "" };
    }

    static ShapeResult pyramid(const Pln& ax3, double x, double y, double z)
    {
        if (abs(x) <= Precision::Confusion() || abs(y) <= Precision::Confusion() || abs(z) <= Precision::Confusion()) {
            return ShapeResult { TopoDS_Shape(), false, "Invalid dimensions" };
        }

        gp_Pln pln = Pln::toPln(ax3);
        auto xvec = gp_Vec(pln.XAxis().Direction()).Multiplied(x);
        auto yvec = gp_Vec(pln.YAxis().Direction()).Multiplied(y);
        auto zvec = gp_Vec(pln.Axis().Direction()).Multiplied(z);
        auto p1 = pln.Location();
        auto p2 = p1.Translated(xvec);
        auto p3 = p1.Translated(xvec).Translated(yvec);
        auto p4 = p1.Translated(yvec);
        auto top = pln.Location().Translated((xvec + yvec) * 0.5 + zvec);

        std::vector<TopoDS_Face> faces = {
            TopoDS::Face(pointsToFace({ p1, p2, p3, p4, p1 }).shape), TopoDS::Face(pointsToFace({ p1, p2, top, p1 }).shape),
            TopoDS::Face(pointsToFace({ p2, p3, top, p2 }).shape), TopoDS::Face(pointsToFace({ p3, p4, top, p3 }).shape),
            TopoDS::Face(pointsToFace({ p4, p1, top, p4 }).shape)
        };

        return facesToSolid(faces);
    }

    static ShapeResult pointsToFace(std::vector<gp_Pnt>&& points)
    {
        auto wire = pointsToWire(points);
        if (!wire.isOk) {
            return wire;
        }

        BRepBuilderAPI_MakeFace face(TopoDS::Wire(wire.shape));
        if (!face.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create face" };
        }
        return ShapeResult { face.Face(), true, "" };
    }

    static ShapeResult pointsToWire(std::vector<gp_Pnt>& points)
    {
        BRepBuilderAPI_MakePolygon poly;
        for (auto& p : points) {
            poly.Add(p);
        }
        if (!poly.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create polygon" };
        }
        return ShapeResult { poly.Wire(), true, "" };
    }

    static ShapeResult facesToSolid(const std::vector<TopoDS_Face>& faces)
    {
        TopoDS_Shell shell;
        BRep_Builder shellBuilder;
        shellBuilder.MakeShell(shell);
        for (const auto& face : faces) {
            shellBuilder.Add(shell, face);
        }

        BRepBuilderAPI_MakeSolid solidBuilder(shell);
        if (!solidBuilder.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create solid" };
        }

        return ShapeResult { solidBuilder.Solid(), true, "" };
    }

    static ShapeResult cylinder(const Vector3& normal, const Vector3& center, double radius, double height)
    {
        gp_Ax2 ax2(Vector3::toPnt(center), Vector3::toDir(normal));
        BRepPrimAPI_MakeCylinder cylinder(ax2, radius, height);
        cylinder.Build();
        if (!cylinder.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create cylinder" };
        }
        return ShapeResult { cylinder.Solid(), true, "" };
    }

    static TrackedShapeResult loftGuidedTracked(const ShapeArray& sections, const TopoDS_Wire& spine,
        const TopoDS_Wire& boundary, bool solid)
    {
        return loftGuidedTrackedImpl(sections, spine, boundary, solid, false);
    }

    static TrackedShapeResult loftGuidedTrackedDeferred(const ShapeArray& sections, const TopoDS_Wire& spine,
        const TopoDS_Wire& boundary, bool solid)
    {
        return loftGuidedTrackedImpl(sections, spine, boundary, solid, true);
    }

    static TrackedShapeResult loftGuidedTrackedImpl(const ShapeArray& sections, const TopoDS_Wire& originalSpine,
        const TopoDS_Wire& originalAuxiliary, bool solid, bool skipSelfIntersection)
    {
        auto originalInputs = vecFromJSArray<TopoDS_Shape>(sections);
        if (originalInputs.size() < 2 || originalInputs.size() > 16)
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft requires 2 to 16 sections" };
        const size_t sectionCount = originalInputs.size();
        originalInputs.push_back(originalSpine);
        originalInputs.push_back(originalAuxiliary);
        std::vector<std::unique_ptr<BRepBuilderAPI_Copy>> copies;
        std::vector<TopoDS_Shape> copiedInputs;
        for (const auto& input : originalInputs) {
            if (input.IsNull())
                return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft input is missing" };
            auto copy = std::make_unique<BRepBuilderAPI_Copy>(input, true, false);
            if (!copy->IsDone())
                return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft input copy failed" };
            copiedInputs.push_back(copy->Shape());
            copies.push_back(std::move(copy));
        }
        const std::vector<TopoDS_Shape> profiles(copiedInputs.begin(), copiedInputs.begin() + sectionCount);
        const auto spine = TopoDS::Wire(copiedInputs[sectionCount]);
        const auto auxiliary = TopoDS::Wire(copiedInputs[sectionCount + 1]);
        const auto error = GuidedLoft::validate(profiles, spine, auxiliary);
        if (!error.empty())
            return TrackedShapeResult { TopoDS_Shape(), false, error };
        BRepOffsetAPI_MakePipeShell builder(spine);
        builder.SetMode(auxiliary, false, BRepFill_NoContact);
        builder.SetTolerance(1e-7, 1e-7, 1e-5);
        builder.SetMaxDegree(12);
        builder.SetMaxSegments(64);
        builder.SetForceApproxC1(false);
        builder.SetIsBuildHistory(true);
        for (const auto& profile : profiles)
            builder.Add(profile, false, false);
        if (!builder.IsReady())
            return TrackedShapeResult { TopoDS_Shape(), false, "Incompatible guided loft sections" };
        builder.Build();
        if (!builder.IsDone())
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft contact failed (status " + std::to_string(static_cast<int>(builder.GetStatus())) + ")" };
        if (solid && !builder.MakeSolid())
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft could not close a solid" };
        if (!BRepCheck_Analyzer(builder.Shape()).IsValid())
            return TrackedShapeResult { TopoDS_Shape(), false, "Invalid guided loft output" };
        if (!skipSelfIntersection) {
            BOPAlgo_ArgumentAnalyzer selfIntersection;
            selfIntersection.SetShape1(builder.Shape());
            selfIntersection.SelfInterMode() = true;
            selfIntersection.StopOnFirstFaulty() = true;
            selfIntersection.Perform();
            if (selfIntersection.HasFaulty())
                return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft output self-intersects or could not be checked" };
        }
        BRep_Builder topology;
        TopoDS_Compound sides;
        topology.MakeCompound(sides);
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> seen;
        for (TopExp_Explorer input(profiles.front(), TopAbs_EDGE); input.More(); input.Next()) {
            const auto& generated = builder.Generated(input.Current());
            for (const auto& item : generated) {
                for (TopExp_Explorer face(item, TopAbs_FACE); face.More(); face.Next()) {
                    if (!seen.Contains(face.Current())) {
                        seen.Add(face.Current());
                        topology.Add(sides, face.Current());
                    }
                }
            }
        }
        if (seen.Extent() > 512)
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft exceeds the 512-side-face budget" };
        if (seen.IsEmpty())
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft side history missing" };
        for (const auto& profile : profiles) {
            BRepAlgoAPI_Cut uncovered;
            NCollection_List<TopoDS_Shape> arguments, tools;
            arguments.Append(profile);
            tools.Append(sides);
            uncovered.SetArguments(arguments);
            uncovered.SetTools(tools);
            uncovered.SetNonDestructive(true);
            uncovered.Build();
            if (!uncovered.IsDone() || uncovered.HasErrors())
                return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft section coverage failed" };
            GProp_GProps remaining;
            BRepGProp::LinearProperties(uncovered.Shape(), remaining);
            if (!std::isfinite(remaining.Mass()) || remaining.Mass() < 0 || remaining.Mass() > 1e-5)
                return TrackedShapeResult { TopoDS_Shape(), false, "Guides are incompatible with a requested section" };
        }
        BRepAlgoAPI_Cut uncoveredGuide;
        NCollection_List<TopoDS_Shape> guideArguments, guideTools;
        guideArguments.Append(auxiliary);
        guideTools.Append(sides);
        uncoveredGuide.SetArguments(guideArguments);
        uncoveredGuide.SetTools(guideTools);
        uncoveredGuide.SetNonDestructive(true);
        uncoveredGuide.Build();
        if (!uncoveredGuide.IsDone() || uncoveredGuide.HasErrors())
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft boundary coverage failed" };
        GProp_GProps guideRemaining;
        BRepGProp::LinearProperties(uncoveredGuide.Shape(), guideRemaining);
        if (!std::isfinite(guideRemaining.Mass()) || guideRemaining.Mass() < 0 || guideRemaining.Mass() > 1e-5)
            return TrackedShapeResult { TopoDS_Shape(), false, "Auxiliary guide does not lie completely on the loft sides; residual length " + std::to_string(guideRemaining.Mass()) + "; side faces " + std::to_string(seen.Extent()) };
        const TopoDS_Shape& output = builder.Shape();
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces, edges;
        TopExp::MapShapes(output, TopAbs_FACE, faces);
        TopExp::MapShapes(output, TopAbs_EDGE, edges);
        TrackedShapeResult result { output, true, "",
            std::vector<int>(faces.Extent(), -1),
            std::vector<int>(edges.Extent(), -1) };
        result.faceEdgeMap.assign(faces.Extent(), -1);
        bool historyMissing = false;
        auto history = [&](TopAbs_ShapeEnum inputType,
                           const NCollection_IndexedMap<
                               TopoDS_Shape, TopTools_ShapeMapHasher>& outMap,
                           std::vector<int>& map, std::vector<int>& ancestors) {
            int offset = 0;
            for (size_t inputIndex = 0; inputIndex < originalInputs.size(); inputIndex++) {
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> inputMap;
                TopExp::MapShapes(originalInputs[inputIndex], inputType, inputMap);
                for (int i = 1; i <= inputMap.Extent(); i++) {
                    const auto& copied = copies[inputIndex]->ModifiedShape(inputMap.FindKey(i));
                    if (copied.IsNull()) {
                        historyMissing = true;
                        continue;
                    }
                    mapInputShape(builder, copied, offset + i - 1, outMap, map,
                        &ancestors);
                }
                offset += inputMap.Extent();
            }
        };
        history(TopAbs_EDGE, faces, result.faceEdgeMap, result.pipeFaceEdges);
        history(TopAbs_EDGE, edges, result.edgeMap, result.edgeAncestors);
        std::vector<int> faceVertices(faces.Extent(), -1),
            edgeVertices(edges.Extent(), -1);
        history(TopAbs_VERTEX, faces, faceVertices, result.pipeFaceVertices);
        history(TopAbs_VERTEX, edges, edgeVertices, result.pipeEdgeVertices);
        if (historyMissing)
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft input copy lost topology ancestry" };
        auto sectionEdges = [&](const TopoDS_Shape& boundary) {
            std::vector<int> indexes;
            if (!boundary.IsNull()) {
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>
                    boundaryEdges;
                TopExp::MapShapes(boundary, TopAbs_EDGE, boundaryEdges);
                for (int i = 1; i <= boundaryEdges.Extent(); i++) {
                    int index = edges.FindIndex(boundaryEdges.FindKey(i));
                    if (index > 0) {
                        indexes.push_back(index - 1);
                    }
                }
            }
            return indexes;
        };
        result.pipeStartEdges = sectionEdges(builder.FirstShape());
        result.pipeEndEdges = sectionEdges(builder.LastShape());
        if (solid) {
            // MakeSolid returns section wires, so identify caps through their
            // complete boundary, never face enumeration or geometric proximity.
            auto caps = [&](const std::vector<int>& boundary) {
                std::vector<int> indexes;
                for (int i = 1; i <= faces.Extent(); i++) {
                    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>
                        faceEdges;
                    TopExp::MapShapes(faces.FindKey(i), TopAbs_EDGE, faceEdges);
                    bool belongs = faceEdges.Extent() > 0;
                    for (int j = 1; j <= faceEdges.Extent() && belongs; j++) {
                        int index = edges.FindIndex(faceEdges.FindKey(j)) - 1;
                        belongs = std::find(boundary.begin(), boundary.end(), index) != boundary.end();
                    }
                    if (belongs) {
                        indexes.push_back(i - 1);
                    }
                }
                return indexes;
            };
            result.pipeStartFaces = caps(result.pipeStartEdges);
            result.capFaces = caps(result.pipeEndEdges);
            if (result.pipeStartFaces.size() != 1 || result.capFaces.size() != 1) {
                return failedResult(GuardTag<TrackedShapeResult> { },
                    "Guided loft cap ancestry is ambiguous");
            }
        }
        if (seen.Extent() + result.pipeStartFaces.size() + result.capFaces.size() != static_cast<size_t>(faces.Extent()))
            return TrackedShapeResult { TopoDS_Shape(), false, "Guided loft side ancestry is incomplete" };
        return result;
    }

    static ShapeResult sweep(const ShapeArray& sections, const TopoDS_Wire& path, bool isFrenet, bool isForceC1)
    {
        BRepOffsetAPI_MakePipeShell pipe(path);
        if (isFrenet) {
            pipe.SetMode(isFrenet);
        }

        if (isForceC1) {
            pipe.SetTransitionMode(BRepBuilderAPI_RoundCorner);
            pipe.SetForceApproxC1(isForceC1);
        } else {
            pipe.SetTransitionMode(BRepBuilderAPI_RightCorner);
        }

        std::vector<TopoDS_Shape> shapesVec = vecFromJSArray<TopoDS_Shape>(sections);
        for (const auto& shape : shapesVec) {
            pipe.Add(shape);
        }

        pipe.Build();
        pipe.MakeSolid();

        if (!pipe.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to sweep profile" };
        }
        return ShapeResult { pipe.Shape(), true, "" };
    }

    static TrackedShapeResult sweepTracked(const TopoDS_Wire& section,
        const TopoDS_Wire& path, bool solid,
        bool roundCorner)
    {
        return pipeTracked(section, path, solid, roundCorner, nullptr);
    }

    static TrackedShapeResult copyTracked(const TopoDS_Shape& input)
    {
        if (input.IsNull())
            return failedResult(GuardTag<TrackedShapeResult> { }, "Tracked copy input is null");
        BRepBuilderAPI_Copy copy(input, true, false);
        const auto output = copy.Shape();
        if (!copy.IsDone() || output.IsNull() || !BRepCheck_Analyzer(output).IsValid())
            return failedResult(GuardTag<TrackedShapeResult> { }, "Tracked copy result is invalid");
        TrackedShapeResult result { output, true, "", { }, { } };
        auto history = [&](TopAbs_ShapeEnum type, std::vector<int>& map, std::vector<int>& ancestors) {
            NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> originals, copied;
            TopExp::MapShapes(input, type, originals);
            TopExp::MapShapes(output, type, copied);
            if (originals.Extent() != copied.Extent())
                throw Standard_Failure("Tracked copy changed input topology");
            map.assign(copied.Extent(), -1);
            for (int i = 1; i <= originals.Extent(); ++i) {
                const int index = copied.FindIndex(copy.ModifiedShape(originals.FindKey(i)));
                if (index <= 0 || map[index - 1] != -1)
                    throw Standard_Failure("Tracked copy has no unique original ancestry");
                map[index - 1] = i - 1;
                ancestors.push_back(index - 1);
                ancestors.push_back(i - 1);
            }
        };
        history(TopAbs_FACE, result.faceMap, result.faceAncestors);
        history(TopAbs_EDGE, result.edgeMap, result.edgeAncestors);
        return result;
    }

    static TrackedShapeResult faceSweepTracked(const TopoDS_Wire& section,
        const TopoDS_Wire& path, const TopoDS_Face& support, bool roundCorner)
    {
        auto fail = [](const std::string& error) {
            return failedResult(GuardTag<TrackedShapeResult> { }, error);
        };
        if (section.IsNull() || path.IsNull() || support.IsNull())
            return fail("Face sweep requires a section, path and trimmed support face");
        // Face construction changes wire flags, and p-curves mutate edge representations.
        // Own deep copies before any builders or validators can touch borrowed topology.
        BRepBuilderAPI_Copy sectionCopy(section, true, false), pathCopy(path, true, false), supportCopy(support, true, false);
        const auto ownedSection = TopoDS::Wire(sectionCopy.Shape());
        const auto ownedPath = TopoDS::Wire(pathCopy.Shape());
        const auto ownedSupport = TopoDS::Face(supportCopy.Shape());
        if (!BRepCheck_Analyzer(ownedSection).IsValid() || !BRepCheck_Analyzer(ownedPath).IsValid()
            || !BRepCheck_Analyzer(ownedSupport).IsValid())
            return fail("Face sweep input topology is invalid");
        BRepBuilderAPI_MakeFace profileFace(ownedSection, true);
        if (!profileFace.IsDone())
            return fail("Face sweep section must be a planar closed profile");
        BRepAdaptor_Surface profileSurface(profileFace.Face(), true);
        if (profileSurface.GetType() != GeomAbs_Plane)
            return fail("Face sweep section must be planar");
        TopoDS_Vertex start, end;
        TopExp::Vertices(ownedPath, start, end);
        if (start.IsNull())
            return fail("Face sweep path has no start vertex");
        const gp_Pnt startPoint = BRep_Tool::Pnt(start);
        BRepTools_WireExplorer explorer(ownedPath);
        if (!explorer.More())
            return fail("Face sweep path has no edge");
        const TopoDS_Edge first = explorer.Current();
        BRepAdaptor_Curve curve(first);
        gp_Pnt curvePoint;
        gp_Vec tangent;
        curve.D1(first.Orientation() == TopAbs_REVERSED ? curve.LastParameter() : curve.FirstParameter(), curvePoint, tangent);
        const double tolerance = 1e-6;
        if (tangent.SquareMagnitude() <= tolerance * tolerance)
            return fail("Face sweep path start tangent is degenerate");
        const gp_Pln plane = profileSurface.Plane();
        if (plane.Distance(startPoint) > tolerance
            || !plane.Axis().Direction().IsParallel(gp_Dir(tangent), 1e-6))
            return fail("Face sweep section must be authored at the path start, perpendicular to its tangent");
        BRepClass_FaceClassifier sectionClassifier(profileFace.Face(), startPoint, tolerance);
        if (sectionClassifier.State() != TopAbs_IN && sectionClassifier.State() != TopAbs_ON)
            return fail("Face sweep section must contain the path start");

        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> pathEdges;
        TopExp::MapShapes(ownedPath, TopAbs_EDGE, pathEdges);
        if (pathEdges.Extent() < 1 || pathEdges.Extent() > 256)
            return fail("Face sweep requires 1-256 path pieces");
        ShapeFix_Edge fixer;
        for (int i = 1; i <= pathEdges.Extent(); ++i) {
            const auto edge = TopoDS::Edge(pathEdges.FindKey(i));
            const double previousTolerance = BRep_Tool::Tolerance(edge);
            fixer.FixAddPCurve(edge, ownedSupport, false, tolerance);
            double firstParameter, lastParameter;
            const auto pcurve = BRep_Tool::CurveOnSurface(edge, ownedSupport, firstParameter, lastParameter);
            if (pcurve.IsNull())
                return fail("Face sweep path has no support p-curve");
            BRepLib::SameParameter(edge, tolerance);
            BRepLib_CheckCurveOnSurface consistency(edge, ownedSupport);
            consistency.Perform();
            if (!BRep_Tool::SameParameter(edge) || !consistency.IsDone()
                || !std::isfinite(consistency.MaxDistance()) || consistency.MaxDistance() > tolerance
                || BRep_Tool::Tolerance(edge) > previousTolerance + 1e-9
                || !BRepCheck_Analyzer(edge).IsValid())
                return fail("Face sweep path p-curve is inconsistent with its 3D geometry");
            GProp_GProps inputProperties, coveredProperties, remainderProperties;
            BRepGProp::LinearProperties(edge, inputProperties);
            BRepAlgoAPI_Common common(edge, ownedSupport);
            common.SetNonDestructive(true);
            common.Build();
            if (!common.IsDone() || common.HasErrors())
                return fail("Face sweep could not validate trimmed support coverage");
            BRepGProp::LinearProperties(common.Shape(), coveredProperties);
            BRepAlgoAPI_Cut remaining(edge, ownedSupport);
            remaining.SetNonDestructive(true);
            remaining.Build();
            if (!remaining.IsDone() || remaining.HasErrors())
                return fail("Face sweep could not validate the unsupported path remainder");
            BRepGProp::LinearProperties(remaining.Shape(), remainderProperties);
            const double allowed = std::max(tolerance, inputProperties.Mass() * 1e-7);
            if (inputProperties.Mass() <= tolerance
                || std::abs(inputProperties.Mass() - coveredProperties.Mass()) > allowed
                || remainderProperties.Mass() > allowed)
                return fail("Every whole path edge must lie on the selected trimmed support face");
        }
        auto result = pipeTracked(ownedSection, ownedPath, true, roundCorner, &ownedSupport);
        if (!result.isOk)
            return result;
        // Copy maps establish the original input enumeration contract explicitly.
        auto remapping = [&](TopAbs_ShapeEnum type) {
            std::vector<int> remap;
            int offset = 0;
            for (auto item : { std::make_pair(TopoDS_Shape(section), &sectionCopy), std::make_pair(TopoDS_Shape(path), &pathCopy) }) {
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> originals, copied;
                TopExp::MapShapes(item.first, type, originals);
                TopExp::MapShapes(item.second->Shape(), type, copied);
                const int copyOffset = remap.size();
                remap.resize(copyOffset + copied.Extent(), -1);
                for (int i = 1; i <= originals.Extent(); ++i) {
                    const int index = copied.FindIndex(item.second->ModifiedShape(originals.FindKey(i)));
                    if (index <= 0 || remap[copyOffset + index - 1] != -1)
                        throw Standard_Failure("Face sweep copy lost unique input ancestry");
                    remap[copyOffset + index - 1] = offset + i - 1;
                }
                offset += originals.Extent();
            }
            return remap;
        };
        const auto edgeRemap = remapping(TopAbs_EDGE), vertexRemap = remapping(TopAbs_VERTEX);
        auto remapIndex = [](int& index, const std::vector<int>& map) {
            if (index < 0)
                return;
            if (index >= static_cast<int>(map.size()) || map[index] < 0)
                throw Standard_Failure("Face sweep history lost original input ancestry");
            index = map[index];
        };
        for (auto* map : { &result.edgeMap, &result.faceEdgeMap })
            for (int& index : *map)
                remapIndex(index, edgeRemap);
        for (auto* pairs : { &result.edgeAncestors, &result.pipeFaceEdges })
            for (size_t i = 1; i < pairs->size(); i += 2)
                remapIndex((*pairs)[i], edgeRemap);
        for (auto* pairs : { &result.pipeFaceVertices, &result.pipeEdgeVertices })
            for (size_t i = 1; i < pairs->size(); i += 2)
                remapIndex((*pairs)[i], vertexRemap);
        return result;
    }

    static TrackedShapeResult pipeTracked(const TopoDS_Wire& section,
        const TopoDS_Wire& path, bool solid, bool roundCorner, const TopoDS_Face* support)
    {
        if (section.IsNull() || path.IsNull()) {
            return failedResult(GuardTag<TrackedShapeResult> { },
                "Sweep requires a section and path wire");
        }
        if (!BRepCheck_Analyzer(section).IsValid() || !BRepCheck_Analyzer(path).IsValid()) {
            return failedResult(GuardTag<TrackedShapeResult> { },
                "Sweep input wire is invalid");
        }
        TopoDS_Vertex start, end;
        TopExp::Vertices(path, start, end);
        if (start.IsNull() || end.IsNull()) {
            return failedResult(GuardTag<TrackedShapeResult> { },
                "Sweep path has no unambiguous endpoints");
        }
        BRepOffsetAPI_MakePipeShell pipe(path);
        if (support) {
            if (!pipe.SetMode(*support))
                return failedResult(GuardTag<TrackedShapeResult> { }, "Face sweep could not establish a support-normal Darboux frame");
            pipe.SetTolerance(1e-6, 1e-6, 1e-6);
        } else
            pipe.SetMode(true);
        pipe.SetIsBuildHistory(true);
        pipe.SetTransitionMode(roundCorner ? BRepBuilderAPI_RoundCorner
                                           : BRepBuilderAPI_RightCorner);
        if (roundCorner) {
            pipe.SetForceApproxC1(true);
        }
        // Preserve the authored section placement; correction makes its plane
        // orthogonal to the initial tangent, as required for round transitions.
        pipe.Add(section, start, false, true);
        pipe.Build();
        if (!pipe.IsDone()) {
            return failedResult(GuardTag<TrackedShapeResult> { },
                "Failed to sweep section along path");
        }
        if (solid && !pipe.MakeSolid()) {
            return failedResult(GuardTag<TrackedShapeResult> { },
                "Sweep section does not enclose a solid");
        }
        const TopoDS_Shape& output = pipe.Shape();
        if (output.IsNull() || !BRepCheck_Analyzer(output).IsValid()) {
            return failedResult(GuardTag<TrackedShapeResult> { },
                "Sweep result is invalid (BRepCheck_Analyzer)");
        }
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces, edges;
        TopExp::MapShapes(output, TopAbs_FACE, faces);
        TopExp::MapShapes(output, TopAbs_EDGE, edges);
        TrackedShapeResult result { output, true, "",
            std::vector<int>(faces.Extent(), -1),
            std::vector<int>(edges.Extent(), -1) };
        result.faceEdgeMap.assign(faces.Extent(), -1);
        auto history = [&](TopAbs_ShapeEnum inputType,
                           const NCollection_IndexedMap<
                               TopoDS_Shape, TopTools_ShapeMapHasher>& outMap,
                           std::vector<int>& map, std::vector<int>& ancestors) {
            int offset = 0;
            for (const TopoDS_Shape& input :
                { TopoDS_Shape(section), TopoDS_Shape(path) }) {
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> inputMap;
                TopExp::MapShapes(input, inputType, inputMap);
                for (int i = 1; i <= inputMap.Extent(); i++) {
                    mapInputShape(pipe, inputMap.FindKey(i), offset + i - 1, outMap, map,
                        &ancestors);
                }
                offset += inputMap.Extent();
            }
        };
        history(TopAbs_EDGE, faces, result.faceEdgeMap, result.pipeFaceEdges);
        history(TopAbs_EDGE, edges, result.edgeMap, result.edgeAncestors);
        std::vector<int> faceVertices(faces.Extent(), -1),
            edgeVertices(edges.Extent(), -1);
        history(TopAbs_VERTEX, faces, faceVertices, result.pipeFaceVertices);
        history(TopAbs_VERTEX, edges, edgeVertices, result.pipeEdgeVertices);
        auto sectionEdges = [&](const TopoDS_Shape& boundary) {
            std::vector<int> indexes;
            if (!boundary.IsNull()) {
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>
                    boundaryEdges;
                TopExp::MapShapes(boundary, TopAbs_EDGE, boundaryEdges);
                for (int i = 1; i <= boundaryEdges.Extent(); i++) {
                    int index = edges.FindIndex(boundaryEdges.FindKey(i));
                    if (index > 0) {
                        indexes.push_back(index - 1);
                    }
                }
            }
            return indexes;
        };
        result.pipeStartEdges = sectionEdges(pipe.FirstShape());
        result.pipeEndEdges = sectionEdges(pipe.LastShape());
        if (solid && !start.IsSame(end)) {
            // MakeSolid returns section wires, so identify caps through their
            // complete boundary, never face enumeration or geometric proximity.
            auto caps = [&](const std::vector<int>& boundary) {
                std::vector<int> indexes;
                for (int i = 1; i <= faces.Extent(); i++) {
                    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>
                        faceEdges;
                    TopExp::MapShapes(faces.FindKey(i), TopAbs_EDGE, faceEdges);
                    bool belongs = faceEdges.Extent() > 0;
                    for (int j = 1; j <= faceEdges.Extent() && belongs; j++) {
                        int index = edges.FindIndex(faceEdges.FindKey(j)) - 1;
                        belongs = std::find(boundary.begin(), boundary.end(), index) != boundary.end();
                    }
                    if (belongs) {
                        indexes.push_back(i - 1);
                    }
                }
                return indexes;
            };
            result.pipeStartFaces = caps(result.pipeStartEdges);
            result.capFaces = caps(result.pipeEndEdges);
            if (result.pipeStartFaces.size() != 1 || result.capFaces.size() != 1) {
                return failedResult(GuardTag<TrackedShapeResult> { },
                    "Sweep cap ancestry is ambiguous");
            }
        }
        return result;
    }

    static ShapeResult revolve(const TopoDS_Shape& profile, const Ax1& axis, double rad)
    {
        BRepPrimAPI_MakeRevol revol(profile, Ax1::toAx1(axis), rad);
        if (!revol.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to revolve profile" };
        }
        return ShapeResult { revol.Shape(), true, "" };
    }

    static TrackedShapeResult revolveTracked(const TopoDS_Shape& profile, const Ax1& axis, double rad)
    {
        BRepPrimAPI_MakeRevol revol(profile, Ax1::toAx1(axis), rad);
        if (!revol.IsDone()) {
            return TrackedShapeResult { TopoDS_Shape(), false, "Failed to revolve profile", { }, { } };
        }
        TrackedShapeResult result { revol.Shape(), true, "", faceHistory(revol, profile, revol.Shape()),
            edgeHistory(revol, profile, revol.Shape()), faceFromEdgeHistory(revol, profile, revol.Shape()) };
        result.capFaces = sweepCapFaces(revol, revol.Shape());
        return result;
    }

    static ShapeResult prism(const TopoDS_Shape& profile, const Vector3& vec)
    {
        gp_Vec vec3 = Vector3::toVec(vec);
        BRepPrimAPI_MakePrism prism(profile, vec3);
        if (!prism.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create prism" };
        }
        return ShapeResult { prism.Shape(), true, "" };
    }

    static TrackedShapeResult prismTracked(const TopoDS_Shape& profile, const Vector3& vec)
    {
        gp_Vec vec3 = Vector3::toVec(vec);
        BRepPrimAPI_MakePrism prism(profile, vec3);
        if (!prism.IsDone()) {
            return TrackedShapeResult { TopoDS_Shape(), false, "Failed to create prism", { }, { } };
        }
        TrackedShapeResult result { prism.Shape(), true, "", faceHistory(prism, profile, prism.Shape()),
            edgeHistory(prism, profile, prism.Shape()), faceFromEdgeHistory(prism, profile, prism.Shape()) };
        result.capFaces = sweepCapFaces(prism, prism.Shape());
        return result;
    }

    // Exact from-surface tool. endMode: 0 = translated start surface (distance),
    // 1 = selected until surface, 2 = through the supplied bodies to a planar far cap.
    static TrackedShapeResult prismFromTracked(const TopoDS_Shape& profile, const Vector3& direction,
        const TopoDS_Shape& fromFace, double startOffset, int endMode, double depth,
        const TopoDS_Shape& untilFace, double untilOffset, const ShapeArray& bounds, bool flush)
    {
        if (!isUsableDirection(direction))
            return trackedError("The extrude direction is zero");
        gp_Dir dir = Vector3::toDir(direction);
        std::string error = profileError(profile, dir);
        if (!error.empty())
            return trackedError(error);
        if (profile.ShapeType() != TopAbs_FACE)
            return trackedError("From-face extrusion requires one planar profile face");
        Handle(Geom_Surface) profileSurface = BRep_Tool::Surface(TopoDS::Face(profile));
        if (profileSurface.IsNull()
            || Handle(Geom_Plane)::DownCast(untrimmedSurface(profileSurface)).IsNull())
            return trackedError("From-face extrusion requires a planar profile face");
        if (fromFace.IsNull() || fromFace.ShapeType() != TopAbs_FACE)
            return trackedError("The starting object is not a face");
        if (!std::isfinite(startOffset))
            return trackedError("The starting offset is not a number");
        TopoDS_Face start = TopoDS::Face(fromFace);
        Handle(Geom_Surface) surface = BRep_Tool::Surface(start);
        if (surface.IsNull() || isParallelTo(untrimmedSurface(surface), dir))
            return trackedError("The starting face is parallel to the extrusion");
        gp_Trsf startShift;
        startShift.SetTranslation(gp_Vec(dir) * startOffset);
        start = TopoDS::Face(start.Moved(TopLoc_Location(startShift)));
        TopoDS_Face end;
        if (endMode == 0) {
            if (!std::isfinite(depth) || depth <= Precision::Confusion())
                return trackedError("From-face extrusion depth must be positive");
            gp_Trsf endShift;
            endShift.SetTranslation(gp_Vec(dir) * depth);
            end = TopoDS::Face(start.Moved(TopLoc_Location(endShift)));
        } else if (endMode == 1) {
            if (untilFace.IsNull() || untilFace.ShapeType() != TopAbs_FACE || !std::isfinite(untilOffset))
                return trackedError("The ending object is not a valid face");
            gp_Trsf endShift;
            endShift.SetTranslation(gp_Vec(dir) * untilOffset);
            end = TopoDS::Face(untilFace.Moved(TopLoc_Location(endShift)));
        } else if (endMode == 2) {
            TopoDS_Compound targets = compoundOf(vecFromJSArray<TopoDS_Shape>(bounds));
            double low, high;
            Bnd_Box scene;
            if (!projectedRange(targets, dir, low, high) || !boxOf(targets, scene) || !boxOf(profile, scene) || !boxOf(start, scene))
                return trackedError("There is nothing to extrude through");
            double size = std::sqrt(scene.SquareExtent()) + 1;
            double distance = high + (flush ? 0 : size * 0.1 + 1);
            double xmin, ymin, zmin, xmax, ymax, zmax;
            scene.Get(xmin, ymin, zmin, xmax, ymax, zmax);
            gp_Pnt center((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2);
            gp_Pnt origin = center.Translated(gp_Vec(dir) * (distance - gp_Vec(center.XYZ()).Dot(gp_Vec(dir))));
            BRepBuilderAPI_MakeFace plane(gp_Pln(origin, dir), -size, size, -size, size);
            if (!plane.IsDone())
                return trackedError("Failed to create the extrusion end plane");
            end = plane.Face();
        } else
            return trackedError("Unknown from-face extrusion extent");
        return prismBetweenFaces(TopoDS::Face(profile), dir, start, end, endMode == 0 ? depth : 0);
    }

    // Tool prism of `profile` along `direction` up to `untilFace` (moved by `offset` along
    // the direction), any surface type. The face as given is tried first — it wins when it
    // fully intercepts the prism (e.g. the far half of a cylinder) — then its untrimmed
    // surface (see extendedFace). Fails cleanly on a zero or in-plane direction, a
    // non-face / surface-less target, a target parallel to the direction, behind the profile
    // or not bounding it.
    static TrackedShapeResult prismUntilTracked(const TopoDS_Shape& profile, const Vector3& direction,
        const TopoDS_Shape& untilFace, double offset)
    {
        if (!isUsableDirection(direction)) {
            return trackedError("The extrude direction is zero");
        }
        gp_Dir dir = Vector3::toDir(direction);
        std::string error = profileError(profile, dir);
        if (!error.empty()) {
            return trackedError(error);
        }
        if (untilFace.IsNull() || untilFace.ShapeType() != TopAbs_FACE) {
            return trackedError("The extrude target is not a face");
        }
        if (!std::isfinite(offset)) {
            return trackedError("The extrude target offset is not a number");
        }
        TopoDS_Face target = TopoDS::Face(untilFace);
        Handle(Geom_Surface) surface = BRep_Tool::Surface(target);
        if (surface.IsNull()) {
            return trackedError("The extrude target face has no surface");
        }
        if (isParallelTo(untrimmedSurface(surface), dir)) {
            return trackedError("The extrude direction is parallel to the target face");
        }
        if (offset != 0) {
            gp_Trsf shift;
            shift.SetTranslation(gp_Vec(dir) * offset);
            target = TopoDS::Face(target.Moved(TopLoc_Location(shift)));
        }

        Bnd_Box scene;
        double profileLow, profileHigh;
        if (!boxOf(profile, scene) || !boxOf(target, scene) || !projectedRange(profile, dir, profileLow, profileHigh)) {
            return trackedError("The extrude profile or target has no extent");
        }
        double margin = 2 * std::sqrt(scene.SquareExtent()) + 1;

        bool reached = false;
        std::string failure;
        for (int pass = 0; pass < 2; pass++) {
            TopoDS_Face tool = pass == 0 ? target : extendedFace(target, margin);
            double low, high;
            if (tool.IsNull() || !projectedRange(tool, dir, low, high)) {
                continue;
            }
            if (high <= profileLow + Precision::Confusion()) {
                continue;
            }
            reached = true;
            double length = high - profileLow + 0.1 * (high - profileLow) + 1;
            TrackedShapeResult result = boundedPrism(profile, gp_Vec(dir) * length, tool);
            if (result.isOk) {
                return result;
            }
            if (!result.error.empty()) {
                failure = result.error;
            }
        }
        if (!failure.empty()) {
            return trackedError(failure);
        }
        return trackedError(reached ? "The target face does not bound the extrusion of the profile"
                                    : "The target face is not reached along the extrude direction");
    }

    // Automatic next face. Only complete trimmed caps participate, with uniform ordering proved
    // by exact bounded-tool containment. Limits apply after conservative bounds pruning.
    static TrackedShapeResult prismNextTracked(const TopoDS_Shape& profile, const Vector3& direction,
        const ShapeArray& candidates, double offset, bool hasStart, const TopoDS_Shape& startFace, double startOffset)
    {
        if (!isUsableDirection(direction))
            return trackedError("The extrude direction is zero");
        gp_Dir dir = Vector3::toDir(direction);
        if (profile.IsNull() || profile.ShapeType() != TopAbs_FACE)
            return trackedError("Next-face extrusion requires one planar profile face");
        TopoDS_Face profileFace = TopoDS::Face(profile);
        Handle(Geom_Surface) profileSurface = BRep_Tool::Surface(profileFace);
        if (profileSurface.IsNull() || Handle(Geom_Plane)::DownCast(untrimmedSurface(profileSurface)).IsNull())
            return trackedError("Next-face extrusion requires a planar profile face");
        if (!std::isfinite(offset) || !std::isfinite(startOffset))
            return trackedError("Next-face extrusion offsets must be finite");
        std::string error = profileError(profile, dir);
        if (!error.empty())
            return trackedError(error);
        if (hasStart && (startFace.IsNull() || startFace.ShapeType() != TopAbs_FACE))
            return trackedError("The starting object is not a face");
        TopoDS_Face start = hasStart ? TopoDS::Face(startFace) : profileFace;
        Handle(Geom_Surface) startSurface = BRep_Tool::Surface(start);
        if (startSurface.IsNull() || isParallelTo(untrimmedSurface(startSurface), dir))
            return trackedError("The starting face is parallel to the extrusion");
        gp_Trsf shift;
        shift.SetTranslation(gp_Vec(dir) * startOffset);
        start = TopoDS::Face(start.Moved(TopLoc_Location(shift)));
        double startLow, startHigh;
        if (!projectedRange(start, dir, startLow, startHigh))
            return trackedError("The starting face has no extent");
        struct Candidate {
            int body;
            int face;
            TopoDS_Face cap;
            TrackedShapeResult tool;
            double volume;
        };
        std::vector<Candidate> valid;
        std::vector<TopoDS_Face> partial;
        std::string coverageFailure;
        int bodies = 0, examined = 0, bodyIndex = -1;
        for (const TopoDS_Shape& body : vecFromJSArray<TopoDS_Shape>(candidates)) {
            bodyIndex++;
            if (body.IsNull() || !intersectsProfileRayBounds(profile, body, dir, startLow))
                continue;
            if (++bodies > 64)
                return trackedError("Next-face search exceeds 64 intersecting candidate bodies");
            ShapeIndexMap faces;
            TopExp::MapShapes(body, TopAbs_FACE, faces);
            for (int f = 1; f <= faces.Extent(); f++) {
                TopoDS_Face face = TopoDS::Face(faces.FindKey(f));
                if (!intersectsProfileRayBounds(profile, face, dir, startLow))
                    continue;
                if (++examined > 512)
                    return trackedError("Next-face search exceeds 512 intersecting candidate faces");
                Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
                if (surface.IsNull() || isParallelTo(untrimmedSurface(surface), dir))
                    continue;
                TrackedShapeResult tool = prismBetweenFaces(profileFace, dir, start, face, 0, true);
                if (!tool.isOk || !capCoversProfile(tool, profileFace, dir, coverageFailure)) {
                    partial.push_back(face);
                    continue;
                }
                GProp_GProps volume;
                BRepGProp::VolumeProperties(tool.shape, volume);
                if (std::abs(volume.Mass()) <= Precision::Confusion())
                    continue;
                valid.push_back({ bodyIndex, f - 1, face, tool, std::abs(volume.Mass()) });
                if (valid.size() > 32)
                    return trackedError("Next-face search exceeds 32 valid bounded tools");
            }
        }
        if (valid.empty())
            return trackedError("No complete next face is reached along the extrusion direction; partial or piecewise caps are unsupported" + (coverageFailure.empty() ? std::string() : ": " + coverageFailure));
        std::vector<bool> dominated(valid.size(), false);
        for (size_t a = 0; a < valid.size(); a++)
            for (size_t b = a + 1; b < valid.size(); b++) {
                BRepAlgoAPI_Common common(valid[a].tool.shape, valid[b].tool.shape);
                common.SetNonDestructive(true);
                common.Build();
                if (!common.IsDone() || common.HasErrors())
                    return trackedError("Cannot compare next-face candidate containment");
                GProp_GProps volume;
                BRepGProp::VolumeProperties(common.Shape(), volume);
                double overlap = std::abs(volume.Mass());
                double tolerance = 1e-6 * std::max({ 1.0, valid[a].volume, valid[b].volume });
                bool aInB = std::abs(overlap - valid[a].volume) <= tolerance;
                bool bInA = std::abs(overlap - valid[b].volume) <= tolerance;
                if (aInB && !bInA)
                    dominated[b] = true;
                if (bInA && !aInB)
                    dominated[a] = true;
            }
        int selected = -1;
        for (size_t i = 0; i < valid.size(); i++)
            if (!dominated[i]) {
                if (selected >= 0)
                    return trackedError("The next face is ambiguous: candidate caps tie or cross across the profile");
                selected = static_cast<int>(i);
            }
        if (selected < 0)
            return trackedError("The next face ordering is ambiguous");
        Candidate& chosen = valid[selected];
        // A nearer partial cap means the first boundary is piecewise, even if a farther face
        // can cap the complete profile. Do not silently skip that obstruction.
        for (const TopoDS_Face& face : partial) {
            BRepAlgoAPI_Common common(face, chosen.tool.shape);
            common.SetNonDestructive(true);
            common.Build();
            if (!common.IsDone() || common.HasErrors())
                return trackedError("Cannot validate partial next-face candidates");
            GProp_GProps area;
            BRepGProp::SurfaceProperties(common.Shape(), area);
            if (std::abs(area.Mass()) > 1e-6)
                return trackedError("The next boundary is partial or piecewise; one uniformly nearest full-coverage face is required");
        }
        TrackedShapeResult result = chosen.tool;
        if (offset != 0) {
            gp_Trsf move;
            move.SetTranslation(gp_Vec(dir) * offset);
            TopoDS_Face end = TopoDS::Face(chosen.cap.Moved(TopLoc_Location(move)));
            result = prismBetweenFaces(profileFace, dir, start, end, 0, true);
            if (!result.isOk || !capCoversProfile(result, profileFace, dir, coverageFailure))
                return trackedError("The next-face offset does not completely bound the extrusion");
        }
        result.nextTargetIndex = chosen.body;
        result.nextFaceIndex = chosen.face;
        return result;
    }

    // Tool prism of `profile` along `direction` through everything in `bounds`: it ends on the
    // plane normal to the direction at the farthest point of the bounds (`flush`, for a join)
    // or past it (for a cut). A profile normal to the direction is a plain prism; a slanted
    // one is bounded by that plane, so the end cap is flat either way.
    static TrackedShapeResult prismThruAllTracked(const TopoDS_Shape& profile, const Vector3& direction,
        const ShapeArray& bounds, bool flush)
    {
        if (!isUsableDirection(direction)) {
            return trackedError("The extrude direction is zero");
        }
        gp_Dir dir = Vector3::toDir(direction);
        std::string error = profileError(profile, dir);
        if (!error.empty()) {
            return trackedError(error);
        }
        std::vector<TopoDS_Shape> boundShapes;
        for (const TopoDS_Shape& shape : vecFromJSArray<TopoDS_Shape>(bounds)) {
            if (!shape.IsNull()) {
                boundShapes.push_back(shape);
            }
        }
        TopoDS_Compound boundsCompound = compoundOf(boundShapes);
        double profileLow, profileHigh, boundsLow, boundsHigh;
        Bnd_Box scene;
        if (!projectedRange(profile, dir, profileLow, profileHigh) || !boxOf(profile, scene)) {
            return trackedError("The extrude profile has no extent");
        }
        if (!projectedRange(boundsCompound, dir, boundsLow, boundsHigh) || !boxOf(boundsCompound, scene)) {
            return trackedError("There is nothing to extrude through");
        }
        if (boundsHigh <= profileLow + Precision::Confusion()) {
            return trackedError("There is nothing to extrude through along the extrude direction");
        }
        double size = std::sqrt(scene.SquareExtent());
        double end = flush ? boundsHigh : boundsHigh + 0.05 * size + 1;

        if (profileHigh - profileLow <= 1e-6 * (1 + size)) {
            gp_Vec vec = gp_Vec(dir) * (end - profileLow);
            BRepPrimAPI_MakePrism prism(profile, vec);
            if (!prism.IsDone()) {
                return trackedError("Failed to create prism");
            }
            TrackedShapeResult result { prism.Shape(), true, "", faceHistory(prism, profile, prism.Shape()),
                edgeHistory(prism, profile, prism.Shape()), faceFromEdgeHistory(prism, profile, prism.Shape()) };
            result.capFaces = sweepCapFaces(prism, prism.Shape());
            return result;
        }

        double xmin, ymin, zmin, xmax, ymax, zmax;
        scene.Get(xmin, ymin, zmin, xmax, ymax, zmax);
        gp_Pnt center((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2);
        gp_Pnt onPlane = center.Translated(gp_Vec(dir) * (end - gp_Vec(center.XYZ()).Dot(gp_Vec(dir))));
        double half = size + 1;
        BRepBuilderAPI_MakeFace makePlane(gp_Pln(onPlane, dir), -half, half, -half, half);
        if (!makePlane.IsDone()) {
            return trackedError("Failed to create the end plane");
        }
        double length = end - profileLow + 0.1 * (end - profileLow) + 1;
        TrackedShapeResult result = boundedPrism(profile, gp_Vec(dir) * length, makePlane.Face());
        if (!result.isOk && result.error.empty()) {
            result.error = "There is nothing to extrude through along the extrude direction";
        }
        return result;
    }

    static ShapeResult pushPull(const TopoDS_Shape& sbase, const TopoDS_Shape& pbase, const Vector3& vec)
    {
        gp_Vec v = Vector3::toVec(vec);
        gp_Trsf trsf;
        trsf.SetTranslation(v);
        BRepBuilderAPI_Transform transform(trsf);
        transform.Perform(pbase);
        gp_Dir dir(v);
        auto sur = BRep_Tool::Surface(TopoDS::Face(pbase));
        auto plane = Handle(Geom_Plane)::DownCast(sur);
        auto method = plane->Pln().Axis().Direction().Dot(dir) > 0 ? 1 : 0;
        if (pbase.Orientation() == TopAbs_REVERSED) {
            method = 1 - method;
        }
        BRepFeat_MakePrism prism(sbase, pbase, TopoDS::Face(transform.Shape()), dir, method, false);
        prism.Perform(v.Magnitude());
        if (!prism.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create prism" };
        }
        return ShapeResult { prism.Shape(), true, "" };
    }

    static ShapeResult polygon(const Vector3Array& points)
    {
        std::vector<Vector3> vector3s = vecFromJSArray<Vector3>(points);
        std::vector<gp_Pnt> pnts;
        for (auto& p : vector3s) {
            pnts.push_back(Vector3::toPnt(p));
        }
        return pointsToWire(pnts);
    }

    static ShapeResult arc(const Vector3& normal, const Vector3& center, const Vector3& start, double rad)
    {
        gp_Pnt centerPnt = Vector3::toPnt(center);
        gp_Pnt startPnt = Vector3::toPnt(start);
        gp_Dir xvec = gp_Dir(startPnt.XYZ() - centerPnt.XYZ());
        gp_Ax2 ax2(centerPnt, Vector3::toDir(normal), xvec);
        gp_Circ circ(ax2, centerPnt.Distance(startPnt));
        double startAng(0), endAng(rad);
        if (rad < 0) {
            startAng = Math::PI_2 + rad;
            endAng = Math::PI_2;
        }
        BRepBuilderAPI_MakeEdge edge(circ, startAng, endAng);
        if (!edge.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create arc" };
        }
        return ShapeResult { edge.Edge(), true, "" };
    }

    static ShapeResult circle(const Vector3& normal, const Vector3& center, double radius)
    {
        gp_Ax2 ax2(Vector3::toPnt(center), Vector3::toDir(normal));
        gp_Circ circ(ax2, radius);
        BRepBuilderAPI_MakeEdge edge(circ);
        if (!edge.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create circle" };
        }
        return ShapeResult { edge.Edge(), true, "" };
    }

    static ShapeResult rect(const Pln& pln, double width, double height)
    {
        BRepBuilderAPI_MakeFace makeFace(Pln::toPln(pln), 0, width, 0, height);
        if (!makeFace.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create rectangle" };
        }
        return ShapeResult { makeFace.Face(), true, "" };
    }

    static ShapeResult bezier(const Vector3Array& points, const NumberArray& weights)
    {
        std::vector<Vector3> pts = vecFromJSArray<Vector3>(points);
        NCollection_Array1<gp_Pnt> arrayofPnt(1, pts.size());
        for (int i = 0; i < pts.size(); i++) {
            arrayofPnt.SetValue(i + 1, Vector3::toPnt(pts[i]));
        }

        std::vector<double> wts = vecFromJSArray<double>(weights);
        NCollection_Array1<double> arrayOfWeight(1, wts.size());
        for (int i = 0; i < wts.size(); i++) {
            arrayOfWeight.SetValue(i + 1, wts[i]);
        }

        Handle(Geom_Curve) curve = wts.size() > 0 ? new Geom_BezierCurve(arrayofPnt, arrayOfWeight) : new Geom_BezierCurve(arrayofPnt);
        BRepBuilderAPI_MakeEdge edge(curve);
        if (!edge.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create bezier" };
        }
        return ShapeResult { edge.Edge(), true, "" };
    }

    // One B-spline edge from poles and knots in OCCT's layout: `knots` distinct and increasing with
    // their `mults`, `weights` empty (non-rational) or one per pole. A periodic curve has
    // sum(mults) - mults(last) poles, the first and last multiplicity equal. Everything
    // Geom_BSplineCurve would raise on is checked first, so the error names the problem.
    static ShapeResult bspline(const Vector3Array& poles, const NumberArray& knots, const NumberArray& mults,
        int degree, bool periodic, const NumberArray& weights)
    {
        std::vector<Vector3> pts = vecFromJSArray<Vector3>(poles);
        std::vector<double> knotValues = vecFromJSArray<double>(knots);
        std::vector<int> multValues = vecFromJSArray<int>(mults);
        std::vector<double> wts = vecFromJSArray<double>(weights);
        if (degree < 1 || degree > Geom_BSplineCurve::MaxDegree()) {
            return ShapeResult { TopoDS_Shape(), false, "B-spline degree must be 1.." + std::to_string(Geom_BSplineCurve::MaxDegree()) };
        }
        if (knotValues.size() < 2 || knotValues.size() != multValues.size()) {
            return ShapeResult { TopoDS_Shape(), false, "B-spline needs at least two knots, one multiplicity per knot" };
        }
        int multSum = 0;
        for (size_t i = 0; i < knotValues.size(); i++) {
            if (i > 0 && !(knotValues[i] > knotValues[i - 1] + Precision::PConfusion())) {
                return ShapeResult { TopoDS_Shape(), false, "B-spline knots must be strictly increasing" };
            }
            bool end = i == 0 || i + 1 == knotValues.size();
            if (multValues[i] < 1 || multValues[i] > (end && !periodic ? degree + 1 : degree)) {
                return ShapeResult { TopoDS_Shape(), false, "B-spline multiplicity out of range" };
            }
            multSum += multValues[i];
        }
        if (periodic && multValues.front() != multValues.back()) {
            return ShapeResult { TopoDS_Shape(), false, "Periodic B-spline needs equal first and last multiplicities" };
        }
        int poleCount = periodic ? multSum - multValues.back() : multSum - degree - 1;
        if (poleCount < 2 || static_cast<size_t>(poleCount) != pts.size()) {
            return ShapeResult { TopoDS_Shape(), false, "B-spline pole count does not match its knots" };
        }
        if (!wts.empty() && wts.size() != pts.size()) {
            return ShapeResult { TopoDS_Shape(), false, "B-spline needs one weight per pole" };
        }
        NCollection_Array1<gp_Pnt> arrayOfPole(1, pts.size());
        for (size_t i = 0; i < pts.size(); i++) {
            arrayOfPole.SetValue(i + 1, Vector3::toPnt(pts[i]));
        }
        NCollection_Array1<double> arrayOfKnot(1, knotValues.size());
        NCollection_Array1<int> arrayOfMult(1, multValues.size());
        for (size_t i = 0; i < knotValues.size(); i++) {
            arrayOfKnot.SetValue(i + 1, knotValues[i]);
            arrayOfMult.SetValue(i + 1, multValues[i]);
        }
        Handle(Geom_BSplineCurve) curve;
        if (wts.empty()) {
            curve = new Geom_BSplineCurve(arrayOfPole, arrayOfKnot, arrayOfMult, degree, periodic);
        } else {
            NCollection_Array1<double> arrayOfWeight(1, wts.size());
            for (size_t i = 0; i < wts.size(); i++) {
                if (!(wts[i] > 0)) {
                    return ShapeResult { TopoDS_Shape(), false, "B-spline weights must be positive" };
                }
                arrayOfWeight.SetValue(i + 1, wts[i]);
            }
            curve = new Geom_BSplineCurve(arrayOfPole, arrayOfWeight, arrayOfKnot, arrayOfMult, degree, periodic);
        }
        BRepBuilderAPI_MakeEdge edge(curve);
        if (!edge.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create B-spline" };
        }
        return ShapeResult { edge.Edge(), true, "" };
    }

    static ShapeResult helix(
        const Vector3& origin,
        const Vector3& normal,
        const Vector3& xDir,
        double radius,
        double pitch,
        double angle)
    {
        if (radius < Precision::Confusion()) {
            return ShapeResult { TopoDS_Shape(), false, "The radius is too small." };
        }
        if (std::abs(pitch) < Precision::Confusion()) {
            return ShapeResult { TopoDS_Shape(), false, "The pitch is too small." };
        }
        if (std::abs(angle) < Precision::Angular()) {
            return ShapeResult { TopoDS_Shape(), false, "The angle is too small." };
        }

        gp_Ax3 axis(Vector3::toPnt(origin), Vector3::toDir(normal), Vector3::toDir(xDir));

        NCollection_Array1<double> pitches(1, 1);
        pitches(1) = pitch;
        NCollection_Array1<double> nbTurns(1, 1);
        nbTurns(1) = std::abs(angle) / Math::PI_2;

        HelixBRep_BuilderHelix helixBuilder;
        helixBuilder.SetParameters(axis, 2.0 * radius, pitches, nbTurns);
        helixBuilder.Perform();

        if (helixBuilder.ErrorStatus() != 0) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create helix" };
        }

        return ShapeResult { helixBuilder.Shape(), true, "" };
    }

    static ShapeResult point(const Vector3& point)
    {
        BRepBuilderAPI_MakeVertex makeVertex(Vector3::toPnt(point));
        if (!makeVertex.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create point" };
        }
        return ShapeResult { makeVertex.Vertex(), true, "" };
    }

    static ShapeResult line(const Vector3& start, const Vector3& end)
    {
        BRepBuilderAPI_MakeEdge makeEdge(Vector3::toPnt(start), Vector3::toPnt(end));
        if (!makeEdge.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create line" };
        }
        return ShapeResult { makeEdge.Edge(), true, "" };
    }

    struct EdgeEndpoints {
        gp_Pnt first;
        gp_Pnt last;
    };

    // Returns the unused edge whose endpoint is nearest to either chain end within confusion
    // tolerance, or ends.size() when nothing connects. `prepend` selects the chain end to
    // extend, `reversed` tells whether the edge must be flipped to continue the chain.
    static size_t nextChainEdge(
        const std::vector<EdgeEndpoints>& ends,
        const std::vector<bool>& used,
        const gp_Pnt& front,
        const gp_Pnt& back,
        bool& prepend,
        bool& reversed)
    {
        size_t next = ends.size();
        double best = Precision::Confusion() * Precision::Confusion();
        for (size_t i = 0; i < ends.size(); i++) {
            if (used[i]) {
                continue;
            }
            auto tryCandidate = [&](double squareDistance, bool candidatePrepend, bool candidateReversed) {
                if (squareDistance < best) {
                    best = squareDistance;
                    next = i;
                    prepend = candidatePrepend;
                    reversed = candidateReversed;
                }
            };
            tryCandidate(back.SquareDistance(ends[i].first), false, false);
            tryCandidate(back.SquareDistance(ends[i].last), false, true);
            tryCandidate(front.SquareDistance(ends[i].last), true, false);
            tryCandidate(front.SquareDistance(ends[i].first), true, true);
        }
        return next;
    }

    // Chains edges into a wire deterministically: start from the first edge, then repeatedly
    // extend the chain at whichever end has the nearest connecting edge, reversing edges
    // that connect backwards. Extending at both ends is required because the first edge may
    // sit anywhere along the geometric chain. ShapeAnalysis_WireOrder was dropped: with
    // near-coincident endpoints (e.g. edges from an offset curve) it could assign a wrong
    // orientation, twisting the wire.
    static bool orderEdge(const std::vector<TopoDS_Edge>& edges, std::vector<TopoDS_Edge>& ordered)
    {
        ShapeAnalysis_Edge analysis;
        std::vector<EdgeEndpoints> ends;
        ends.reserve(edges.size());
        for (const auto& edge : edges) {
            ends.push_back(
                { BRep_Tool::Pnt(analysis.FirstVertex(edge)), BRep_Tool::Pnt(analysis.LastVertex(edge)) });
        }

        std::vector<bool> used(edges.size(), false);
        used[0] = true;
        std::deque<std::pair<size_t, bool>> chain; // (edge index, reversed)
        chain.emplace_back(0, false);
        gp_Pnt front = ends[0].first;
        gp_Pnt back = ends[0].last;

        for (size_t count = 1; count < edges.size(); count++) {
            bool prepend = false;
            bool reversed = false;
            size_t next = nextChainEdge(ends, used, front, back, prepend, reversed);
            if (next == edges.size()) {
                return false; // remaining edges are disconnected from the chain
            }
            if (prepend) {
                chain.emplace_front(next, reversed);
                front = reversed ? ends[next].last : ends[next].first;
            } else {
                chain.emplace_back(next, reversed);
                back = reversed ? ends[next].first : ends[next].last;
            }
            used[next] = true;
        }

        ordered.reserve(edges.size());
        for (const auto& [index, reversed] : chain) {
            TopoDS_Edge edge = edges[index];
            if (reversed) {
                edge.Reverse();
            }
            ordered.push_back(edge);
        }
        return true;
    }

    static ShapeResult wire(const EdgeArray& edges)
    {
        std::vector<TopoDS_Edge> edgesVec = vecFromJSArray<TopoDS_Edge>(edges);
        if (edgesVec.size() == 0) {
            return ShapeResult { TopoDS_Shape(), false, "No edges provided" };
        }

        // BRepBuilderAPI_MakeWire replaces coincident vertices of the added edges in place
        // (vertex sharing). Repeated calls with the same input edges would progressively
        // corrupt them, so build from copies instead.
        std::vector<TopoDS_Edge> copies;
        copies.reserve(edgesVec.size());
        for (auto& edge : edgesVec) {
            copies.push_back(TopoDS::Edge(BRepBuilderAPI_Copy(edge).Shape()));
        }

        BRepBuilderAPI_MakeWire wire;
        if (copies.size() == 1) {
            wire.Add(copies[0]);
        } else {
            std::vector<TopoDS_Edge> ordered;
            if (!orderEdge(copies, ordered)) {
                return ShapeResult { TopoDS_Shape(), false, mapBuildWireError(BRepBuilderAPI_DisconnectedWire) };
            }
            for (const auto& edge : ordered) {
                wire.Add(edge);
            }
        }

        if (!wire.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, mapBuildWireError(wire.Error()) };
        }
        return ShapeResult { wire.Wire(), true, "" };
    }

    static ShapeResult face(const WireArray& wires)
    {
        std::vector<TopoDS_Wire> wiresVec = vecFromJSArray<TopoDS_Wire>(wires);
        BRepBuilderAPI_MakeFace makeFace(wiresVec[0]);
        for (int i = 1; i < wiresVec.size(); i++) {
            makeFace.Add(wiresVec[i]);
        }
        if (!makeFace.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create face" };
        }

        ShapeFix_Face faceFix(makeFace.Face());
        faceFix.FixOrientation();
        faceFix.Perform();

        return ShapeResult { faceFix.Face(), true, "" };
    }

    static ShapeResult faceFromSurface(const WireArray& wires, const TopoDS_Face& sourceFace)
    {
        std::vector<TopoDS_Wire> wiresVec = vecFromJSArray<TopoDS_Wire>(wires);
        Handle(Geom_Surface) surface = BRep_Tool::Surface(sourceFace);
        for (auto& w : wiresVec) {
            ShapeFix_Wire sfw(w, sourceFace, Precision::Confusion());
            sfw.FixReorder();
            sfw.FixConnected();
            sfw.Perform();
            w = sfw.Wire();
        }

        BRepBuilderAPI_MakeFace makeFace(surface, wiresVec[0]);
        for (int i = 1; i < wiresVec.size(); i++) {
            makeFace.Add(wiresVec[i]);
        }
        if (!makeFace.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create face from surface" };
        }

        TopoDS_Face surfaceFace = makeFace.Face();

        // Rebuild pcurves on the new face — missing pcurves cause mesh defects.
        BRepLib::BuildCurves3d(surfaceFace, Precision::Confusion());

        ShapeFix_Face faceFix(surfaceFace);
        faceFix.FixOrientation();
        faceFix.Perform();

        return ShapeResult { faceFix.Face(), true, "" };
    }

    // Finds the minimal bounded planar regions of `edges` on `plane` (FreeCAD's
    // FaceMakerBuildFace recipe), with the sorted unique input edge indexes bounding
    // each region. Used for sketch profiles of crossing curves, which endpoint
    // connectivity alone misses.
    static RegionsResult facesFromEdges(const EdgeArray& edges, const Pln& plane)
    {
        std::vector<TopoDS_Edge> edgesVec = vecFromJSArray<TopoDS_Edge>(edges);
        if (edgesVec.empty()) {
            return RegionsResult { ShapeArray(val::array()), { }, { }, false, "No edges provided" };
        }

        NCollection_List<TopoDS_Shape> arguments;
        for (const auto& edge : edgesVec) {
            arguments.Append(edge);
        }
        SplitEdgesResult split = splitAtIntersections(arguments);
        if (!split.isOk) {
            return RegionsResult { ShapeArray(val::array()), { }, { }, false, split.error };
        }

        NCollection_List<TopoDS_Shape> faceEdges;
        double extent;
        TopoDS_Face baseFace = baseFaceForRegions(split.shape, Pln::toPln(plane), faceEdges, extent);
        return boundedAreas(baseFace, faceEdges, extent, split.segments, split.segmentSources);
    }

    static ShapeResult shell(const FaceArray& faces)
    {
        std::vector<TopoDS_Face> facesVec = vecFromJSArray<TopoDS_Face>(faces);

        TopoDS_Shell shell;
        BRep_Builder shellBuilder;
        shellBuilder.MakeShell(shell);
        for (const auto& face : facesVec) {
            shellBuilder.Add(shell, face);
        }

        return ShapeResult { shell, true, "" };
    }

    static ShapeResult solid(const ShellArray& shells)
    {
        std::vector<TopoDS_Shell> shellsVec = vecFromJSArray<TopoDS_Shell>(shells);

        BRepBuilderAPI_MakeSolid makeSolid;
        for (auto shell : shellsVec) {
            makeSolid.Add(shell);
        }
        if (!makeSolid.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create solid" };
        }
        return ShapeResult { makeSolid.Solid(), true, "" };
    }

    // Empty text = the input can be made thick. BRepOffset raises (or loops) on invalid
    // topology, so it is rejected up front with a readable message.
    static std::string thickSolidInputError(const TopoDS_Shape& shape)
    {
        if (shape.IsNull()) {
            return "Failed to create thick solid: the input shape is empty";
        }
        BRepCheck_Analyzer analyzer(shape);
        if (!analyzer.IsValid()) {
            return "Failed to create thick solid: the input shape is not valid (BRepCheck_Analyzer)";
        }
        return "";
    }

    // Empty text = the thick solid is valid. The sampled curve-on-surface test of the default
    // BRepCheck_Analyzer can miss an offset edge whose p-curve disagrees with its 3D curve between
    // sample points (periodic ruled lofts, issue #126): such a solid passes checkShape and the
    // self-interference checks yet breaks every boolean. Only the exact test runs (it covers the
    // sampled one); the sampled one runs again only to word a failure. Re-parameterizing the
    // edges (BRepLib::SameParameter, ShapeFix) does not repair such a result: the offset geometry
    // itself is off, so it is refused.
    static std::string thickSolidResultError(const TopoDS_Shape& thickenedShape)
    {
        if (thickenedShape.IsNull()) {
            return "Failed to create thick solid: empty result";
        }
        if (BRepCheck_Analyzer(thickenedShape, true, false, true).IsValid()) {
            return "";
        }
        if (!BRepCheck_Analyzer(thickenedShape).IsValid()) {
            return "Failed to create thick solid: Thick solid is invalid (BRepCheck_Analyzer)";
        }
        return "Failed to create thick solid: offset edge curves are inconsistent with their surfaces "
               "(exact BRepCheck_Analyzer); thicken a solid loft with open faces instead, or change the "
               "thickness or the sections";
    }

    static const char* offsetErrorName(BRepOffset_Error error)
    {
        if (error == BRepOffset_NoError) {
            // only called when IsDone() is false: the algorithm stopped without a status
            return "no status reported";
        }
        if (error == BRepOffset_UnknownError) {
            return "BRepOffset_UnknownError";
        }
        if (error == BRepOffset_BadNormalsOnGeometry) {
            return "BRepOffset_BadNormalsOnGeometry";
        }
        if (error == BRepOffset_C0Geometry) {
            return "BRepOffset_C0Geometry";
        }
        if (error == BRepOffset_NullOffset) {
            return "BRepOffset_NullOffset";
        }
        if (error == BRepOffset_NotConnectedShell) {
            return "BRepOffset_NotConnectedShell";
        }
        if (error == BRepOffset_CannotTrimEdges) {
            return "BRepOffset_CannotTrimEdges";
        }
        if (error == BRepOffset_CannotFuseVertices) {
            return "BRepOffset_CannotFuseVertices";
        }
        if (error == BRepOffset_CannotExtentEdge) {
            return "BRepOffset_CannotExtentEdge";
        }
        if (error == BRepOffset_UserBreak) {
            return "BRepOffset_UserBreak";
        }
        if (error == BRepOffset_MixedConnectivity) {
            return "BRepOffset_MixedConnectivity";
        }
        return "BRepOffset_UnknownError";
    }

    // A rebuilt container can differ in identity while retaining exactly the input's faces.
    // A real thickening adds offset/rim faces even when it also retains the original skin.
    static bool thickSolidUnchanged(const TopoDS_Shape& input, const TopoDS_Shape& thickenedShape)
    {
        if (thickenedShape.IsSame(input)) {
            return true;
        }
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> inputFaces;
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> resultFaces;
        TopExp::MapShapes(input, TopAbs_FACE, inputFaces);
        TopExp::MapShapes(thickenedShape, TopAbs_FACE, resultFaces);
        if (inputFaces.IsEmpty() || inputFaces.Extent() != resultFaces.Extent()) {
            return false;
        }
        for (const auto& face : inputFaces) {
            if (!resultFaces.Contains(face)) {
                return false;
            }
        }
        return true;
    }

    // Identity is insufficient after offset/repair rebuilds every face.
    static bool thickSolidGeometricallyUnchanged(const TopoDS_Shape& input, const TopoDS_Shape& thickenedShape, double thickness)
    {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> solids;
        TopExp::MapShapes(input, TopAbs_SOLID, solids);
        if (solids.IsEmpty() || thickenedShape.IsNull())
            return false;
        GProp_GProps inputVolume, resultVolume, inputArea, resultArea;
        BRepGProp::VolumeProperties(input, inputVolume);
        BRepGProp::VolumeProperties(thickenedShape, resultVolume);
        BRepGProp::SurfaceProperties(input, inputArea);
        BRepGProp::SurfaceProperties(thickenedShape, resultArea);
        return std::abs(std::abs(inputVolume.Mass()) - std::abs(resultVolume.Mass())) <= 1e-4 * std::abs(inputArea.Mass() * thickness)
            && std::abs(inputArea.Mass() - resultArea.Mass()) <= 1e-9 * std::max(1.0, inputArea.Mass());
    }

    // An interior point of every removed face must lie outside the material. A
    // topological Contains test cannot detect rebuilt copies of the opening.
    static std::string thickSolidOpeningError(const TopoDS_Shape& thickenedShape, const NCollection_List<TopoDS_Shape>& openings)
    {
        for (const auto& face : openings) {
            gp_Pnt witness;
            if (!profileWitness(TopoDS::Face(face), witness))
                return "Failed to create thick solid: cannot verify an opening face interior";
            BRepClass3d_SolidClassifier classifier(thickenedShape, witness, Precision::Confusion());
            if (classifier.State() != TopAbs_OUT)
                return "Failed to create thick solid: the offset did not remove an opening face";
        }
        return "";
    }

    static ShapeResult makeThickSolidBySimple(const TopoDS_Shape& shape, double thickness)
    {
        std::string inputError = thickSolidInputError(shape);
        if (!inputError.empty()) {
            return ShapeResult { TopoDS_Shape(), false, inputError };
        }
        BRepOffsetAPI_MakeThickSolid makeThickSolid;
        makeThickSolid.MakeThickSolidBySimple(shape, thickness);
        if (!makeThickSolid.IsDone() || makeThickSolid.Shape().IsNull()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create thick solid" };
        }
        if (thickSolidUnchanged(shape, makeThickSolid.Shape()) || thickSolidGeometricallyUnchanged(shape, makeThickSolid.Shape(), thickness)) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create thick solid: the offset returned the input shape unchanged" };
        }
        std::string resultError = thickSolidResultError(makeThickSolid.Shape());
        if (!resultError.empty()) {
            return ShapeResult { TopoDS_Shape(), false, resultError };
        }
        return ShapeResult { makeThickSolid.Shape(), true, "" };
    }

    static ShapeResult makeThickSolidByJoin(const TopoDS_Shape& shape,
        const ShapeArray& shapes,
        double thickness,
        const GeomAbs_JoinType& joinType,
        const BRepOffset_Mode& mode,
        bool intersection)
    {
        std::string inputError = thickSolidInputError(shape);
        if (!inputError.empty()) {
            return ShapeResult { TopoDS_Shape(), false, inputError };
        }
        auto shapesList = shapeArrayToListOfShape(shapes);

        BRepOffsetAPI_MakeThickSolid makeThickSolid;
        makeThickSolid.MakeThickSolidByJoin(shape, shapesList, thickness, 1e-6, mode, intersection, false, joinType);
        if (!makeThickSolid.IsDone() || makeThickSolid.MakeOffset().Error() != BRepOffset_NoError) {
            return ShapeResult { TopoDS_Shape(), false,
                std::string("Failed to create thick solid: ") + offsetErrorName(makeThickSolid.MakeOffset().Error()) };
        }
        std::string resultError = thickSolidResultError(makeThickSolid.Shape());
        if (!resultError.empty()) {
            return ShapeResult { TopoDS_Shape(), false, resultError };
        }
        // IsDone and BRepCheck can both pass when the offset collapses and OCCT
        // rebuilds the input solid. A shell must actually remove its closing faces.
        if (thickSolidGeometricallyUnchanged(shape, makeThickSolid.Shape(), thickness)
            || thickSolidUnchanged(shape, makeThickSolid.Shape())) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create thick solid: the offset returned the input shape unchanged" };
        }
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> resultFaces;
        TopExp::MapShapes(makeThickSolid.Shape(), TopAbs_FACE, resultFaces);
        for (const auto& face : shapesList) {
            if (resultFaces.Contains(face)) {
                return ShapeResult { TopoDS_Shape(), false, "Failed to create thick solid: the offset did not remove an opening face" };
            }
        }
        return ShapeResult { makeThickSolid.Shape(), true, "" };
    }

    // Material envelope, not an offset surface. SelfInter is unimplemented in OCCT 8:
    // use all-parallel intersection trimming, and handle proven analytic cavity collapse.
    static ShapeResult makeThickSolidTolerant(const TopoDS_Shape& shape,
        const ShapeArray& openingFaces, double thickness)
    {
        const auto inputError = thickSolidInputError(shape);
        if (!inputError.empty())
            return ShapeResult { TopoDS_Shape(), false, inputError };
        if (!std::isfinite(thickness) || std::abs(thickness) < 1e-6)
            return ShapeResult { TopoDS_Shape(), false, "Tolerant thickness must be finite and non-zero" };
        const auto openings = shapeArrayToListOfShape(openingFaces);
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> solids, faces;
        TopExp::MapShapes(shape, TopAbs_SOLID, solids);
        TopExp::MapShapes(shape, TopAbs_FACE, faces);
        if (solids.Extent() != 1)
            return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope currently requires one solid; open skins are unsupported" };
        GProp_GProps sourceMass;
        BRepGProp::VolumeProperties(shape, sourceMass);
        const double sourceVolume = sourceMass.Mass();
        if (!std::isfinite(sourceVolume) || sourceVolume <= 0)
            return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope requires positive input volume" };
        // A complete sphere/ring torus has no inward cavity once the local radius is
        // consumed. Check topology AND exact mass/area to exclude trimmed surfaces.
        if (openings.IsEmpty() && thickness < 0 && faces.Extent() == 1) {
            BRepAdaptor_Surface surface(TopoDS::Face(faces.FindKey(1)));
            double radius = 0, expectedVolume = 0, expectedArea = 0;
            if (surface.GetType() == GeomAbs_Sphere) {
                radius = surface.Sphere().Radius();
                expectedVolume = 4 * M_PI * radius * radius * radius / 3;
                expectedArea = 4 * M_PI * radius * radius;
            } else if (surface.GetType() == GeomAbs_Torus) {
                const auto torus = surface.Torus();
                radius = torus.MinorRadius();
                if (torus.MajorRadius() > radius) {
                    expectedVolume = 2 * M_PI * M_PI * torus.MajorRadius() * radius * radius;
                    expectedArea = 4 * M_PI * M_PI * torus.MajorRadius() * radius;
                }
            }
            GProp_GProps surfaceArea;
            BRepGProp::SurfaceProperties(shape, surfaceArea);
            if (expectedVolume > 0 && -thickness >= radius
                && std::abs(sourceVolume - expectedVolume) <= 1e-6 * expectedVolume
                && std::abs(surfaceArea.Mass() - expectedArea) <= 1e-6 * expectedArea) {
                BRepBuilderAPI_Copy copy(shape);
                return ShapeResult { copy.Shape(), true, "" };
            }
        }
        // Preserve ordinary arc results (notably tapered circular lofts). The
        // intersection envelope is only a recovery path, never a downgrade.
        auto ordinary = makeThickSolidByJoin(shape, openingFaces, thickness, GeomAbs_Arc, BRepOffset_Skin, false);
        if (ordinary.isOk) {
            if (!openings.IsEmpty()) {
                GProp_GProps wallMass;
                BRepGProp::VolumeProperties(ordinary.shape, wallMass);
                // Ordinary arc can legitimately fill a small opening at a tapered
                // tip. Preserve that result, but never accept the unchanged solid.
                if (std::isfinite(wallMass.Mass()) && wallMass.Mass() > 0
                    && (thickness > 0 || wallMass.Mass() < sourceVolume * (1 - 1e-7)))
                    return ordinary;
            } else {
                TopoDS_Shape cavity = ordinary.shape;
                GProp_GProps cavityMass;
                BRepGProp::VolumeProperties(cavity, cavityMass);
                if (cavityMass.Mass() < 0)
                    cavity.Reverse();
                BRepAlgoAPI_Cut wall(thickness < 0 ? shape : cavity, thickness < 0 ? cavity : shape);
                wall.SetNonDestructive(true);
                wall.Build();
                if (wall.IsDone() && !wall.HasErrors() && thickSolidResultError(wall.Shape()).empty()) {
                    GProp_GProps wallMass;
                    BRepGProp::VolumeProperties(wall.Shape(), wallMass);
                    if (std::isfinite(wallMass.Mass()) && wallMass.Mass() > 0
                        && !thickSolidGeometricallyUnchanged(shape, wall.Shape(), thickness)
                        && (thickness > 0 || wallMass.Mass() < sourceVolume * (1 - 1e-7)))
                        return ShapeResult { wall.Shape(), true, "" };
                }
            }
        }
        // OCCT's incomplete all-parallel trimming is not a free-form crease envelope.
        for (const auto& face : faces) {
            const auto type = BRepAdaptor_Surface(TopoDS::Face(face)).GetType();
            if (type != GeomAbs_Plane && type != GeomAbs_Cylinder && type != GeomAbs_Cone
                && type != GeomAbs_Sphere && type != GeomAbs_Torus)
                return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope: free-form crease envelopes are not supported" };
        }
        BRepOffsetAPI_MakeThickSolid offset;
        offset.MakeThickSolidByJoin(shape, openings, thickness, 1e-6,
            BRepOffset_Skin, true, false, GeomAbs_Intersection, true);
        if (!offset.IsDone() || offset.MakeOffset().Error() != BRepOffset_NoError)
            return ShapeResult { TopoDS_Shape(), false,
                std::string("Tolerant envelope failed: ") + offsetErrorName(offset.MakeOffset().Error())
                    + "; OCCT cannot trim this geometry (free-form curvature collapse remains unsupported)" };
        TopoDS_Shape thickenedShape = offset.Shape();
        if (thickSolidUnchanged(shape, thickenedShape) || thickSolidGeometricallyUnchanged(shape, thickenedShape, thickness))
            return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope failed: offset returned the input unchanged (unrecognized cavity collapse)" };
        GProp_GProps offsetMass;
        BRepGProp::VolumeProperties(thickenedShape, offsetMass);
        if (offsetMass.Mass() < 0)
            thickenedShape.Reverse();
        if (openings.IsEmpty()) {
            if (thickSolidUnchanged(shape, thickenedShape))
                return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope failed: unrecognized cavity collapse" };
            BRepAlgoAPI_Cut wall(thickness < 0 ? shape : thickenedShape, thickness < 0 ? thickenedShape : shape);
            wall.SetNonDestructive(true);
            wall.Build();
            if (!wall.IsDone() || wall.HasErrors())
                return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope wall boolean failed" };
            thickenedShape = wall.Shape();
        }
        ShapeFix_Shape fix(thickenedShape);
        fix.Perform();
        ShapeUpgrade_UnifySameDomain unify(fix.Shape(), true, true, false);
        unify.Build();
        thickenedShape = unify.Shape();
        const auto validationError = thickSolidResultError(thickenedShape);
        if (!validationError.empty())
            return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope: " + validationError };
        GProp_GProps mass;
        BRepGProp::VolumeProperties(thickenedShape, mass);
        if (!std::isfinite(mass.Mass()) || mass.Mass() <= 0
            || (thickness < 0 && mass.Mass() >= sourceVolume * (1 - 1e-7)))
            return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope failed volume sanity check" };
        const auto openingError = thickSolidOpeningError(thickenedShape, openings);
        if (!openingError.empty())
            return ShapeResult { TopoDS_Shape(), false, "Tolerant envelope: " + openingError };
        return ShapeResult { thickenedShape, true, "" };
    }

    // Removes every edge of `shape` that is not in `keepShapes` through the given
    // ReShape. Returns true if at least one edge was removed.
    static bool removeNonKeptEdges(
        BRepTools_ReShape& reshape,
        const TopoDS_Shape& shape,
        const NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& keepShapes)
    {
        bool removed = false;
        for (TopExp_Explorer edgeExplorer(shape, TopAbs_EDGE); edgeExplorer.More(); edgeExplorer.Next()) {
            if (!keepShapes.Contains(edgeExplorer.Current())) {
                reshape.Remove(edgeExplorer.Current());
                removed = true;
            }
        }
        return removed;
    }

    // Splitting a face with an edge that ends inside the face leaves a dangling "spur"
    // edge as an open internal wire. UnifySameDomain cannot remove it, and the shared
    // vertex also blocks unification of the collinear boundary edges it touches. Such
    // open internal wires are invalid as holes, so drop them before unifying. A spur
    // wire is dropped entirely only when none of its edges is requested to be kept;
    // otherwise only the edges that are not in keepShapes are removed from it.
    // Returns true if anything was removed from `face`.
    static bool removeSpurWires(
        BRepTools_ReShape& reshape,
        const TopoDS_Shape& face,
        const NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& keepShapes)
    {
        TopExp_Explorer wireExplorer(face, TopAbs_WIRE);
        if (!wireExplorer.More()) {
            return false;
        }
        bool removed = false;
        // The first wire is the outer boundary and is always kept.
        for (wireExplorer.Next(); wireExplorer.More(); wireExplorer.Next()) {
            const TopoDS_Shape& wire = wireExplorer.Current();
            if (BRep_Tool::IsClosed(wire)) {
                continue;
            }
            bool hasKeptEdge = false;
            for (TopExp_Explorer edgeExplorer(wire, TopAbs_EDGE); edgeExplorer.More(); edgeExplorer.Next()) {
                if (keepShapes.Contains(edgeExplorer.Current())) {
                    hasKeptEdge = true;
                    break;
                }
            }
            if (!hasKeptEdge) {
                reshape.Remove(wire);
                removed = true;
            } else if (removeNonKeptEdges(reshape, wire, keepShapes)) {
                removed = true;
            }
        }
        return removed;
    }

    // Returns true when `face` has at least one edge and every boundary edge is in `keepShapes`.
    static bool isFullyKeptFace(
        const TopoDS_Shape& face,
        const NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& keepShapes)
    {
        bool hasEdge = false;
        for (TopExp_Explorer edgeExplorer(face, TopAbs_EDGE); edgeExplorer.More(); edgeExplorer.Next()) {
            if (!keepShapes.Contains(edgeExplorer.Current())) {
                return false;
            }
            hasEdge = true;
        }
        return hasEdge;
    }

    // Prepares `shape` for UnifySameDomain in a single traversal with a single ReShape:
    // drops spur wires (see removeSpurWires) and detaches faces that are fully bounded
    // by kept edges. Such faces must survive unification as separate faces: with
    // AllowInternalEdges enabled, UnifySameDomain would otherwise merge them into their
    // same-domain neighbors and demote the kept edges to internal edges of the merged
    // face. Detached faces are appended to `protectedFaces`; the caller sews them back
    // after unifying. A fully kept face needs no spur check: every edge of it is kept,
    // so spur removal would be a no-op for it anyway.
    static TopoDS_Shape preprocessForUnify(
        const TopoDS_Shape& shape,
        const NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& keepShapes,
        NCollection_List<TopoDS_Shape>& protectedFaces)
    {
        BRepTools_ReShape reshape;
        bool modified = false;
        for (TopExp_Explorer faceExplorer(shape, TopAbs_FACE); faceExplorer.More(); faceExplorer.Next()) {
            const TopoDS_Shape& face = faceExplorer.Current();
            if (!keepShapes.IsEmpty() && isFullyKeptFace(face, keepShapes)) {
                reshape.Remove(face);
                protectedFaces.Append(face);
                modified = true;
                continue;
            }
            modified |= removeSpurWires(reshape, face, keepShapes);
        }
        return modified ? reshape.Apply(shape) : shape;
    }

    static ShapeResult simplifyShape(
        const TopoDS_Shape& shape,
        const bool theUnifyEdges,
        const bool theUnifyFaces,
        const ShapeArray& keepShapes,
        double linearTolerance,
        double angularTolerance)
    {
        auto keepShapesList = shapeArrayToMapOfShape(keepShapes);

        NCollection_List<TopoDS_Shape> protectedFaces;
        TopoDS_Shape input = preprocessForUnify(shape, keepShapesList, protectedFaces);
        if (!protectedFaces.IsEmpty() && !TopExp_Explorer(input, TopAbs_FACE).More()) {
            // Every face is fully bounded by kept edges; nothing can be unified.
            return ShapeResult { shape, true, "" };
        }

        ShapeUpgrade_UnifySameDomain anUnifier(input, theUnifyEdges, theUnifyFaces, true);
        anUnifier.SetLinearTolerance(linearTolerance);
        anUnifier.SetAngularTolerance(angularTolerance);
        anUnifier.KeepShapes(keepShapesList);
        if (!keepShapesList.IsEmpty()) {
            anUnifier.AllowInternalEdges(true);
        }
        anUnifier.Build();

        TopoDS_Shape result = anUnifier.Shape();
        if (!protectedFaces.IsEmpty()) {
            BRepBuilderAPI_Sewing sewing;
            sewing.Add(result);
            for (const auto& face : protectedFaces) {
                sewing.Add(face);
            }
            sewing.Perform();
            result = sewing.SewedShape();
            if (result.ShapeType() == TopAbs_SHELL && BRep_Tool::IsClosed(result)) {
                BRepBuilderAPI_MakeSolid makeSolid(TopoDS::Shell(result));
                if (makeSolid.IsDone()) {
                    result = makeSolid.Solid();
                }
            }
        }
        return ShapeResult { result, true, "" };
    }

    // Empty text = success. IsDone() alone accepts both a run that reported errors and
    // an empty compound (common of disjoint bodies, cut removing everything).
    static std::string booleanFailure(BRepAlgoAPI_BooleanOperation& boolOperater)
    {
        if (!boolOperater.IsDone() || boolOperater.HasErrors()) {
            std::ostringstream oss;
            boolOperater.DumpErrors(oss);
            auto text = oss.str();
            return text.empty() ? std::string("Boolean operation failed") : text;
        }
        const TopoDS_Shape& shape = boolOperater.Shape();
        // Vertices, not faces: a boolean over curve operands legitimately yields edges only.
        if (shape.IsNull() || !TopExp_Explorer(shape, TopAbs_VERTEX).More()) {
            return "Boolean produced an empty shape";
        }
        return "";
    }

    static ShapeResult booleanOperate(BRepAlgoAPI_BooleanOperation& boolOperater, const ShapeArray& args,
        const ShapeArray& tools)
    {
        auto argsList = shapeArrayToListOfShape(args);
        auto toolsList = shapeArrayToListOfShape(tools);

        boolOperater.SetToFillHistory(false);
        boolOperater.SetArguments(argsList);
        boolOperater.SetTools(toolsList);
        boolOperater.SetFuzzyValue(1e-6);
        boolOperater.Build();

        auto failure = booleanFailure(boolOperater);
        if (!failure.empty()) {
            return ShapeResult { TopoDS_Shape(), false, failure };
        }

        return ShapeResult { boolOperater.Shape(), true, "" };
    }

    static ShapeResult booleanCommon(const ShapeArray& args, const ShapeArray& tools)
    {
        BRepAlgoAPI_Common api;
        return booleanOperate(api, args, tools);
    }

    static ShapeResult booleanCut(const ShapeArray& args, const ShapeArray& tools)
    {
        BRepAlgoAPI_Cut api;
        return booleanOperate(api, args, tools);
    }

    static ShapeResult booleanFuse(const ShapeArray& args, const ShapeArray& tools)
    {
        BRepAlgoAPI_Fuse api;
        return booleanOperate(api, args, tools);
    }

    static TopoDS_Compound compoundOf(const std::vector<TopoDS_Shape>& shapes)
    {
        TopoDS_Compound compound;
        BRep_Builder builder;
        builder.MakeCompound(compound);
        for (auto shape : shapes) {
            builder.Add(compound, shape);
        }
        return compound;
    }

    // Unlike booleanOperate, history filling stays enabled — it is the whole point here.
    // The history input enumerates args then tools, so output indexes >= arg face count
    // originate from a tool body. `simplify` unifies same-domain faces (as the untracked
    // fuse path does); OCCT merges the simplification into the operation history.
    static TrackedShapeResult booleanOperateTracked(BRepAlgoAPI_BooleanOperation& boolOperater,
        const ShapeArray& args, const ShapeArray& tools, bool simplify)
    {
        auto argsList = shapeArrayToListOfShape(args);
        auto toolsList = shapeArrayToListOfShape(tools);

        boolOperater.SetArguments(argsList);
        boolOperater.SetTools(toolsList);
        boolOperater.SetFuzzyValue(1e-6);
        boolOperater.Build();

        auto failure = booleanFailure(boolOperater);
        if (!failure.empty()) {
            return TrackedShapeResult { TopoDS_Shape(), false, failure, { }, { } };
        }

        // SimplifyResult runs after Build; it merges the unification into the history.
        if (simplify) {
            boolOperater.SimplifyResult(true, true);
        }

        TopoDS_Compound inputCompound;
        {
            std::vector<TopoDS_Shape> inputs = vecFromJSArray<TopoDS_Shape>(args);
            auto toolVec = vecFromJSArray<TopoDS_Shape>(tools);
            inputs.insert(inputs.end(), toolVec.begin(), toolVec.end());
            inputCompound = compoundOf(inputs);
        }
        std::vector<int> faceAncestors;
        std::vector<int> edgeAncestors;
        TrackedShapeResult result { boolOperater.Shape(), true, "",
            faceHistory(boolOperater, inputCompound, boolOperater.Shape(), &faceAncestors),
            edgeHistory(boolOperater, inputCompound, boolOperater.Shape(), &edgeAncestors) };
        result.faceAncestors = std::move(faceAncestors);
        result.edgeAncestors = std::move(edgeAncestors);
        return result;
    }

    static TrackedShapeResult booleanCommonTracked(const ShapeArray& args, const ShapeArray& tools)
    {
        BRepAlgoAPI_Common api;
        return booleanOperateTracked(api, args, tools, false);
    }

    static TrackedShapeResult booleanCutTracked(const ShapeArray& args, const ShapeArray& tools)
    {
        BRepAlgoAPI_Cut api;
        return booleanOperateTracked(api, args, tools, false);
    }

    static TrackedShapeResult booleanFuseTracked(const ShapeArray& args, const ShapeArray& tools)
    {
        BRepAlgoAPI_Fuse api;
        return booleanOperateTracked(api, args, tools, true);
    }

    static ShapeResult combine(const ShapeArray& shapes)
    {
        std::vector<TopoDS_Shape> shapesVec = vecFromJSArray<TopoDS_Shape>(shapes);
        return ShapeResult { compoundOf(shapesVec), true, "" };
    }

    static ShapeResult fillet(const TopoDS_Shape& shape, const NumberArray& edges, double radius)
    {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edgeMap;
        const auto inputFailure = cornerInputFailure(shape, edges, radius, "fillet", "radius", edgeMap);
        if (!inputFailure.empty())
            return ShapeResult { TopoDS_Shape(), false, inputFailure };
        std::vector<int> edgeVec = vecFromJSArray<int>(edges);

        BRepFilletAPI_MakeFillet makeFillet(shape);
        for (auto edge : edgeVec) {
            const auto selected = TopoDS::Edge(edgeMap.FindKey(edge + 1));
            makeFillet.Add(radius, selected);
            if (makeFillet.Contour(selected) == 0)
                return ShapeResult { TopoDS_Shape(), false,
                    cornerContourFailure(shape, selected, edge, "fillet", radius, "radius") };
        }
        makeFillet.Build();
        if (!makeFillet.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, filletBuildFailure(makeFillet, radius) };
        }

        const TopoDS_Shape& result = makeFillet.Shape();
        if (result.IsNull() || (!BRepCheck_Analyzer(result).IsValid() && BRepCheck_Analyzer(shape).IsValid())) {
            return ShapeResult { TopoDS_Shape(), false,
                "Failed to fillet: the result is invalid (BRepCheck_Analyzer)" + FaceValidation::invalidFaces(result) };
        }
        return ShapeResult { result, true, "" };
    }

    static TrackedShapeResult filletTracked(const TopoDS_Shape& shape, const NumberArray& edges, double radius)
    {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edgeMap;
        const auto inputFailure = cornerInputFailure(shape, edges, radius, "fillet", "radius", edgeMap);
        if (!inputFailure.empty())
            return TrackedShapeResult { TopoDS_Shape(), false, inputFailure, { }, { } };
        std::vector<int> edgeVec = vecFromJSArray<int>(edges);

        BRepFilletAPI_MakeFillet makeFillet(shape);
        for (auto edge : edgeVec) {
            const auto selected = TopoDS::Edge(edgeMap.FindKey(edge + 1));
            makeFillet.Add(radius, selected);
            if (makeFillet.Contour(selected) == 0)
                return TrackedShapeResult { TopoDS_Shape(), false,
                    cornerContourFailure(shape, selected, edge, "fillet", radius, "radius"), { }, { } };
        }
        makeFillet.Build();
        if (!makeFillet.IsDone()) {
            return TrackedShapeResult { TopoDS_Shape(), false, filletBuildFailure(makeFillet, radius), { }, { } };
        }

        const TopoDS_Shape& result = makeFillet.Shape();
        if (result.IsNull() || (!BRepCheck_Analyzer(result).IsValid() && BRepCheck_Analyzer(shape).IsValid())) {
            return TrackedShapeResult { TopoDS_Shape(), false,
                "Failed to fillet: the result is invalid (BRepCheck_Analyzer)" + FaceValidation::invalidFaces(result), { }, { } };
        }
        return TrackedShapeResult { result, true, "", faceHistory(makeFillet, shape, result),
            edgeHistory(makeFillet, shape, result) };
    }

    static ShapeResult filletVariableRadius(const TopoDS_Shape& shape, const NumberArray& edges, const NumberArray& law)
    {
        if (shape.IsNull())
            return ShapeResult { TopoDS_Shape(), false, "Variable-radius fillet input shape is null" };
        BRepFilletAPI_MakeFillet builder(shape);
        double maximumRadius = 0;
        const auto failure = prepareVariableFillet(builder, shape, edges, law, maximumRadius);
        if (!failure.empty())
            return ShapeResult { TopoDS_Shape(), false, failure };
        builder.Build();
        if (!builder.IsDone())
            return ShapeResult { TopoDS_Shape(), false, filletBuildFailure(builder, maximumRadius) };
        const auto result = builder.Shape();
        if (result.IsNull() || (!BRepCheck_Analyzer(result).IsValid() && BRepCheck_Analyzer(shape).IsValid()))
            return ShapeResult { TopoDS_Shape(), false, "Variable-radius fillet result is invalid (BRepCheck_Analyzer)" + FaceValidation::invalidFaces(result) };
        return ShapeResult { result, true, "" };
    }

    static TrackedShapeResult filletVariableRadiusTracked(const TopoDS_Shape& shape, const NumberArray& edges, const NumberArray& law)
    {
        if (shape.IsNull())
            return TrackedShapeResult { TopoDS_Shape(), false, "Variable-radius fillet input shape is null", { }, { } };
        BRepFilletAPI_MakeFillet builder(shape);
        double maximumRadius = 0;
        const auto failure = prepareVariableFillet(builder, shape, edges, law, maximumRadius);
        if (!failure.empty())
            return TrackedShapeResult { TopoDS_Shape(), false, failure, { }, { } };
        builder.Build();
        if (!builder.IsDone())
            return TrackedShapeResult { TopoDS_Shape(), false, filletBuildFailure(builder, maximumRadius), { }, { } };
        const auto result = builder.Shape();
        if (result.IsNull() || (!BRepCheck_Analyzer(result).IsValid() && BRepCheck_Analyzer(shape).IsValid()))
            return TrackedShapeResult { TopoDS_Shape(), false, "Variable-radius fillet result is invalid (BRepCheck_Analyzer)" + FaceValidation::invalidFaces(result), { }, { } };
        std::vector<int> faceAncestors;
        std::vector<int> edgeAncestors;
        TrackedShapeResult tracked { result, true, "",
            faceHistory(builder, shape, result, &faceAncestors),
            edgeHistory(builder, shape, result, &edgeAncestors) };
        tracked.faceAncestors = std::move(faceAncestors);
        tracked.edgeAncestors = std::move(edgeAncestors);
        return tracked;
    }

    static ShapeResult chamfer(const TopoDS_Shape& shape, const NumberArray& edges, double distance)
    {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edgeMap;
        const auto inputFailure = cornerInputFailure(shape, edges, distance, "chamfer", "distance", edgeMap);
        if (!inputFailure.empty())
            return ShapeResult { TopoDS_Shape(), false, inputFailure };
        std::vector<int> edgeVec = vecFromJSArray<int>(edges);

        BRepFilletAPI_MakeChamfer makeChamfer(shape);
        for (auto edge : edgeVec) {
            const auto selected = TopoDS::Edge(edgeMap.FindKey(edge + 1));
            makeChamfer.Add(distance, selected);
            if (makeChamfer.Contour(selected) == 0)
                return ShapeResult { TopoDS_Shape(), false,
                    cornerContourFailure(shape, selected, edge, "chamfer", distance, "distance") };
        }
        makeChamfer.Build();
        if (!makeChamfer.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, chamferBuildFailure(makeChamfer, distance) };
        }
        const TopoDS_Shape& result = makeChamfer.Shape();
        if (result.IsNull() || (!BRepCheck_Analyzer(result).IsValid() && BRepCheck_Analyzer(shape).IsValid())) {
            return ShapeResult { TopoDS_Shape(), false,
                "Failed to chamfer: the result is invalid (BRepCheck_Analyzer)" + FaceValidation::invalidFaces(result) };
        }
        return ShapeResult { result, true, "" };
    }

    static TrackedShapeResult chamferTracked(const TopoDS_Shape& shape, const NumberArray& edges, double distance)
    {
        NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> edgeMap;
        const auto inputFailure = cornerInputFailure(shape, edges, distance, "chamfer", "distance", edgeMap);
        if (!inputFailure.empty())
            return TrackedShapeResult { TopoDS_Shape(), false, inputFailure, { }, { } };
        std::vector<int> edgeVec = vecFromJSArray<int>(edges);

        BRepFilletAPI_MakeChamfer makeChamfer(shape);
        for (auto edge : edgeVec) {
            const auto selected = TopoDS::Edge(edgeMap.FindKey(edge + 1));
            makeChamfer.Add(distance, selected);
            if (makeChamfer.Contour(selected) == 0)
                return TrackedShapeResult { TopoDS_Shape(), false,
                    cornerContourFailure(shape, selected, edge, "chamfer", distance, "distance"), { }, { } };
        }
        makeChamfer.Build();
        if (!makeChamfer.IsDone()) {
            return TrackedShapeResult { TopoDS_Shape(), false, chamferBuildFailure(makeChamfer, distance), { }, { } };
        }

        const TopoDS_Shape& result = makeChamfer.Shape();
        if (result.IsNull() || (!BRepCheck_Analyzer(result).IsValid() && BRepCheck_Analyzer(shape).IsValid())) {
            return TrackedShapeResult { TopoDS_Shape(), false,
                "Failed to chamfer: the result is invalid (BRepCheck_Analyzer)" + FaceValidation::invalidFaces(result), { }, { } };
        }
        return TrackedShapeResult { result, true, "", faceHistory(makeChamfer, shape, result),
            edgeHistory(makeChamfer, shape, result) };
    }

    static ShapeResult fillet2d(const TopoDS_Face& face, const TopoDS_Edge& edge1, const TopoDS_Edge& edge2, double radius)
    {
        TopoDS_Vertex commonVertex = findCommonVertex(edge1, edge2);
        if (commonVertex.IsNull()) {
            return ShapeResult { TopoDS_Shape(), false, "Edges must share a common vertex" };
        }

        ChFi2d_Builder builder(face);
        builder.AddFillet(commonVertex, radius);
        if (builder.Status() != ChFi2d_IsDone) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create 2D fillet" };
        }

        return ShapeResult { builder.Result(), true, "" };
    }

    static ShapesResult filletEdge2d(const TopoDS_Edge& edge1, const TopoDS_Edge& edge2, double radius)
    {
        std::string error;
        auto corner = computeCornerPlane(edge1, edge2, error);
        if (!corner.has_value()) {
            return ShapesResult { ShapeArray(val::array()), false, error };
        }

        double f1, l1, f2, l2;
        Handle(Geom_Curve) c1 = basisCurve(edge1, f1, l1);
        Handle(Geom_Curve) c2 = basisCurve(edge2, f2, l2);
        TopoDS_Edge e1 = edgeThroughCorner(c1, f1, l1, corner->param1);
        TopoDS_Edge e2 = edgeThroughCorner(c2, f2, l2, corner->param2);

        gp_Pln plane(corner->point, corner->normal);
        ChFi2d_FilletAPI fillet(e1, e2, plane);
        if (!fillet.Perform(radius)) {
            return ShapesResult { ShapeArray(val::array()), false, "Failed to create 2D fillet" };
        }
        TopoDS_Edge newE1, newE2;
        TopoDS_Edge filletEdge = fillet.Result(corner->point, newE1, newE2);
        if (filletEdge.IsNull()) {
            return ShapesResult { ShapeArray(val::array()), false, "Failed to get fillet result" };
        }

        gp_Pnt arcStart, arcEnd;
        edgeEndPoints(filletEdge, arcStart, arcEnd);
        newE1 = edgeToFarEnd(c1, f1, l1, corner->param1, arcStart, arcEnd);
        newE2 = edgeToFarEnd(c2, f2, l2, corner->param2, arcStart, arcEnd);

        return ShapesResult { ShapeArray(buildEdgeTriple(newE1, filletEdge, newE2)), true, "" };
    }

    static ShapeResult chamfer2d(const TopoDS_Face& face, const TopoDS_Edge& edge1, const TopoDS_Edge& edge2, double distance)
    {
        ChFi2d_Builder builder(face);
        builder.AddChamfer(edge1, edge2, distance, distance);
        if (builder.Status() != ChFi2d_IsDone) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create 2D chamfer" };
        }

        return ShapeResult { builder.Result(), true, "" };
    }

    static ShapesResult chamferEdge2d(const TopoDS_Edge& edge1, const TopoDS_Edge& edge2, double distance)
    {
        std::string error;
        auto corner = computeCornerPlane(edge1, edge2, error);
        if (!corner.has_value()) {
            return ShapesResult { ShapeArray(val::array()), false, error };
        }

        double f1, l1, f2, l2;
        Handle(Geom_Curve) c1 = basisCurve(edge1, f1, l1);
        Handle(Geom_Curve) c2 = basisCurve(edge2, f2, l2);

        // for a line the parameter measures arc length, so the cut is at corner +/- distance
        double p1 = GeomAPI_ProjectPointOnCurve(corner->point, c1).LowerDistanceParameter();
        double p2 = GeomAPI_ProjectPointOnCurve(corner->point, c2).LowerDistanceParameter();

        // keep the side of the corner that contains the edge midpoint
        double cut1 = p1 + ((f1 + l1) / 2 > p1 ? distance : -distance);
        double cut2 = p2 + ((f2 + l2) / 2 > p2 ? distance : -distance);
        double end1 = cut1 > p1 ? l1 : f1;
        double end2 = cut2 > p2 ? l2 : f2;

        TopoDS_Edge newE1 = BRepBuilderAPI_MakeEdge(c1, std::min(cut1, end1), std::max(cut1, end1)).Edge();
        TopoDS_Edge newE2 = BRepBuilderAPI_MakeEdge(c2, std::min(cut2, end2), std::max(cut2, end2)).Edge();
        TopoDS_Edge chamferEdge = BRepBuilderAPI_MakeEdge(c1->Value(cut1), c2->Value(cut2)).Edge();

        return ShapesResult { ShapeArray(buildEdgeTriple(newE1, chamferEdge, newE2)), true, "" };
    }

    static const char* loftShapeTypeName(TopAbs_ShapeEnum type)
    {
        if (type == TopAbs_COMPOUND) {
            return "compound";
        }
        if (type == TopAbs_COMPSOLID) {
            return "compound solid";
        }
        if (type == TopAbs_SOLID) {
            return "solid";
        }
        if (type == TopAbs_SHELL) {
            return "shell";
        }
        if (type == TopAbs_FACE) {
            return "face";
        }
        if (type == TopAbs_WIRE) {
            return "wire";
        }
        if (type == TopAbs_EDGE) {
            return "edge";
        }
        if (type == TopAbs_VERTEX) {
            return "vertex";
        }
        return "shape";
    }

    static ShapeResult loft(const ShapeArray& sections, bool isSolid, bool isRuled, GeomAbs_Shape continuity)
    {
        std::vector<TopoDS_Shape> shapeVector = emscripten::vecFromJSArray<TopoDS_Shape>(sections);

        BRepOffsetAPI_ThruSections loftBuilder(isSolid, isRuled);
        if (!isRuled) {
            loftBuilder.SetContinuity(continuity);
        }

        size_t accepted = 0;
        size_t wires = 0;
        for (size_t i = 0; i < shapeVector.size(); i++) {
            const TopoDS_Shape& profile = shapeVector[i];
            if (profile.IsNull()) {
                return ShapeResult { TopoDS_Shape(), false, "Failed to loft: section " + std::to_string(i) + " is empty" };
            }
            if (profile.ShapeType() == TopAbs_WIRE) {
                loftBuilder.AddWire(TopoDS::Wire(profile));
                wires++;
            } else if (profile.ShapeType() == TopAbs_VERTEX) {
                loftBuilder.AddVertex(TopoDS::Vertex(profile));
            } else {
                return ShapeResult { TopoDS_Shape(), false,
                    "Failed to loft: section " + std::to_string(i) + " is a " + loftShapeTypeName(profile.ShapeType())
                        + "; only wires and vertices can be lofted" };
            }
            accepted++;
        }
        if (accepted < 2) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to loft: at least 2 sections are required" };
        }
        if (wires == 0) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to loft: must have at least 1 wires" };
        }

        loftBuilder.Build();
        if (!loftBuilder.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to loft" };
        }
        return ShapeResult { loftBuilder.Shape(), true, "" };
    }

    static ShapeResult curveProjection(const TopoDS_Shape& curve, const TopoDS_Shape& targetFace, const gp_Dir& dir)
    {
        BRepProj_Projection curveProjection(curve, targetFace, dir);
        if (!curveProjection.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to create curve projection" };
        }
        return ShapeResult { curveProjection.Shape(), true, "" };
    }

    static ShapeResult fixShape(const TopoDS_Shape& shape, double tolerance)
    {
        ShapeFix_Shape fixer(shape);
        fixer.SetPrecision(tolerance);
        fixer.Perform();
        return ShapeResult { fixer.Shape(), true, "" };
    }

    static ShapeResult fixSmallFace(const TopoDS_Shape& shape, double tolerance)
    {
        ShapeFix_FixSmallFace fixer;
        fixer.Init(shape);
        fixer.SetPrecision(tolerance);
        fixer.Perform();
        return ShapeResult { fixer.Shape(), true, "" };
    }

    static ShapeResult fixSolid(const TopoDS_Shape& shape, double tolerance)
    {
        ShapeFix_Solid fixer;
        fixer.Init(TopoDS::Solid(shape));
        fixer.SetPrecision(tolerance);
        fixer.Perform();
        return ShapeResult { fixer.Shape(), true, "" };
    }

    static bool hasAnySub(const TopoDS_Shape& shape, TopAbs_ShapeEnum shapeType)
    {
        TopExp_Explorer explorer;
        explorer.Init(shape, shapeType);
        return explorer.More();
    }

    // Rebuilds `shape` with the removals recorded in `reShape`. Wires whose parent face was
    // removed are appended alongside the result, so their remaining edges are preserved.
    static TopoDS_Shape applyKeepingWires(BRepTools_ReShape& reShape,
        const TopoDS_Shape& shape,
        const NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& keptWires)
    {
        auto result = reShape.Apply(shape);
        if (keptWires.IsEmpty() && !result.IsNull()) {
            return result;
        }

        BRep_Builder builder;
        TopoDS_Compound compound;
        builder.MakeCompound(compound);
        if (!result.IsNull()) {
            builder.Add(compound, result);
        }
        for (NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>::Iterator it(keptWires); it.More(); it.Next()) {
            auto keptWire = reShape.Apply(it.Value());
            if (!keptWire.IsNull() && hasAnySub(keptWire, TopAbs_EDGE)) {
                builder.Add(compound, keptWire);
            }
        }
        return compound;
    }

    static ShapeResult removeFeature(const TopoDS_Shape& shape, const ShapeArray& faces)
    {
        std::vector<TopoDS_Shape> facesVector = vecFromJSArray<TopoDS_Shape>(faces);
        BRepAlgoAPI_Defeaturing defea;
        defea.SetShape(shape);
        for (auto& face : facesVector) {
            defea.AddFaceToRemove(face);
        }
        defea.SetRunParallel(true);
        defea.Build();
        if (!defea.IsDone()) {
            return ShapeResult { TopoDS_Shape(), false, "Failed to remove feature" };
        }
        return ShapeResult { defea.Shape(), true, "" };
    }

    static RemoveFilletResult removeFillet(const TopoDS_Shape& shape, const ShapeArray& faces)
    {
        std::vector<TopoDS_Shape> facesVector = vecFromJSArray<TopoDS_Shape>(faces);
        BRepAlgoAPI_Defeaturing defea;
        defea.SetShape(shape);
        for (auto& face : facesVector) {
            defea.AddFaceToRemove(face);
        }
        defea.SetRunParallel(true);
        defea.Build();
        if (!defea.IsDone()) {
            return RemoveFilletResult { TopoDS_Shape(), false, "Failed to remove fillet", ShapeArray(val::array()) };
        }

        val newEdges = val::array();
        TopExp_Explorer explorer;
        for (explorer.Init(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
            auto face = TopoDS::Face(explorer.Current());
            auto list = defea.Generated(face);
            for (auto& s : list) {
                newEdges.call<void>("push", s);
            }
        }
        return RemoveFilletResult { defea.Shape(), true, "", ShapeArray(newEdges) };
    }

    // A face referencing a removed edge becomes invalid: drop it, but keep its
    // wires so the remaining edges are preserved.
    static void removeFacesUsingEdge(BRepTools_ReShape& reShape,
        const NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher>& mapEF,
        const TopoDS_Shape& edge,
        NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& removedFaces,
        NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher>& keptWires)
    {
        if (!mapEF.Contains(edge)) {
            return;
        }
        for (const auto& face : mapEF.FindFromKey(edge)) {
            if (!removedFaces.Add(face)) {
                continue;
            }
            reShape.Remove(face);
            for (TopExp_Explorer explorer(face, TopAbs_WIRE); explorer.More(); explorer.Next()) {
                keptWires.Add(explorer.Current());
            }
        }
    }

    static ShapeResult removeSubShape(const TopoDS_Shape& shape, const ShapeArray& subShapes)
    {
        std::vector<TopoDS_Shape> subShapesVector = vecFromJSArray<TopoDS_Shape>(subShapes);
        if (subShapesVector.empty()) {
            return ShapeResult { shape, false, "Not remove anything" };
        }

        NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher> mapEF;
        TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, mapEF);

        BRepTools_ReShape reShape;
        NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> removedFaces; // dedupe faces dropped because one of their edges was removed
        NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> keptWires;
        for (const auto& subShape : subShapesVector) {
            reShape.Remove(subShape);
            if (subShape.ShapeType() != TopAbs_EDGE) {
                continue;
            }
            removeFacesUsingEdge(reShape, mapEF, subShape, removedFaces, keptWires);
        }

        TopoDS_Shape result = applyKeepingWires(reShape, shape, keptWires);
        if (result.IsSame(shape)) {
            return ShapeResult { shape, false, "Not remove anything" };
        }

        return ShapeResult { result, true, "" };
    }

    static ShapeResult replaceSubShapes(const TopoDS_Shape& shape,
        const ShapeArray& oldShapes, const ShapeArray& newShapes)
    {
        NCollection_Sequence<TopoDS_Shape> oldSeq = shapeArrayToSequenceOfShape(oldShapes);
        NCollection_Sequence<TopoDS_Shape> newSeq = shapeArrayToSequenceOfShape(newShapes);

        BRepTools_ReShape reShape;
        for (int i = 1; i <= oldSeq.Length() && i <= newSeq.Length(); i++) {
            reShape.Replace(oldSeq.Value(i), newSeq.Value(i));
        }

        return ShapeResult { reShape.Apply(shape), true, "" };
    }

    static ShapeResult sewing(const ShapeArray& shapes)
    {
        std::vector<TopoDS_Shape> shapeVector = emscripten::vecFromJSArray<TopoDS_Shape>(shapes);

        BRepBuilderAPI_Sewing sewing;
        for (auto& shape : shapeVector) {
            sewing.Add(shape);
        }
        sewing.Perform();

        TopoDS_Shape result = sewing.SewedShape();
        if (result.ShapeType() == TopAbs_SHELL) {
            BRepCheck_Analyzer analyzer(result);
            if (analyzer.IsValid()) {
                BRepBuilderAPI_MakeSolid mkSolid(TopoDS::Shell(result));
                if (mkSolid.IsDone())
                    result = mkSolid.Solid();
            }
        }

        return ShapeResult { result, true, "" };
    }
};

EMSCRIPTEN_BINDINGS(ShapeFactory)
{
    value_object<CornerSetbackResult>("CornerSetbackResult")
        .field("shape", &CornerSetbackResult::shape)
        .field("isOk", &CornerSetbackResult::isOk)
        .field("error", &CornerSetbackResult::error)
        .field("g0Error", &CornerSetbackResult::g0Error)
        .field("g1Error", &CornerSetbackResult::g1Error)
        .field("fitDistanceError", &CornerSetbackResult::fitDistanceError)
        .field("fitAngleError", &CornerSetbackResult::fitAngleError)
        .field("boundaryCount", &CornerSetbackResult::boundaryCount)
        .field("patchCount", &CornerSetbackResult::patchCount)
        .field("faceMap", &CornerSetbackResult::faceMap)
        .field("edgeMap", &CornerSetbackResult::edgeMap)
        .field("faceEdgeMap", &CornerSetbackResult::faceEdgeMap)
        .field("faceAncestors", &CornerSetbackResult::faceAncestors)
        .field("edgeAncestors", &CornerSetbackResult::edgeAncestors)
        .field("cornerFaces", &CornerSetbackResult::cornerFaces);
    class_<ShapeResult>("ShapeResult")
        .property("shape", &ShapeResult::shape, return_value_policy::reference())
        .property("isOk", &ShapeResult::isOk)
        .property("error", &ShapeResult::error);

    class_<RemoveFilletResult>("RemoveFilletResult")
        .property("shape", &RemoveFilletResult::shape, return_value_policy::reference())
        .property("isOk", &RemoveFilletResult::isOk)
        .property("error", &RemoveFilletResult::error)
        .property("newEdges", &RemoveFilletResult::newEdges);

    class_<ShapesResult>("ShapesResult")
        .property("shapes", &ShapesResult::shapes)
        .property("isOk", &ShapesResult::isOk)
        .property("error", &ShapesResult::error);

    class_<RegionsResult>("RegionsResult")
        .property("faces", &RegionsResult::faces)
        .property("sourceCounts", &RegionsResult::sourceCounts)
        .property("sourceIds", &RegionsResult::sourceIds)
        .property("isOk", &RegionsResult::isOk)
        .property("error", &RegionsResult::error);

    class_<TrackedShapeResult>("TrackedShapeResult")
        .property("shape", &TrackedShapeResult::shape, return_value_policy::reference())
        .property("isOk", &TrackedShapeResult::isOk)
        .property("error", &TrackedShapeResult::error)
        .property("faceMap", &TrackedShapeResult::faceMap)
        .property("edgeMap", &TrackedShapeResult::edgeMap)
        .property("faceEdgeMap", &TrackedShapeResult::faceEdgeMap)
        .property("faceAncestors", &TrackedShapeResult::faceAncestors)
        .property("edgeAncestors", &TrackedShapeResult::edgeAncestors)
        .property("capFaces", &TrackedShapeResult::capFaces)
        .property("nextTargetIndex", &TrackedShapeResult::nextTargetIndex)
        .property("nextFaceIndex", &TrackedShapeResult::nextFaceIndex)
        .property("pipeFaceEdges", &TrackedShapeResult::pipeFaceEdges)
        .property("pipeFaceVertices", &TrackedShapeResult::pipeFaceVertices)
        .property("pipeEdgeVertices", &TrackedShapeResult::pipeEdgeVertices)
        .property("pipeStartEdges", &TrackedShapeResult::pipeStartEdges)
        .property("pipeEndEdges", &TrackedShapeResult::pipeEndEdges)
        .property("pipeStartFaces", &TrackedShapeResult::pipeStartFaces);

    class_<ShapeFactory>("ShapeFactory")
        .class_function("filletCornerSetbackTracked", guardedEntry<&ShapeFactory::filletCornerSetbackTracked>("ShapeFactory.filletCornerSetbackTracked"))
        .class_function("box", guardedEntry<&ShapeFactory::box>("ShapeFactory.box"))
        .class_function("cone", guardedEntry<&ShapeFactory::cone>("ShapeFactory.cone"))
        .class_function("sphere", guardedEntry<&ShapeFactory::sphere>("ShapeFactory.sphere"))
        .class_function("ellipsoid", guardedEntry<&ShapeFactory::ellipsoid>("ShapeFactory.ellipsoid"))
        .class_function("ellipse", guardedEntry<&ShapeFactory::ellipse>("ShapeFactory.ellipse"))
        .class_function("cylinder", guardedEntry<&ShapeFactory::cylinder>("ShapeFactory.cylinder"))
        .class_function("pyramid", guardedEntry<&ShapeFactory::pyramid>("ShapeFactory.pyramid"))
        .class_function("sweep", guardedEntry<&ShapeFactory::sweep>("ShapeFactory.sweep"))
        .class_function("loftGuidedTrackedDeferred", guardedEntry<&ShapeFactory::loftGuidedTrackedDeferred>("ShapeFactory.loftGuidedTrackedDeferred"))
        .class_function("loftGuidedTracked", guardedEntry<&ShapeFactory::loftGuidedTracked>("ShapeFactory.loftGuidedTracked"))
        .class_function("revolve", guardedEntry<&ShapeFactory::revolve>("ShapeFactory.revolve"))
        .class_function("prism", guardedEntry<&ShapeFactory::prism>("ShapeFactory.prism"))
        .class_function("pushPull", guardedEntry<&ShapeFactory::pushPull>("ShapeFactory.pushPull"))
        .class_function("polygon", guardedEntry<&ShapeFactory::polygon>("ShapeFactory.polygon"))
        .class_function("circle", guardedEntry<&ShapeFactory::circle>("ShapeFactory.circle"))
        .class_function("arc", guardedEntry<&ShapeFactory::arc>("ShapeFactory.arc"))
        .class_function("bezier", guardedEntry<&ShapeFactory::bezier>("ShapeFactory.bezier"))
        .class_function("bspline", guardedEntry<&ShapeFactory::bspline>("ShapeFactory.bspline"))
        .class_function("helix", guardedEntry<&ShapeFactory::helix>("ShapeFactory.helix"))
        .class_function("rect", guardedEntry<&ShapeFactory::rect>("ShapeFactory.rect"))
        .class_function("point", guardedEntry<&ShapeFactory::point>("ShapeFactory.point"))
        .class_function("line", guardedEntry<&ShapeFactory::line>("ShapeFactory.line"))
        .class_function("wire", guardedEntry<&ShapeFactory::wire>("ShapeFactory.wire"))
        .class_function("face", guardedEntry<&ShapeFactory::face>("ShapeFactory.face"))
        .class_function("faceFromSurface", guardedEntry<&ShapeFactory::faceFromSurface>("ShapeFactory.faceFromSurface"))
        .class_function("facesFromEdges", guardedEntry<&ShapeFactory::facesFromEdges>("ShapeFactory.facesFromEdges"))
        .class_function("shell", guardedEntry<&ShapeFactory::shell>("ShapeFactory.shell"))
        .class_function("solid", guardedEntry<&ShapeFactory::solid>("ShapeFactory.solid"))
        .class_function("makeThickSolidTolerant", guardedEntry<&ShapeFactory::makeThickSolidTolerant>("ShapeFactory.makeThickSolidTolerant"))
        .class_function("makeThickSolidBySimple", guardedEntry<&ShapeFactory::makeThickSolidBySimple>("ShapeFactory.makeThickSolidBySimple"))
        .class_function("makeThickSolidByJoin", guardedEntry<&ShapeFactory::makeThickSolidByJoin>("ShapeFactory.makeThickSolidByJoin"))
        .class_function("simplifyShape", guardedEntry<&ShapeFactory::simplifyShape>("ShapeFactory.simplifyShape"))
        .class_function("booleanCommon", guardedEntry<&ShapeFactory::booleanCommon>("ShapeFactory.booleanCommon"))
        .class_function("booleanCut", guardedEntry<&ShapeFactory::booleanCut>("ShapeFactory.booleanCut"))
        .class_function("booleanFuse", guardedEntry<&ShapeFactory::booleanFuse>("ShapeFactory.booleanFuse"))
        .class_function("combine", guardedEntry<&ShapeFactory::combine>("ShapeFactory.combine"))
        .class_function("fillet", guardedEntry<&ShapeFactory::fillet>("ShapeFactory.fillet"))
        .class_function("chamfer", guardedEntry<&ShapeFactory::chamfer>("ShapeFactory.chamfer"))
        .class_function("sweepTracked", guardedEntry<&ShapeFactory::sweepTracked>("ShapeFactory.sweepTracked"))
        .class_function("faceSweepTracked", guardedEntry<&ShapeFactory::faceSweepTracked>("ShapeFactory.faceSweepTracked"))
        .class_function("copyTracked", guardedEntry<&ShapeFactory::copyTracked>("ShapeFactory.copyTracked"))
        .class_function("revolveTracked", guardedEntry<&ShapeFactory::revolveTracked>("ShapeFactory.revolveTracked"))
        .class_function("prismTracked", guardedEntry<&ShapeFactory::prismTracked>("ShapeFactory.prismTracked"))
        .class_function("prismFromTracked", guardedEntry<&ShapeFactory::prismFromTracked>("ShapeFactory.prismFromTracked"))
        .class_function("prismNextTracked", guardedEntry<&ShapeFactory::prismNextTracked>("ShapeFactory.prismNextTracked"))
        .class_function("prismUntilTracked", guardedEntry<&ShapeFactory::prismUntilTracked>("ShapeFactory.prismUntilTracked"))
        .class_function("prismThruAllTracked", guardedEntry<&ShapeFactory::prismThruAllTracked>("ShapeFactory.prismThruAllTracked"))
        .class_function("booleanCommonTracked", guardedEntry<&ShapeFactory::booleanCommonTracked>("ShapeFactory.booleanCommonTracked"))
        .class_function("booleanCutTracked", guardedEntry<&ShapeFactory::booleanCutTracked>("ShapeFactory.booleanCutTracked"))
        .class_function("booleanFuseTracked", guardedEntry<&ShapeFactory::booleanFuseTracked>("ShapeFactory.booleanFuseTracked"))
        .class_function("filletTracked", guardedEntry<&ShapeFactory::filletTracked>("ShapeFactory.filletTracked"))
        .class_function("filletVariableRadius", guardedEntry<&ShapeFactory::filletVariableRadius>("ShapeFactory.filletVariableRadius"))
        .class_function("filletVariableRadiusTracked", guardedEntry<&ShapeFactory::filletVariableRadiusTracked>("ShapeFactory.filletVariableRadiusTracked"))
        .class_function("chamferTracked", guardedEntry<&ShapeFactory::chamferTracked>("ShapeFactory.chamferTracked"))
        .class_function("fillet2d", guardedEntry<&ShapeFactory::fillet2d>("ShapeFactory.fillet2d"))
        .class_function("chamfer2d", guardedEntry<&ShapeFactory::chamfer2d>("ShapeFactory.chamfer2d"))
        .class_function("filletEdge2d", guardedEntry<&ShapeFactory::filletEdge2d>("ShapeFactory.filletEdge2d"))
        .class_function("chamferEdge2d", guardedEntry<&ShapeFactory::chamferEdge2d>("ShapeFactory.chamferEdge2d"))
        .class_function("fixShape", guardedEntry<&ShapeFactory::fixShape>("ShapeFactory.fixShape"))
        .class_function("fixSmallFace", guardedEntry<&ShapeFactory::fixSmallFace>("ShapeFactory.fixSmallFace"))
        .class_function("fixSolid", guardedEntry<&ShapeFactory::fixSolid>("ShapeFactory.fixSolid"))
        .class_function("loft", guardedEntry<&ShapeFactory::loft>("ShapeFactory.loft"))
        .class_function("curveProjection", guardedEntry<&ShapeFactory::curveProjection>("ShapeFactory.curveProjection"))
        .class_function("removeFeature", guardedEntry<&ShapeFactory::removeFeature>("ShapeFactory.removeFeature"))
        .class_function("removeFillet", guardedEntry<&ShapeFactory::removeFillet>("ShapeFactory.removeFillet"))
        .class_function("removeSubShape", guardedEntry<&ShapeFactory::removeSubShape>("ShapeFactory.removeSubShape"))
        .class_function("replaceSubShapes", guardedEntry<&ShapeFactory::replaceSubShapes>("ShapeFactory.replaceSubShapes"))
        .class_function("sewing", guardedEntry<&ShapeFactory::sewing>("ShapeFactory.sewing"));
}
