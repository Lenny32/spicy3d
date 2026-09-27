// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IPicker, VisualNode } from "../src";
import type { VisualShapeData } from "../src/visual";

export interface MockPickerConfig {
    pickShapeResult?: VisualShapeData[];
    pickNodeResult?: VisualNode[];
}

export function createMockPicker(config?: MockPickerConfig): IPicker {
    return {
        pickShape: () => Promise.resolve(config?.pickShapeResult ?? []),
        pickNode: () => Promise.resolve(config?.pickNodeResult ?? []),
        pickAsync: () => Promise.resolve(),
    };
}
