// Part of the Spicy3D Project, derived from Chili3D, under the LGPL-3.0 License.
// See LICENSE-spicy-wasm.txt file in the project root for full license information.

#pragma once

#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Status.hxx>
#include <NCollection_List.hxx>
#include <TopoDS_Shape.hxx>
#include <string>

namespace FaceValidation {
// Translate OCCT validation statuses into the stable labels used in face diagnostics.
// Groups follow the checked geometry: points, curves, wires, faces, shells, then whole shapes.
const char* checkStatusName(BRepCheck_Status status);

std::string joinStatusNames(const NCollection_List<BRepCheck_Status>& statusList);

std::string collectFaceStatus(const BRepCheck_Analyzer& analyzer, const TopoDS_Shape& face);

// Include subshape statuses: a face can report NoError while its wire/edge is invalid.
std::string invalidFaces(const TopoDS_Shape& shape);
}
