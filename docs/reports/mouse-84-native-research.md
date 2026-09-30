# Corner setback native construction and measured acceptance

Issue #84 remains incomplete while saved-feature editing and MCP integration are implemented.
The native and worker foundation now constructs a valid solid with three independent setbacks.
The accepted product configuration uses degree 14, at most 512 approximation segments, the default
1.1 UV enlargement, and the existing 90-second worker deadline. It requires explicit recomputation;
it is too expensive for continuous drag previews. The retained strips use the requested constant
radius. Public quadrilateral alternatives described below failed continuity checks and were removed
from the production source and bindings.

## Accepted unequal-setback proof

A 40 mm cube with radius 2 mm and setbacks 2.49/2.50/2.51 mm produces a valid closed solid with
positive reduced volume, no self-interference, three unchanged radius-2 cylinders, and one exact
section at each independently requested distance. Actual copy/fillet/boolean/sewing history
reports the corner role, its three original support ancestors, and the three strip-generating
original edges. BREP bytes and existing display-cache positions remain unchanged for success
and invalid-input failures. Native validation operates on a deep geometry copy, without mesh data.
Trim sections come from OCCT's boolean section history rather than sampled coplanarity recognition.

| Measured quantity | Accepted value | Limit |
| --- | ---: | ---: |
| Independent CAD boundary G0 distance | 0.00000064916018127 mm | 0.0001 mm |
| Independent CAD boundary normal angle | 0.00084060763676 rad | 0.001 rad |
| OCCT reported `ApproxError` | 0.000062741417785 mm | 0.0001 mm |
| OCCT reported `CriterionError` | 0.00084048964331 rad | 0.001 rad |
| Native construction time | 60,508 ms | 90,000 ms worker deadline |

All four metrics must be finite and nonnegative. The independently checked CAD joins, reported
plate/approximation metrics, repaired edge tolerances, BREP validity, and self-interference checks
remain separate acceptance gates. OCCT's approximation distance covers an enlarged rectangular
UV domain; its angular criterion covers supplied constraints. Together with 33 samples per CAD
boundary these are bounded engineering checks, not a global mathematical certificate.

Actual bundled Chromium 153 and Firefox 155 workers passed under deployment CSP without external
network requests. The same asymmetric fit took 60,418/63,996 ms and preserved actual support/strip
ancestry and all four metrics. The main page ticked 6,041/6,201 times during construction.
A separate test port observed entry into native fitting before cancellation. Cancellation terminated
exactly one worker in 0.2/0 ms, cleared pending requests, rejected old generation handles, and
created valid geometry in a fresh worker. These timings are measurements on this host, not universal
performance promises. Inputs exceeding the existing worker deadline fail clearly.

An earlier curved-support proof on a positive spherical octant passed repaired boundary checks,
closed-solid validity, and input preservation, but took 128.2 seconds and therefore exceeds the
product worker budget. It did not record the subsequently required reported fit metrics. Curved
supports are geometrically investigated, but this case is not claimed as accepted production input.

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

The current bounded eligibility is one valid solid, three distinct edges sharing exactly one
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
| G1 criterion, 400 segments | Cube, equal 3 mm setbacks | 0.000002 | 0.001298 | rounded to zero | 0.000036 | rejected |
| Same | Cube, 3/4/5 mm setbacks | 0.000004 | 0.002307 | rounded to zero | 0.000046 | rejected |
| G1 criterion, 512 segments | Cube, equal 2.5 mm setbacks | <= 0.0001 | <= 0.001 | not separately recorded | not separately recorded | continuity/closed sewing passed; final BREP invalid |
| Same | Cube, 2.5/2.6/2.7 mm setbacks | 0.000001 | 0.001060 | rounded to zero | 0.000048 | rejected |
| G1 criterion, 400 segments | Cube, equal 10 mm setbacks | 0.000030 | 0.004411 | 0.000005 | 0.000274 | rejected |
| MakeFilling, 50 sites / 5 iterations / 100 segments | Spherical-support octant, 8 mm setbacks | 0.000499 | 0.013564 | 0.000015 | 0.002865 | rejected |
| Public plate builder + G1 approximation criterion, 100 segments | Cube, equal 10 mm setbacks | 0.000274 | 0.009346 | 0.000005 | 0.000274 | rejected |
| Same | Cube, 8/10/12 mm setbacks | 0.000431 | 0.011239 | 0.000005 | 0.000369 | rejected |

The cube is 40 mm on each side with a 2 mm retained fillet radius. The curved case is the positive
octant of a 40 mm sphere, at its corner on the positive X axis, with a 1 mm retained fillet radius.
Both planar and curved candidates reached patch construction, so support trimming and boundary
ordering worked for these earlier inputs. Later curved-support findings are qualified above.

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
The equal 2.5 mm case reaches closed sewing and solid orientation at a 512-segment budget, but
the final BREP remains invalid. Its asymmetric peer narrowly fails tangent agreement. Together
these two tests take 89.5 seconds, and both preserve input BREP bytes and cached display positions.
The next source experiment adds the same `BRepLib::SameParameter` correction used by OCCT's
filling implementation, rejects corrected boundary tolerances above 0.0001 mm, and reports
contextual BREP statuses separately for the patch and final solid. With that correction, the equal
2.5 mm candidate passes closed sewing, BREP validity, self-interference rejection, positive reduced
volume, and all boundary checks. The three retained cylinders still have exactly the requested
2 mm radius, and the original BREP and cached mesh remain unchanged. The test takes 49.8 seconds.
The acceptance limits remain unchanged. The later degree-14 asymmetric case meets all four
measured accuracy limits, as recorded above.

## Bounded quadrilateral construction

The rejected alternative divided the six-edge opening into three quadrilateral patches. Three
shared radial cubic curves meet at a common interior vertex. Each radial curve carries an exact
linear-extrusion support ribbon: its endpoint tangent planes match the outer support and a common
center normal. Both neighboring patches use the same ribbon. Public
`GeomFill_ConstrainedFilling` approximates their boundary and tangent fields with a bounded
one-dimensional solve. The resulting CAD joins are checked independently, including direct
patch-to-patch checks across each radial curve, before sewing.

The first unequal 3/4/5 mm test rejected after 226 ms because boundary parameter repair exceeded
the unchanged 0.0001 mm tolerance. Its input BREP and cached display mesh checks passed. The full
13-test run took 1.5 seconds for native tests: five invalid-input tests passed, while seven planar
geometry cases and the spherical-support octant rejected at edge or vertex parameter repair.
This establishes a useful runtime bound for the experiment, not acceptable output geometry.
A diagnostic follow-up measures CAD boundary continuity before parameter repair and records the
specific corrected edge tolerance, to distinguish fitting error from pcurve parameterization.

`NoCheck` did not repair continuity: an asymmetric case reported about 0.3113 rad and the curved
case about 0.2474 rad. This construction was rejected and removed. The accepted single-plate
construction is the native/worker foundation; feature/UI/MCP completion remains a separate step.
