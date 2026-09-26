// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerDocumentModule } from "@spicy3d/core";

/**
 * Format of a `ParametricBodyNode`'s stored feature list (`features`, the feature records and the
 * `EdgeRef`/`ProfileRef` inside them).
 */
export const PARAMETRIC_FORMAT_VERSION = 1;
/** Format of a `SketchNode`'s stored `SketchData` (entities, constraints, external references). */
export const SKETCH_FORMAT_VERSION = 1;

// Changing either payload's shape means bumping its version here, adding
// `registerMigration("parametric" | "sketch", previous, migrate)` below — a pure function over the
// whole document envelope that rewrites the matching nodes in `models.nodes` — and a fixture
// under `packages/core/test/fixtures/documents/`.
registerDocumentModule("parametric", PARAMETRIC_FORMAT_VERSION);
registerDocumentModule("sketch", SKETCH_FORMAT_VERSION);
