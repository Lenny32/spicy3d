// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerDocumentModule, registerMigration } from "@spicy3d/core";

/**
 * Format of a `ParametricBodyNode`'s stored feature list (`features`, the feature records and the
 * `EdgeRef`/`ProfileRef` inside them).
 * 2: `extrudeTarget` features (an extrude acting on other bodies than its host) — a build reading only
 * v1 would fail those bodies with "Unknown feature type".
 */
export const PARAMETRIC_FORMAT_VERSION = 2;
/** Format of a `SketchNode`'s stored `SketchData` (entities, constraints, external references). */
export const SKETCH_FORMAT_VERSION = 1;

// Changing either payload's shape means bumping its version here, adding
// `registerMigration("parametric" | "sketch", previous, migrate)` below — a pure function over the
// whole document envelope that rewrites the matching nodes in `models.nodes` — and a fixture
// under `packages/core/test/fixtures/documents/`.
registerDocumentModule("parametric", PARAMETRIC_FORMAT_VERSION);
registerDocumentModule("sketch", SKETCH_FORMAT_VERSION);

// parametric 1 → 2: the `extrudeTarget` feature type is new; every v1 feature list is a valid v2 one.
registerMigration("parametric", 1, (document) => document);
