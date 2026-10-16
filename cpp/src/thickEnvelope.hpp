// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

// Constant-thickness envelope of a solid whose offset folds over itself: a crease with a
// curvature radius below |thickness| (issue #121). OCCT's offset cannot trim a self-intersecting
// offset, so the wall is assembled from volume cells instead:
//  1. every skin face (all faces but the openings) gets its offset sheet, extended past the face
//     so that sheets and opening faces cross each other where the wall ends;
//  2. the parts of a sheet that cannot bound the wall are dropped: where it folds, and where it
//     lies deeper than |thickness| inside the wall ("occluded": some other skin point is closer
//     than |thickness|), except for an overhang past the last visible part, so that two sides
//     still cross at the inner corner. What is left is free of self-intersection;
//  3. BOPAlgo_MakerVolume splits space by the solid's faces and the sheet pieces;
//  4. a cell on the offset side (inside for a negative thickness, outside for a positive one)
//     belongs to the wall when its interior is closer than |thickness| to the skin.
// The wall's other boundary is where the distance to the skin is exactly |thickness|: the visible
// parts of the sheets, which cross at a sharp inner corner where the offset folded.
// Every cell is sampled from several of its faces: a cell with points on both sides of the
// thickness means a sheet failed to close it, and the envelope is refused; so is a hollow that
// comes closer to the skin than the thickness.

#include <BOPAlgo_MakerVolume.hxx>
#include <BOPTools_AlgoTools3D.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepTools.hxx>
#include <BRepTopAdaptor_FClass2d.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <Geom2d_Line.hxx>
#include <GeomConvert.hxx>
#include <GeomLProp_SLProps.hxx>
#include <GeomLib.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_OffsetSurface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <IntTools_Context.hxx>
#include <NCollection_List.hxx>
#include <Precision.hxx>
#include <Standard_Failure.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <algorithm>
#include <cmath>
#include <functional>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "massProperties.hpp"

namespace ThickEnvelope {

struct Result {
    TopoDS_Shape shape;
    std::string error;
};

using Trace = std::function<void(const std::string&)>;

// Grid cell size along a sheet, as a fraction of |thickness|, and the most cells per direction.
constexpr double cellFraction = 1.0 / 8;
constexpr int maxGrid = 200;
// A node folds where d k reaches 1, the cusp of the offset. Kept cells have no folded corner; the
// inner corner can lie right next to the cusp, so no margin is taken below it.
constexpr double foldLimit = 1.0;
// Cells kept past the last visible ones, so that sheets meeting at an inner corner cross.
constexpr int overhang = 4;
// Refinements of the grid around folds, each splitting a crossed interval in 4.
constexpr int refinePasses = 2;
// Largest relative shortfall of the hollow's distance to the skin.
constexpr double clearanceTolerance = 5e-3;

inline TopoDS_Compound compoundOf(const std::vector<TopoDS_Shape>& shapes)
{
    TopoDS_Compound compound;
    BRep_Builder builder;
    builder.MakeCompound(compound);
    for (const auto& shape : shapes)
        builder.Add(compound, shape);
    return compound;
}

inline double volumeOf(const TopoDS_Shape& shape)
{
    return MassProperties::volume(shape);
}

struct Sheet {
    TopoDS_Face face;
    opencascade::handle<Geom_Surface> basis; // the skin face's surface, extended
    double u0, u1, v0, v1; // parameter box of `basis` covered by the sheet
    double fu0, fu1, fv0, fv1; // the face's own parameter box, inside the above
    double distance; // signed offset along the basis normal
    bool planar;
    bool closedU = false, closedV = false;
};

// The face's surface over its UV box, grown by `margin` (model units) in every open direction.
// Non-planar surfaces become B-splines so that GeomLib can extrapolate them (C2: the offset of a
// C1 junction would have a crease there).
inline bool extendedSheet(const TopoDS_Face& skinFace, double thickness, double margin, Sheet& sheet)
{
    const auto surface = BRep_Tool::Surface(skinFace);
    if (surface.IsNull())
        return false;
    double u0, u1, v0, v1;
    BRepTools::UVBounds(skinFace, u0, u1, v0, v1);
    sheet.face = skinFace;
    sheet.fu0 = u0;
    sheet.fu1 = u1;
    sheet.fv0 = v0;
    sheet.fv1 = v1;
    sheet.distance = skinFace.Orientation() == TopAbs_REVERSED ? -thickness : thickness;
    BRepAdaptor_Surface adaptor(skinFace, false);
    sheet.planar = adaptor.GetType() == GeomAbs_Plane;
    if (sheet.planar) {
        sheet.basis = new Geom_Plane(adaptor.Plane());
        sheet.u0 = u0 - margin;
        sheet.u1 = u1 + margin;
        sheet.v0 = v0 - margin;
        sheet.v1 = v1 + margin;
        return true;
    }
    auto spline
        = GeomConvert::SurfaceToBSplineSurface(new Geom_RectangularTrimmedSurface(surface, u0, u1, v0, v1));
    if (spline.IsNull())
        return false;
    const bool closedU = spline->IsUClosed() || spline->IsUPeriodic();
    const bool closedV = spline->IsVClosed() || spline->IsVPeriodic();
    if (spline->IsUPeriodic())
        spline->SetUNotPeriodic();
    if (spline->IsVPeriodic())
        spline->SetVNotPeriodic();
    auto bounded = opencascade::handle<Geom_BoundedSurface>(spline);
    for (const bool inU : { true, false }) {
        if (inU ? closedU : closedV)
            continue;
        for (const bool after : { true, false }) {
            try {
                GeomLib::ExtendSurfByLength(bounded, margin, 2, inU, after);
            } catch (const Standard_Failure&) {
                // A degenerate boundary (a pole) cannot be extended; it needs no extension.
            }
        }
    }
    sheet.basis = bounded;
    sheet.closedU = closedU;
    sheet.closedV = closedV;
    bounded->Bounds(sheet.u0, sheet.u1, sheet.v0, sheet.v1);
    return true;
}

// A grid over a sheet's parameter box: which cells of the offset sheet are kept.
// A cell folds when, at its centre or a corner, d k >= foldLimit for a principal curvature k
// (GeomLProp signs k positive when the surface bends toward its normal). A cell is visible when
// it does not fold and a corner's offset point is not occluded. Kept = not folded and within
// `overhang` cells of a visible cell.
struct SheetGrid {
    int nu = 1, nv = 1;
    std::vector<gp_Pnt> points; // (nu + 1) x (nv + 1) offset points
    std::vector<char> foldedNode; // (nu + 1) x (nv + 1)
    std::vector<char> folded; // nu x nv cells
    std::vector<char> keep; // nu x nv cells
    std::vector<gp_Pnt> skin; // basis points inside the face: samples of the skin
    bool trimmed = false;

    std::vector<double> us, vs; // parameters of the grid lines, refined around folds

    int node(int i, int j) const { return i * (nv + 1) + j; }
    size_t nodeCount() const { return static_cast<size_t>(nu + 1) * static_cast<size_t>(nv + 1); }
    size_t cellCount() const { return static_cast<size_t>(nu) * static_cast<size_t>(nv); }
    bool kept(int i, int j) const { return i >= 0 && j >= 0 && i < nu && j < nv && keep[i * nv + j]; }
    double u(int i) const { return us[i]; }
    double v(int j) const { return vs[j]; }
};

// The offset point of the basis at (u, v) and the largest d k there (`fold`).
inline gp_Pnt offsetPoint(const Sheet& sheet, double u, double v, double& fold, gp_Pnt* skin = nullptr)
{
    GeomLProp_SLProps props(sheet.basis, u, v, 2, Precision::Confusion());
    fold = 0;
    if (skin)
        *skin = props.Value();
    if (!props.IsNormalDefined()) {
        // A pole: borrow the normal from a point beside it.
        const double du = (sheet.u1 - sheet.u0) * 1e-4, dv = (sheet.v1 - sheet.v0) * 1e-4;
        GeomLProp_SLProps beside(sheet.basis, std::min(u + du, sheet.u1 - du), std::min(v + dv, sheet.v1 - dv), 1,
            Precision::Confusion());
        if (!beside.IsNormalDefined())
            return props.Value();
        return props.Value().Translated(gp_Vec(beside.Normal()) * sheet.distance);
    }
    if (props.IsCurvatureDefined())
        fold = std::max(sheet.distance * props.MaxCurvature(), sheet.distance * props.MinCurvature());
    return props.Value().Translated(gp_Vec(props.Normal()) * sheet.distance);
}

inline double isoLength(const Sheet& sheet, bool alongU)
{
    double longest = 0;
    for (int line = 0; line <= 4; ++line) {
        double length = 0;
        gp_Pnt previous;
        for (int k = 0; k <= 64; ++k) {
            const double a = alongU ? sheet.u0 + (sheet.u1 - sheet.u0) * k / 64 : sheet.u0 + (sheet.u1 - sheet.u0) * line / 4;
            const double b = alongU ? sheet.v0 + (sheet.v1 - sheet.v0) * line / 4 : sheet.v0 + (sheet.v1 - sheet.v0) * k / 64;
            const gp_Pnt point = sheet.basis->Value(a, b);
            if (k > 0)
                length += previous.Distance(point);
            previous = point;
        }
        longest = std::max(longest, length);
    }
    return longest;
}

// Evaluates the grid's nodes: offset points and folds.
inline void evaluateGrid(const Sheet& sheet, SheetGrid& grid)
{
    grid.nu = static_cast<int>(grid.us.size()) - 1;
    grid.nv = static_cast<int>(grid.vs.size()) - 1;
    grid.points.resize(grid.nodeCount());
    grid.foldedNode.resize(grid.points.size());
    for (int i = 0; i <= grid.nu; ++i) {
        for (int j = 0; j <= grid.nv; ++j) {
            double fold;
            grid.points[grid.node(i, j)] = offsetPoint(sheet, grid.u(i), grid.v(j), fold);
            grid.foldedNode[grid.node(i, j)] = fold >= foldLimit;
        }
    }
}

// Splits every grid interval that a fold boundary crosses into `parts`: a fold's swallowtail can
// be much narrower than a cell, and the sheets must reach the inner corner, next to the cusp.
inline bool refineAtFolds(SheetGrid& grid, int parts)
{
    std::vector<char> splitU(grid.nu, 0), splitV(grid.nv, 0);
    bool any = false;
    for (int i = 0; i <= grid.nu; ++i) {
        for (int j = 0; j <= grid.nv; ++j) {
            const bool folded = grid.foldedNode[grid.node(i, j)];
            if (i < grid.nu && folded != static_cast<bool>(grid.foldedNode[grid.node(i + 1, j)]))
                any = splitU[i] = 1;
            if (j < grid.nv && folded != static_cast<bool>(grid.foldedNode[grid.node(i, j + 1)]))
                any = splitV[j] = 1;
        }
    }
    const auto refine = [&](std::vector<double>& lines, const std::vector<char>& split) {
        std::vector<double> result;
        for (size_t k = 0; k + 1 < lines.size(); ++k) {
            result.push_back(lines[k]);
            if (split[k])
                for (int part = 1; part < parts; ++part)
                    result.push_back(lines[k] + (lines[k + 1] - lines[k]) * part / parts);
        }
        result.push_back(lines.back());
        lines = std::move(result);
    };
    refine(grid.us, splitU);
    refine(grid.vs, splitV);
    return any;
}

// Samples a sheet: offset points, folds, and the skin points inside the face.
inline SheetGrid sampleGrid(const Sheet& sheet, double thickness)
{
    SheetGrid grid;
    const double cell = std::abs(thickness) * cellFraction;
    const int nu = std::clamp(static_cast<int>(std::ceil(isoLength(sheet, true) / cell)), 4, maxGrid);
    const int nv = std::clamp(static_cast<int>(std::ceil(isoLength(sheet, false) / cell)), 4, maxGrid);
    for (int i = 0; i <= nu; ++i)
        grid.us.push_back(sheet.u0 + (sheet.u1 - sheet.u0) * i / nu);
    for (int j = 0; j <= nv; ++j)
        grid.vs.push_back(sheet.v0 + (sheet.v1 - sheet.v0) * j / nv);
    evaluateGrid(sheet, grid);
    // The skin samples come from the regular grid; refined lines add nothing there.
    BRepTopAdaptor_FClass2d inside(sheet.face, Precision::PConfusion());
    const double eu = (sheet.fu1 - sheet.fu0) * 1e-9, ev = (sheet.fv1 - sheet.fv0) * 1e-9;
    for (int i = 0; i <= grid.nu; ++i) {
        for (int j = 0; j <= grid.nv; ++j) {
            const double u = grid.u(i), v = grid.v(j);
            if (u >= sheet.fu0 - eu && u <= sheet.fu1 + eu && v >= sheet.fv0 - ev && v <= sheet.fv1 + ev
                && inside.Perform(gp_Pnt2d(u, v)) != TopAbs_OUT)
                grid.skin.push_back(sheet.basis->Value(u, v));
        }
    }
    for (int pass = 0; pass < refinePasses; ++pass) {
        if (!refineAtFolds(grid, 4))
            break;
        evaluateGrid(sheet, grid);
    }
    grid.folded.assign(grid.cellCount(), 0);
    for (int i = 0; i < grid.nu; ++i) {
        for (int j = 0; j < grid.nv; ++j) {
            bool folded = grid.foldedNode[grid.node(i, j)] || grid.foldedNode[grid.node(i + 1, j)]
                || grid.foldedNode[grid.node(i, j + 1)] || grid.foldedNode[grid.node(i + 1, j + 1)];
            if (!folded) {
                double centre;
                offsetPoint(sheet, (grid.u(i) + grid.u(i + 1)) / 2, (grid.v(j) + grid.v(j + 1)) / 2, centre);
                folded = centre >= foldLimit;
            }
            grid.folded[i * grid.nv + j] = folded;
        }
    }
    return grid;
}

// Skin samples binned in space. The distance to the nearest sample is never below the distance
// to the skin, so an "occluded" verdict is always right; a missed one only keeps more sheet.
class SkinCloud {
public:
    explicit SkinCloud(double cell)
        : m_cell(cell)
    {
    }

    void add(const gp_Pnt& point) { m_bins[key(bin(point.X()), bin(point.Y()), bin(point.Z()))].push_back(point); }

    // The distance to the nearest sample, or `limit` when none is closer.
    double nearest(const gp_Pnt& point, double limit) const
    {
        const long long reach = static_cast<long long>(std::ceil(limit / m_cell));
        const long long x = bin(point.X()), y = bin(point.Y()), z = bin(point.Z());
        double best = limit * limit;
        for (long long dx = -reach; dx <= reach; ++dx) {
            for (long long dy = -reach; dy <= reach; ++dy) {
                for (long long dz = -reach; dz <= reach; ++dz) {
                    const auto found = m_bins.find(key(x + dx, y + dy, z + dz));
                    if (found == m_bins.end())
                        continue;
                    for (const auto& sample : found->second)
                        best = std::min(best, sample.SquareDistance(point));
                }
            }
        }
        return std::sqrt(best);
    }

private:
    long long bin(double value) const { return static_cast<long long>(std::floor(value / m_cell)); }
    static long long key(long long x, long long y, long long z)
    {
        return ((x & 0x1FFFFF) << 42) | ((y & 0x1FFFFF) << 21) | (z & 0x1FFFFF);
    }

    double m_cell;
    std::unordered_map<long long, std::vector<gp_Pnt>> m_bins;
};

inline void trimGrid(SheetGrid& grid, const SkinCloud& cloud, double depth)
{
    std::vector<char> nodeVisible(grid.points.size(), 0);
    for (size_t index = 0; index < grid.points.size(); ++index)
        nodeVisible[index] = !grid.foldedNode[index] && cloud.nearest(grid.points[index], depth) >= depth * (1 - 1e-3);
    std::vector<char> visible(grid.cellCount(), 0);
    for (int i = 0; i < grid.nu; ++i)
        for (int j = 0; j < grid.nv; ++j)
            visible[i * grid.nv + j] = !grid.folded[i * grid.nv + j]
                && (nodeVisible[grid.node(i, j)] || nodeVisible[grid.node(i + 1, j)] || nodeVisible[grid.node(i, j + 1)]
                    || nodeVisible[grid.node(i + 1, j + 1)]);
    grid.keep.assign(grid.cellCount(), 0);
    for (int i = 0; i < grid.nu; ++i) {
        for (int j = 0; j < grid.nv; ++j) {
            if (grid.folded[i * grid.nv + j])
                continue;
            bool near = false;
            for (int di = -overhang; di <= overhang && !near; ++di)
                for (int dj = -overhang; dj <= overhang && !near; ++dj)
                    near = i + di >= 0 && j + dj >= 0 && i + di < grid.nu && j + dj < grid.nv
                        && visible[(i + di) * grid.nv + j + dj];
            grid.keep[i * grid.nv + j] = near;
        }
    }
    // Two kept cells touching only at a corner would make a wire touch itself: drop one.
    for (bool changed = true; changed;) {
        changed = false;
        for (int i = 0; i + 1 < grid.nu; ++i) {
            for (int j = 0; j + 1 < grid.nv; ++j) {
                const bool a = grid.kept(i, j), b = grid.kept(i + 1, j), c = grid.kept(i, j + 1), d = grid.kept(i + 1, j + 1);
                if ((a && d && !b && !c) || (b && c && !a && !d)) {
                    grid.keep[(a ? i : i + 1) * grid.nv + j] = 0;
                    changed = true;
                }
            }
        }
    }
    grid.trimmed = std::find(grid.keep.begin(), grid.keep.end(), 0) != grid.keep.end();
}

using GridNode = std::pair<int, int>;

inline double segmentDistance(const GridNode& p, const GridNode& a, const GridNode& b)
{
    const double dx = b.first - a.first, dy = b.second - a.second;
    const double length = std::hypot(dx, dy);
    if (length == 0)
        return std::hypot(p.first - a.first, p.second - a.second);
    return std::abs(dx * (p.second - a.second) - dy * (p.first - a.first)) / length;
}

// Douglas-Peucker within one cell: a staircase becomes a few slanted edges. The boundary moves by
// less than a cell, inside the overhang, so it never matters exactly where it runs.
inline void simplifySpan(const std::vector<GridNode>& loop, size_t first, size_t last, std::vector<char>& keep)
{
    double worst = 0;
    size_t index = first;
    for (size_t k = first + 1; k < last; ++k) {
        const double distance = segmentDistance(loop[k % loop.size()], loop[first], loop[last % loop.size()]);
        if (distance > worst) {
            worst = distance;
            index = k;
        }
    }
    if (worst <= 1.0)
        return;
    keep[index % loop.size()] = 1;
    simplifySpan(loop, first, index, keep);
    simplifySpan(loop, index, last, keep);
}

inline std::vector<GridNode> simplifyLoop(const std::vector<GridNode>& loop, int cutU, int cutV)
{
    // Anchor at the node farthest from the first one, then simplify both halves.
    const auto span = [&](size_t k) {
        return std::hypot(loop[k].first - loop[0].first, loop[k].second - loop[0].second);
    };
    size_t far = 0;
    for (size_t k = 1; k < loop.size(); ++k)
        if (span(k) > span(far))
            far = k;
    std::vector<char> keep(loop.size(), 0);
    keep[0] = keep[far] = 1;
    simplifySpan(loop, 0, far, keep);
    simplifySpan(loop, far, loop.size(), keep);
    // Nodes on a cut line stay: no edge may run across a cut.
    for (size_t k = 0; k < loop.size(); ++k)
        if (loop[k].first == cutU || loop[k].second == cutV)
            keep[k] = 1;
    std::vector<GridNode> result;
    for (size_t k = 0; k < loop.size(); ++k)
        if (keep[k])
            result.push_back(loop[k]);
    return result;
}

// Boundary loops of the kept cells, kept side on the left: outer loops counter-clockwise in
// (i, j), holes clockwise, simplified. A closed direction is also cut at its middle grid line:
// a piece wrapping all the way around would need an edge closing on itself.
inline std::vector<std::vector<GridNode>> keptLoops(const Sheet& sheet, const SheetGrid& grid)
{
    const int cutU = sheet.closedU ? grid.nu / 2 : -1, cutV = sheet.closedV ? grid.nv / 2 : -1;
    // Is the neighbour cell (ni, nj) of kept cell (i, j) joined to it?
    const auto joined = [&](int i, int j, int ni, int nj) {
        return grid.kept(ni, nj) && !(std::max(i, ni) == cutU && i != ni) && !(std::max(j, nj) == cutV && j != nj);
    };
    std::map<GridNode, std::vector<GridNode>> next;
    for (int i = 0; i < grid.nu; ++i) {
        for (int j = 0; j < grid.nv; ++j) {
            if (!grid.kept(i, j))
                continue;
            if (!joined(i, j, i, j - 1))
                next[{ i, j }].push_back({ i + 1, j });
            if (!joined(i, j, i + 1, j))
                next[{ i + 1, j }].push_back({ i + 1, j + 1 });
            if (!joined(i, j, i, j + 1))
                next[{ i + 1, j + 1 }].push_back({ i, j + 1 });
            if (!joined(i, j, i - 1, j))
                next[{ i, j + 1 }].push_back({ i, j });
        }
    }
    std::vector<std::vector<GridNode>> loops;
    while (!next.empty()) {
        const auto start = next.begin()->first;
        std::vector<GridNode> loop { start };
        GridNode current = start;
        while (true) {
            auto found = next.find(current);
            if (found == next.end() || found->second.empty())
                break;
            const GridNode to = found->second.back();
            found->second.pop_back();
            if (found->second.empty())
                next.erase(found);
            if (to == start)
                break;
            loop.push_back(to);
            current = to;
        }
        auto simplified = simplifyLoop(loop, cutU, cutV);
        if (simplified.size() >= 3)
            loops.push_back(std::move(simplified));
    }
    return loops;
}

inline double signedArea(const std::vector<GridNode>& loop)
{
    double area = 0;
    for (size_t k = 0; k < loop.size(); ++k) {
        const auto& a = loop[k];
        const auto& b = loop[(k + 1) % loop.size()];
        area += static_cast<double>(a.first) * b.second - static_cast<double>(b.first) * a.second;
    }
    return area / 2;
}

inline bool insideLoop(const std::vector<GridNode>& loop, double x, double y)
{
    bool inside = false;
    for (size_t k = 0, l = loop.size() - 1; k < loop.size(); l = k++) {
        const double xi = loop[k].first, yi = loop[k].second, xl = loop[l].first, yl = loop[l].second;
        if ((yi > y) != (yl > y) && x < (xl - xi) * (y - yi) / (yl - yi) + xi)
            inside = !inside;
    }
    return inside;
}

// A piece's own surface, the exact offset of the basis cut down to the piece's nodes. One
// surface per piece: on a shared surface the boolean operations would take two pieces for the
// same domain and never intersect them, but the inner corner is where two pieces of a sheet cross.
inline opencascade::handle<Geom_Surface> pieceSurface(const Sheet& sheet, const SheetGrid& grid, int i0, int i1, int j0, int j1)
{
    if (sheet.planar) {
        gp_Pln moved = opencascade::handle<Geom_Plane>::DownCast(sheet.basis)->Pln();
        moved.Translate(gp_Vec(moved.Axis().Direction()) * sheet.distance);
        return new Geom_Plane(moved);
    }
    const auto basis = opencascade::handle<Geom_BSplineSurface>::DownCast(sheet.basis->Copy());
    basis->Segment(grid.u(i0), grid.u(i1), grid.v(j0), grid.v(j1));
    return new Geom_OffsetSurface(basis, sheet.distance, true);
}

inline TopoDS_Wire loopWire(const Sheet& sheet, const SheetGrid& grid, const opencascade::handle<Geom_Surface>& surface,
    const std::vector<GridNode>& loop)
{
    const auto uv = [&](const GridNode& node) { return gp_Pnt2d(grid.u(node.first), grid.v(node.second)); };
    std::vector<TopoDS_Vertex> vertices;
    for (const auto& node : loop) {
        const auto p = uv(node);
        vertices.push_back(BRepBuilderAPI_MakeVertex(surface->Value(p.X(), p.Y())).Vertex());
    }
    BRep_Builder builder;
    TopoDS_Wire wire;
    builder.MakeWire(wire);
    for (size_t k = 0; k < loop.size(); ++k) {
        const auto a = uv(loop[k]);
        const auto b = uv(loop[(k + 1) % loop.size()]);
        const auto line = opencascade::handle<Geom2d_Line>(new Geom2d_Line(a, gp_Dir2d(b.X() - a.X(), b.Y() - a.Y())));
        BRepBuilderAPI_MakeEdge edge(line, surface, vertices[k], vertices[(k + 1) % loop.size()], 0, a.Distance(b));
        if (!edge.IsDone())
            return TopoDS_Wire();
        builder.Add(wire, edge.Edge());
    }
    BRepLib::BuildCurves3d(wire);
    wire.Closed(true);
    return wire;
}

// The kept pieces of a sheet, one face each.
inline bool sheetFaces(const Sheet& sheet, const SheetGrid& grid, std::vector<TopoDS_Shape>& faces)
{
    if (!grid.trimmed) {
        const auto surface = pieceSurface(sheet, grid, 0, grid.nu, 0, grid.nv);
        BRepBuilderAPI_MakeFace face(surface, grid.u(0), grid.u(grid.nu), grid.v(0), grid.v(grid.nv), Precision::Confusion());
        if (!face.IsDone())
            return false;
        faces.push_back(face.Face());
        return true;
    }
    std::vector<std::vector<GridNode>> outers, holes;
    for (auto& loop : keptLoops(sheet, grid))
        (signedArea(loop) > 0 ? outers : holes).push_back(std::move(loop));
    for (const auto& outer : outers) {
        int i0 = grid.nu, i1 = 0, j0 = grid.nv, j1 = 0;
        for (const auto& node : outer) {
            i0 = std::min(i0, node.first);
            i1 = std::max(i1, node.first);
            j0 = std::min(j0, node.second);
            j1 = std::max(j1, node.second);
        }
        const auto surface = pieceSurface(sheet, grid, i0, i1, j0, j1);
        const auto outerWire = loopWire(sheet, grid, surface, outer);
        if (outerWire.IsNull())
            return false;
        // The traced loop is counter-clockwise in UV: no inside test, which may flip it.
        BRepBuilderAPI_MakeFace face(surface, outerWire, false);
        if (!face.IsDone())
            return false;
        for (const auto& hole : holes) {
            if (!insideLoop(outer, hole.front().first, hole.front().second))
                continue;
            const auto holeWire = loopWire(sheet, grid, surface, hole);
            if (holeWire.IsNull())
                return false;
            face.Add(holeWire);
        }
        faces.push_back(face.Face());
    }
    return true;
}

inline double distanceTo(const gp_Pnt& point, const TopoDS_Shape& target)
{
    BRepExtrema_DistShapeShape distance(BRepBuilderAPI_MakeVertex(point).Vertex(), target);
    if (!distance.IsDone() || distance.NbSolution() == 0)
        return -1;
    return distance.Value();
}

// Points strictly inside `cell`, one stepped in from each of up to `count` faces, each as deep as
// the cell allows up to depth / 2; `steps` receives how deep each one is.
inline std::vector<gp_Pnt> interiorPoints(const TopoDS_Shape& cell, double depth, int count, std::vector<double>& steps)
{
    const auto context = opencascade::handle<IntTools_Context>(new IntTools_Context());
    std::vector<gp_Pnt> points;
    for (TopExp_Explorer faces(cell, TopAbs_FACE); faces.More() && static_cast<int>(points.size()) < count; faces.Next()) {
        const auto face = TopoDS::Face(faces.Current());
        gp_Pnt point;
        gp_Pnt2d uv;
        try {
            if (BOPTools_AlgoTools3D::PointInFace(face, point, uv, context) != 0)
                continue;
        } catch (const Standard_Failure&) {
            continue;
        }
        GeomLProp_SLProps props(BRep_Tool::Surface(face), uv.X(), uv.Y(), 1, Precision::Confusion());
        if (!props.IsNormalDefined())
            continue;
        gp_Dir normal = props.Normal();
        if (face.Orientation() == TopAbs_REVERSED)
            normal.Reverse();
        for (const double fraction : { 0.5, 0.25, 0.1, 0.03, 0.005 }) {
            const gp_Pnt candidate = point.Translated(gp_Vec(normal) * (-depth * fraction));
            if (BRepClass3d_SolidClassifier(cell, candidate, Precision::Confusion()).State() == TopAbs_IN) {
                points.push_back(candidate);
                steps.push_back(depth * fraction);
                break;
            }
        }
    }
    return points;
}

inline Result build(const TopoDS_Shape& solid, const NCollection_List<TopoDS_Shape>& openings, double thickness,
    const Trace& trace = nullptr)
{
    const double depth = std::abs(thickness);
    const TopAbs_State offsetSide = thickness < 0 ? TopAbs_IN : TopAbs_OUT;
    std::vector<TopoDS_Shape> faces, skin;
    for (TopExp_Explorer explorer(solid, TopAbs_FACE); explorer.More(); explorer.Next()) {
        faces.push_back(explorer.Current());
        bool opening = false;
        for (const auto& face : openings)
            opening = opening || face.IsSame(explorer.Current());
        if (!opening)
            skin.push_back(explorer.Current());
    }
    if (skin.empty())
        return { TopoDS_Shape(), "every face is an opening" };

    std::vector<Sheet> sheets(skin.size());
    std::vector<SheetGrid> grids;
    SkinCloud cloud(depth / 2);
    for (size_t k = 0; k < skin.size(); ++k) {
        if (!extendedSheet(TopoDS::Face(skin[k]), thickness, 2 * depth, sheets[k]))
            return { TopoDS_Shape(), "a skin face has no surface to offset" };
        grids.push_back(sampleGrid(sheets[k], thickness));
        for (const auto& point : grids.back().skin)
            cloud.add(point);
    }
    std::vector<TopoDS_Shape> pieces;
    for (size_t k = 0; k < skin.size(); ++k) {
        trimGrid(grids[k], cloud, depth);
        if (!sheetFaces(sheets[k], grids[k], pieces))
            return { TopoDS_Shape(), "an offset sheet could not be trimmed to its visible parts" };
    }
    if (trace)
        trace("sheet pieces " + std::to_string(pieces.size()));

    BOPAlgo_MakerVolume maker;
    NCollection_List<TopoDS_Shape> arguments;
    for (const auto& face : faces)
        arguments.Append(face);
    for (const auto& piece : pieces)
        arguments.Append(piece);
    maker.SetArguments(arguments);
    maker.SetRunParallel(false);
    maker.SetIntersect(true);
    maker.SetAvoidInternalShapes(true);
    maker.SetNonDestructive(true);
    maker.Perform();
    if (maker.HasErrors())
        return { TopoDS_Shape(), "splitting the solid by its offset failed" };
    if (trace)
        trace("split done");

    const auto skinCompound = compoundOf(skin);
    const double sourceVolume = std::abs(volumeOf(solid));
    std::vector<TopoDS_Shape> wall, hollow;
    int cells = 0;
    for (TopExp_Explorer explorer(maker.Shape(), TopAbs_SOLID); explorer.More(); explorer.Next(), ++cells) {
        const auto& cell = explorer.Current();
        std::vector<double> steps;
        const auto points = interiorPoints(cell, depth, 6, steps);
        if (points.empty()) {
            // A sliver too thin to step into is negligible: with the wall when on the offset side.
            GProp_GProps mass;
            MassProperties::volume(cell, mass);
            if (std::abs(mass.Mass()) > 1e-6 * sourceVolume)
                return { TopoDS_Shape(), "a split cell has no interior point" };
            if (BRepClass3d_SolidClassifier(solid, mass.CentreOfMass(), Precision::Confusion()).State() == offsetSide)
                wall.push_back(cell);
            continue;
        }
        if (BRepClass3d_SolidClassifier(solid, points.front(), Precision::Confusion()).State() != offsetSide)
            continue;
        // Every sample must agree; a point closer to the thickness than half its step is undecided.
        int inside = 0, outside = 0;
        for (size_t k = 0; k < points.size(); ++k) {
            const double distance = distanceTo(points[k], skinCompound);
            if (distance < 0)
                return { TopoDS_Shape(), "cannot measure a split cell's distance to the skin" };
            if (distance < depth - steps[k] * 0.5)
                ++inside;
            else if (distance > depth + steps[k] * 0.5)
                ++outside;
        }
        if (inside > 0 && outside > 0)
            return { TopoDS_Shape(), "a split cell spans the thickness (an offset sheet could not be closed)" };
        (outside > 0 ? hollow : wall).push_back(cell);
        if (trace)
            trace("cell volume " + std::to_string(volumeOf(cell)) + (outside > 0 ? " hollow" : " wall"));
    }
    if (wall.empty())
        return { TopoDS_Shape(), "no material within the thickness was found" };
    if (thickness < 0 && !hollow.empty()) {
        BRepExtrema_DistShapeShape clearance(compoundOf(hollow), skinCompound);
        if (trace && clearance.IsDone())
            trace("clearance " + std::to_string(clearance.Value()));
        if (!clearance.IsDone() || clearance.Value() < depth * (1 - clearanceTolerance))
            return { TopoDS_Shape(), "the hollow came closer to the skin than the thickness "
                                     "(an offset sheet could not be closed)" };
    }
    // The cells come from one split and share their faces exactly: gluing them is enough.
    TopoDS_Shape result = wall.front();
    if (wall.size() > 1) {
        NCollection_List<TopoDS_Shape> first, rest;
        first.Append(wall.front());
        for (size_t i = 1; i < wall.size(); ++i)
            rest.Append(wall[i]);
        BRepAlgoAPI_Fuse fuse;
        fuse.SetArguments(first);
        fuse.SetTools(rest);
        fuse.SetGlue(BOPAlgo_GlueFull);
        fuse.SetRunParallel(false);
        fuse.Build();
        if (!fuse.IsDone() || fuse.HasErrors())
            return { TopoDS_Shape(), "joining the wall cells failed" };
        result = fuse.Shape();
    }
    if (trace)
        trace("cells " + std::to_string(cells) + ", wall " + std::to_string(wall.size()) + ", hollow "
            + std::to_string(hollow.size()));
    return { result, "" };
}

}
