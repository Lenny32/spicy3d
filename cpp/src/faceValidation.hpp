// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <set>
#include <string>

namespace FaceValidation {
inline const char* checkStatusName(BRepCheck_Status status)
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

inline std::string joinStatusNames(const NCollection_List<BRepCheck_Status>& statusList)
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

inline std::string collectFaceStatus(const BRepCheck_Analyzer& analyzer, const TopoDS_Shape& face)
{
    std::string statuses;
    const auto& faceResult = analyzer.Result(face);
    if (!faceResult.IsNull()) {
        statuses = joinStatusNames(faceResult->Status());
    }
    return statuses;
}

// Include subshape statuses: a face can report NoError while its wire/edge is invalid.
inline std::string invalidFaces(const TopoDS_Shape& shape)
{
    if (shape.IsNull())
        return "; no result faces available";
    BRepCheck_Analyzer analyzer(shape);
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    std::string text;
    int invalid = 0;
    for (int i = 1; i <= faces.Extent(); ++i) {
        const auto& face = faces.FindKey(i);
        if (analyzer.IsValid(face))
            continue;
        if (++invalid > 8)
            continue;
        std::set<std::string> statuses;
        const auto collect = [&](const TopoDS_Shape& item) {
            const auto& result = analyzer.Result(item);
            if (result.IsNull())
                return;
            for (auto status : result->Status())
                if (status != BRepCheck_NoError)
                    statuses.insert(checkStatusName(status));
            result->InitContextIterator();
            while (result->MoreShapeInContext()) {
                for (auto status : result->StatusOnShape())
                    if (status != BRepCheck_NoError)
                        statuses.insert(checkStatusName(status));
                result->NextShapeInContext();
            }
        };
        collect(face);
        for (TopExp_Explorer wires(face, TopAbs_WIRE); wires.More(); wires.Next())
            collect(wires.Current());
        for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next())
            collect(edges.Current());
        text += "; invalid result face index " + std::to_string(i - 1) + " (BRepCheck: ";
        if (statuses.empty())
            text += "invalid subshape; no detailed status";
        bool first = true;
        for (const auto& status : statuses) {
            if (!first)
                text += ", ";
            text += status;
            first = false;
        }
        text += ")";
    }
    if (invalid > 8)
        text += "; additional invalid faces=" + std::to_string(invalid - 8);
    if (text.empty())
        text = "; result faces have no reported BRepCheck defect (failure may be at shell/solid level)";
    if (text.size() > 1800)
        text = text.substr(0, 1800) + "...";
    return text;
}
}
