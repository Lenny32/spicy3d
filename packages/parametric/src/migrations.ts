// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerDocumentModule, registerMigration } from "@spicy3d/core";

/**
 * Format of a `ParametricBodyNode`'s stored feature list (`features`, the feature records and the
 * `EdgeRef`/`ProfileRef` inside them).
 * 2: `extrudeTarget` features (an extrude acting on other bodies than its host) — a build reading only
 * v1 would fail those bodies with "Unknown feature type".
 * 3: extrude extents (`extent` / `secondExtent`: to object, through all) — a build reading only v2 would
 * ignore them and sweep the blind `depth` instead.
 * 4: `loft` features (a loft through sketch profiles) — a build reading only v3 would fail those bodies
 * with "Unknown feature type".
 * 5: `thicken` features (a shell / thicken of the previous shape) — a build reading only v4 would fail
 * those bodies with "Unknown feature type".
 * 6: associative extrusion starting faces; older builds would ignore the selected surface.
 * 7: variable fillet radius laws; older builds would ignore the law and use a constant radius.
 */
export const PARAMETRIC_FORMAT_VERSION = 7;
/**
 * Format of a `SketchNode`'s stored `SketchData` (entities, constraints, external references).
 * 2: `bspline` entities (one interpolating B-spline edge through fit points, with `parametrization`
 * and `periodic`) and the `PointOnBSpline` / `TangentLineBSpline` constraint kinds — a build reading
 * only v1 knows neither and could not solve or build those sketches.
 * 3: optional control definition; params are control poles when present, fit points otherwise.
 */
export const SKETCH_FORMAT_VERSION = 3;

// Changing either payload's shape means bumping its version here, adding
// `registerMigration("parametric" | "sketch", previous, migrate)` below — a pure function over the
// whole document envelope that rewrites the matching nodes in `models.nodes` — and a fixture
// under `packages/core/test/fixtures/documents/`.
registerDocumentModule("parametric", PARAMETRIC_FORMAT_VERSION);
registerDocumentModule("sketch", SKETCH_FORMAT_VERSION);

// parametric 1 → 2: the `extrudeTarget` feature type is new; every v1 feature list is a valid v2 one.
registerMigration("parametric", 1, (document) => document);

// parametric 2 → 3: extrudes gain optional extents; an absent `extent` is a blind distance, exactly what
// every v2 extrude is — no data to rewrite.
registerMigration("parametric", 2, (document) => document);

// parametric 3 → 4: the `loft` feature type is new; every v3 feature list is a valid v4 one.
registerMigration("parametric", 3, (document) => document);

// parametric 4 → 5: the `thicken` feature type is new; every v4 feature list is a valid v5 one.
registerMigration("parametric", 4, (document) => document);

// sketch 1 → 2: the `bspline` entity type and its two constraint kinds are new; every v1 sketch is a
// valid v2 one (the `spline` entity is unchanged) — no data to rewrite.
registerMigration("sketch", 1, (document) => document);

// sketch 2 → 3: absent control metadata retains fit-point semantics verbatim.
registerMigration("sketch", 2, (document) => document);

// parametric 5 → 6: optional associative starting faces; absent preserves old extrusions.
registerMigration("parametric", 5, (document) => document);

// parametric 6 → 7: optional fillet radius laws; absent preserves the constant-radius operation.
registerMigration("parametric", 6, (document) => document);
