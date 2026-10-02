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
    if (status == BRepCheck_NoError) {
        return "No Error";
    }
    if (status == BRepCheck_InvalidPointOnCurve) {
        return "Invalid Point On Curve";
    }
    if (status == BRepCheck_InvalidPointOnCurveOnSurface) {
        return "Invalid Point On Curve On Surface";
    }
    if (status == BRepCheck_InvalidPointOnSurface) {
        return "Invalid Point On Surface";
    }
    if (status == BRepCheck_No3DCurve) {
        return "No 3D Curve";
    }
    if (status == BRepCheck_Multiple3DCurve) {
        return "Multiple 3D Curve";
    }
    if (status == BRepCheck_Invalid3DCurve) {
        return "Invalid 3D Curve";
    }
    if (status == BRepCheck_NoCurveOnSurface) {
        return "No Curve On Surface";
    }
    if (status == BRepCheck_InvalidCurveOnSurface) {
        return "Invalid Curve On Surface";
    }
    if (status == BRepCheck_InvalidCurveOnClosedSurface) {
        return "Invalid Curve On Closed Surface";
    }
    if (status == BRepCheck_InvalidSameRangeFlag) {
        return "Invalid Same Range Flag";
    }
    if (status == BRepCheck_InvalidSameParameterFlag) {
        return "Invalid Same Parameter Flag";
    }
    if (status == BRepCheck_InvalidDegeneratedFlag) {
        return "Invalid Degenerated Flag";
    }
    if (status == BRepCheck_FreeEdge) {
        return "Free Edge";
    }
    if (status == BRepCheck_InvalidMultiConnexity) {
        return "Invalid Multi Connexity";
    }
    if (status == BRepCheck_InvalidRange) {
        return "Invalid Range";
    }
    if (status == BRepCheck_EmptyWire) {
        return "Empty Wire";
    }
    if (status == BRepCheck_RedundantEdge) {
        return "Redundant Edge";
    }
    if (status == BRepCheck_SelfIntersectingWire) {
        return "Self Intersecting Wire";
    }
    if (status == BRepCheck_NoSurface) {
        return "No Surface";
    }
    if (status == BRepCheck_InvalidWire) {
        return "Invalid Wire";
    }
    if (status == BRepCheck_RedundantWire) {
        return "Redundant Wire";
    }
    if (status == BRepCheck_IntersectingWires) {
        return "Intersecting Wires";
    }
    if (status == BRepCheck_InvalidImbricationOfWires) {
        return "Invalid Imbrication Of Wires";
    }
    if (status == BRepCheck_EmptyShell) {
        return "Empty Shell";
    }
    if (status == BRepCheck_RedundantFace) {
        return "Redundant Face";
    }
    if (status == BRepCheck_InvalidImbricationOfShells) {
        return "Invalid Imbrication Of Shells";
    }
    if (status == BRepCheck_UnorientableShape) {
        return "Unorientable Shape";
    }
    if (status == BRepCheck_NotClosed) {
        return "Not Closed";
    }
    if (status == BRepCheck_NotConnected) {
        return "Not Connected";
    }
    if (status == BRepCheck_SubshapeNotInShape) {
        return "Subshape Not In Shape";
    }
    if (status == BRepCheck_BadOrientation) {
        return "Bad Orientation";
    }
    if (status == BRepCheck_BadOrientationOfSubshape) {
        return "Bad Orientation Of Subshape";
    }
    if (status == BRepCheck_InvalidPolygonOnTriangulation) {
        return "Invalid Polygon On Triangulation";
    }
    if (status == BRepCheck_InvalidToleranceValue) {
        return "Invalid Tolerance Value";
    }
    if (status == BRepCheck_EnclosedRegion) {
        return "Enclosed Region";
    }
    if (status == BRepCheck_CheckFail) {
        return "Check Fail";
    }
    return "Unknown";
}

inline std::string joinStatusNames(const NCollection_List<BRepCheck_Status>& statusList)
{
    std::string joinedStatuses;
    for (auto it = statusList.begin(); it != statusList.end(); ++it) {
        if (!joinedStatuses.empty()) {
            joinedStatuses += ", ";
        }
        joinedStatuses += checkStatusName(*it);
    }
    return joinedStatuses;
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
    std::string diagnostics;
    int invalid = 0;
    for (int i = 1; i <= faces.Extent(); ++i) {
        const auto& face = faces.FindKey(i);
        if (analyzer.IsValid(face))
            continue;
        if (++invalid > 8)
            continue;
        std::set<std::string> statuses;
        const auto collectStatuses = [&](const TopoDS_Shape& item) {
            const auto& checkResult = analyzer.Result(item);
            if (checkResult.IsNull())
                return;
            for (auto status : checkResult->Status())
                if (status != BRepCheck_NoError)
                    statuses.insert(checkStatusName(status));
            checkResult->InitContextIterator();
            while (checkResult->MoreShapeInContext()) {
                for (auto status : checkResult->StatusOnShape())
                    if (status != BRepCheck_NoError)
                        statuses.insert(checkStatusName(status));
                checkResult->NextShapeInContext();
            }
        };
        collectStatuses(face);
        for (TopExp_Explorer wires(face, TopAbs_WIRE); wires.More(); wires.Next())
            collectStatuses(wires.Current());
        for (TopExp_Explorer edges(face, TopAbs_EDGE); edges.More(); edges.Next())
            collectStatuses(edges.Current());
        diagnostics += "; invalid result face index " + std::to_string(i - 1) + " (BRepCheck: ";
        if (statuses.empty())
            diagnostics += "invalid subshape; no detailed status";
        bool isFirstStatus = true;
        for (const auto& status : statuses) {
            if (!isFirstStatus)
                diagnostics += ", ";
            diagnostics += status;
            isFirstStatus = false;
        }
        diagnostics += ")";
    }
    if (invalid > 8)
        diagnostics += "; additional invalid faces=" + std::to_string(invalid - 8);
    if (diagnostics.empty())
        diagnostics = "; result faces have no reported BRepCheck defect (failure may be at shell/solid level)";
    if (diagnostics.size() > 1800)
        diagnostics = diagnostics.substr(0, 1800) + "...";
    return diagnostics;
}
}
