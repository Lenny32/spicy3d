# Corner setback native feasibility (experimental)

Issue #84 remains incomplete. This work has not added a saved feature field, a module version,
user controls, or MCP commands. No constructed corner patch has passed the acceptance checks yet.

## Construction under test

The experiment rounds three edges incident to one unambiguous corner with OCCT's constant-radius
fillet. Each setback is a separate arc-length distance measured away from that corner. A plane
normal to the selected edge trims its rolling strip at that distance. Three further plane/surface
intersections trim the adjacent supports between the strip endpoints. This gives six ordered
boundary curves: three strip sections and three support connectors. An N-sided plate is fitted with
tangent constraints to each retained face, converted to a B-spline, and sewn into the original
constant-radius fillet after removing its corner cap. This changes the corner patch rather than
substituting an endpoint radius law.

The input solid is copied with geometry and without mesh data before native operations. Intended
output checks include independently sampled boundary distance and tangent-normal agreement,
closed sewing, BREP validity, self-interference rejection, and positive volume below the input.
The original BREP and cached display buffers are now checked before the output acceptance assertion,
so failed fits also exercise input preservation.

The current experimental eligibility is one valid solid, three distinct edges sharing exactly one
vertex, three incident supports, unambiguous generated strips and modified supports, regular
section/connector curves, one original corner cap, and one closed six-edge boundary. Setbacks must
exceed the fillet radius and remain strictly within their respective edge lengths. Singular,
fragmented, closed-edge, concave/additive, and ambiguous cases are rejected. Curved edges are
measured by arc length, and curved supports are intersected rather than replaced by planes.

## Acceptance and evidence

The boundary distance limit is **0.0001 mm** and the tangent-normal angle limit is **0.001 rad**.
The final CAD surface is checked independently at 33 parameter-spaced sites on each supplied
boundary. These samples are finite checks, not a mathematical certificate of an entire boundary.
OCCT's intermediate plate errors are also checked; they are not the final B-spline's errors.

Pinned OCCT source confirms that `BRepOffsetAPI_MakeFilling` uses a G0 criterion when approximating
its plate. It also documents that incompatible constraints may be ignored. Merely reporting
`IsDone()` or the intermediate plate errors would therefore misrepresent this experiment.

| Experiment | Candidate | Final distance (mm) | Final angle (rad) | Plate distance (mm) | Plate angle (rad) | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| MakeFilling, 25 sites / 3 iterations / 20 approximation segments | Cube, equal 10 mm setbacks | 0.001066 | 0.017000 | not separately recorded | not separately recorded | rejected |
| MakeFilling, 50 sites / 5 iterations / 100 segments | Cube, equal 10 mm setbacks | 0.000274 | 0.009346 | 0.000005 | 0.000274 | rejected |
| Same | Cube, 8/10/12 mm setbacks | 0.000431 | 0.011239 | 0.000005 | 0.000369 | rejected |
| G1 criterion, 400 segments | Cube, equal 10 mm setbacks | 0.000030 | 0.004411 | 0.000005 | 0.000274 | rejected |
| Same | Spherical-support octant, 8 mm setbacks | 0.000499 | 0.013564 | 0.000015 | 0.002865 | rejected |
| Public plate builder + G1 approximation criterion, 100 segments | Cube, equal 10 mm setbacks | 0.000274 | 0.009346 | 0.000005 | 0.000274 | rejected |
| Same | Cube, 8/10/12 mm setbacks | 0.000431 | 0.011239 | 0.000005 | 0.000369 | rejected |

The cube is 40 mm on each side with a 2 mm retained fillet radius. The curved case is the positive
octant of a 40 mm sphere, at its corner on the positive X axis, with a 1 mm retained fillet radius.
Both planar and curved candidates reached patch construction, so support trimming and boundary
ordering worked for these inputs. The curved case has not demonstrated an acceptable plate fit.

The first complete test run took 7.4 seconds, with five input-validation tests passing and four
geometry tests failing. The higher-resolution complete run took 167.7 seconds with the same
pass/fail counts. The G1-aware planar-only run took 79.6 seconds (two failures, seven filtered out).
These timings cover the respective test runs and are not per-command interaction guarantees.

The new G1-aware diagnostics were verified inside the tested WASM bytes; identical residuals were
not caused by loading an older kernel. A bounded experiment varies the approximation segment
budget between 64 and 512 and records its own distance and angular criterion errors. At 400
segments, the equal 10 mm candidate's boundary distance passes, but its angle still fails; the
approximation reports an angular criterion error of 0.004407 rad and an overall plate approximation
distance of 0.008389 mm. This single geometry test takes 52.7 seconds. Closer equal and asymmetric
setback candidates are being evaluated separately rather than hiding the larger failed cases.
The acceptance limits remain unchanged. It must establish acceptable planar geometry before
additional saved-feature work; curved-support feasibility requires a separate proof.

## Latest preserved experiments

At 400 segments, closer 3/3/3 mm setbacks give final G0 0.000002 mm and G1 0.001298 rad;
3/4/5 mm gives G0 0.000004 mm and G1 0.002307 rad. Both reject unchanged tolerances.
At 512 segments, equal 2.5 mm setbacks pass fitting/tangency checks and closed sewing/orientation,
but fail final BREP validity. Asymmetric 2.5/2.6/2.7 mm still fails G1 at 0.001060 rad.
All these trials verify unchanged input BREP and cached display mesh even when fitting fails.

The next unimplemented investigation is the standard BRepLib::SameParameter boundary correction,
with an explicit maximum 0.0001 mm tolerance and stage diagnostics. No accepted solid, schema,
UI or MCP implementation exists. The agent stopped when workspace credits were exhausted;
all experimental source, tests and matching experimental binaries remain in mouse-84.
