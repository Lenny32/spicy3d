// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IVisualObject } from "./visualObject";

export interface ITextGenerator {
    generate(text: string, size: number, color: number, font: "fzhei"): Promise<IVisualObject>;
}
