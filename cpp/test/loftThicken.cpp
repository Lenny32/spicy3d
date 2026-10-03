// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#include "loftThicken.hpp"
#include <GeomConvert.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_SphericalSurface.hxx>
#include <NCollection_Array2.hxx>
#include <iostream>
#include <stdexcept>

static void require(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}

static TopoDS_Face patch(const Handle(Geom_Surface) & surface, double firstV, double lastV)
{
    auto spline = GeomConvert::SurfaceToBSplineSurface(
        new Geom_RectangularTrimmedSurface(surface, 0, 2 * M_PI, firstV, lastV));
    if (spline->IsUPeriodic())
        spline->SetUNotPeriodic();
    require(!spline->IsUPeriodic() && !spline->IsVPeriodic(), "fixture must be non-periodic");
    return BRepBuilderAPI_MakeFace(spline, Precision::Confusion()).Face();
}

static TopoDS_Face tubePatch()
{
    constexpr double k = 0.5522847498307936;
    const double xy[13][2] = { { 1, 0 }, { 1, k }, { k, 1 }, { 0, 1 },
        { -k, 1 }, { -1, k }, { -1, 0 }, { -1, -k }, { -k, -1 },
        { 0, -1 }, { k, -1 }, { 1, -k }, { 1, 0 } };
    NCollection_Array2<gp_Pnt> poles(1, 13, 1, 2);
    for (int u = 1; u <= 13; ++u)
        for (int v = 1; v <= 2; ++v)
            poles(u, v) = gp_Pnt(10 * xy[u - 1][0], 10 * xy[u - 1][1], 50 * (v - 1));
    NCollection_Array1<double> uKnots(1, 5), vKnots(1, 2);
    NCollection_Array1<int> uMults(1, 5), vMults(1, 2);
    for (int i = 1; i <= 5; ++i) {
        uKnots(i) = i - 1;
        uMults(i) = i == 1 || i == 5 ? 4 : 3;
    }
    vKnots(1) = 0;
    vKnots(2) = 1;
    vMults.Init(2);
    auto spline = new Geom_BSplineSurface(poles, uKnots, vKnots, uMults, vMults, 3, 1);
    return BRepBuilderAPI_MakeFace(spline, Precision::Confusion()).Face();
}

static int edgeCount(const TopoDS_Face& face, bool degenerate)
{
    int count = 0;
    for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next()) {
        const auto edge = TopoDS::Edge(edges.Current());
        if (degenerate ? BRep_Tool::Degenerated(edge) : BRep_Tool::IsClosed(edge, face))
            ++count;
    }
    return count;
}

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "expected seam or degenerate test name");
        if (std::string(argv[1]) == "seam") {
            const auto tube = tubePatch();
            require(edgeCount(tube, false) == 2, "tube fixture must visit its seam twice");
            for (const double thickness : { -1., 1. }) {
                const auto solid = LoftThicken::recover(tube, thickness);
                require(!solid.IsNull(), "seamed tube must recover");
                require(solid.ShapeType() == TopAbs_SOLID, "recovery must produce a solid");
                require(BRepCheck_Analyzer(solid, true, false, true).IsValid(), "solid must be exact-valid");
                NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces;
                TopExp::MapShapes(solid, TopAbs_FACE, faces);
                require(faces.Extent() == 4, "tube must have two skins and two rims, without seam walls");
            }
        } else if (std::string(argv[1]) == "degenerate") {
            const gp_Ax3 axes(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1));
            const auto cap = patch(new Geom_SphericalSurface(axes, 10), 0, M_PI / 2);
            require(edgeCount(cap, true) == 1, "cap fixture must have a degenerate pole edge");
            require(LoftThicken::rebuildBoundaryCurves(cap, 64), "degenerate edges must not need 3D curves");
        } else {
            throw std::runtime_error("unknown test name");
        }
        std::cout << "Loft thicken seam and degenerate-edge regressions passed\n";
        return 0;
    } catch (const Standard_Failure& error) {
        std::cerr << error.GetMessageString() << '\n';
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
    }
    return 1;
}
