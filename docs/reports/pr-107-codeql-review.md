# PR #107 CodeQL comment audit

These findings were checked against the actual C++ scopes and uses. OCCT `Handle(...)` macros and function boundaries were misclassified by the scanning extraction. The native build compiles these declarations as locals/types. Runtime code is retained where the warning would remove required geometry or diagnostics.

| Comment | Finding | Source evidence / disposition |
| --- | --- | --- |
| [4144597375](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4144597375) | Unused static variable | False positive. `vertices` is a local in `filletBuildFailure`, read by both `vertices > 0` and the final `faulty == 0 && vertices == 0` diagnostic. |
| [4145470407](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4145470407) | Unused static variable | False positive. `output` is a local in `prismBetweenFaces`, read by BRepCheck, volume validation and returned tracked history. |
| [4145470437](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4145470437) | Local variable hides global variable | False positive. `edges` is the `cornerInputFailure` parameter; the alleged global is an enumeration local to another function. Both declarations are scoped; there is no global `edges`. |
| [4145470448](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4145470448) | Local variable hides global variable | False positive. `faces` is an adjacency local in `cornerContourFailure`, used for size and tangency checks. Other topology maps named `faces` are function locals, not globals. |
| [4145470462](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4145470462) | Short global name | False positive. `end` is a local extrusion cap face in `prismFromFaceTracked`, populated from the selected end mode and passed to `prismBetweenFaces`; it is not a global. |
| [4146108674](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4146108674) | Unused static variable | False positive. `Handle(Geom_Curve)` / `Handle(Geom_TrimmedCurve)` are OCCT smart-pointer type macros in the cap projection lambda, not an unused variable named `Handle`. The bounded curve is passed to `GeomProjLib::ProjectOnPlane`. |
| [4146108706](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4146108706) | Unused static variable | False positive. `tolerance` is local to the projected-footprint validation, read in both folded-cap and profile-coverage comparisons. |
| [4147775818](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4147775818) | Local variable hides global variable | False positive. `first` in `prepareVariableFillet` is scoped to its curve-parameter check. Other `first` parameters are scoped to their own functions; none is a global. |
| [4147775854](https://github.com/Lenny32/spicy3d/pull/107#discussion_r4147775854) | Unused static variable | False positive. `startPoint` is the path start vertex in `faceSweepTrackedLocal`, read when constructing the support-normal frame and locating the section. |
