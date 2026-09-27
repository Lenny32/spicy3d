// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { components } from "./schema.generated";

export type { components, operations, paths } from "./schema.generated";

/** A schema of the server API by name, e.g. `ApiSchema<"DocumentResponse">`. */
export type ApiSchema<K extends keyof components["schemas"]> = components["schemas"][K];

export type ConfigResponse = ApiSchema<"ConfigResponse">;
