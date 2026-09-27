// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "./config";

export const Navigation3DTypes = ["Spicy3D", "Revit", "Blender", "Creo", "Solidworks", "Fusion360"] as const;

export type Navigation3DType = (typeof Navigation3DTypes)[number];

export class Navigation3D {
    static getKey(event: MouseEvent) {
        let key = "Middle";
        if (event.shiftKey) {
            key = `Shift+${key}`;
        }
        if (event.ctrlKey) {
            key = `Ctrl+${key}`;
        }
        if (event.altKey) {
            key = `Alt+${key}`;
        }
        return key;
    }

    /** The pan/rotate mouse buttons of a profile — the active one unless a profile is named. */
    static navigationKeyMap(profile: Navigation3DType = Config.instance.navigation3D): {
        pan: string;
        rotate: string;
    } {
        const functionKey = {
            ["Spicy3D"]: {
                pan: "Middle",
                rotate: "Shift+Middle",
            },
            ["Revit"]: {
                pan: "Middle",
                rotate: "Shift+Middle",
            },
            ["Blender"]: {
                pan: "Shift+Middle",
                rotate: "Middle",
            },
            ["Creo"]: {
                pan: "Shift+Middle",
                rotate: "Middle",
            },
            ["Solidworks"]: {
                pan: "Ctrl+Middle",
                rotate: "Middle",
            },
            ["Fusion360"]: {
                pan: "Middle",
                rotate: "Shift+Middle",
            },
        } satisfies Record<
            Navigation3DType,
            {
                pan: string;
                rotate: string;
            }
        >;
        return functionKey[profile];
    }
}
