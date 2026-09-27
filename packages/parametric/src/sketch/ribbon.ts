// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { RibbonTabKeys, RibbonTabProfile } from "@spicy3d/core";

/** Extras may request insertion before an existing tab instead of appending. */
type RibbonProfileExtra = RibbonTabProfile & { before?: RibbonTabKeys };

/**
 * Ribbon contributions of the sketch module, applied by `AppBuilder.useParametric`.
 * Without it no sketch command is registered, so these stay out of the ribbon.
 */
export const SketchRibbonProfiles: RibbonProfileExtra[] = [
    {
        tabName: "ribbon.tab.solid",
        groups: [
            {
                groupName: "ribbon.group.create",
                items: ["sketch.create"],
                collapsedItems: ["sketch.enter"],
            },
        ],
    },
    {
        tabName: "ribbon.tab.sketch",
        contextual: true,
        groups: [
            {
                groupName: "ribbon.group.create",
                items: [
                    "sketch.line",
                    "sketch.rectangle",
                    "sketch.circle",
                    "sketch.arc",
                    "sketch.polygon",
                    "sketch.ellipse",
                    "sketch.spline",
                    "sketch.point",
                    "sketch.projectEdges",
                ],
                collapsedItems: ["sketch.toggleExternal"],
            },
            {
                groupName: "ribbon.group.modify",
                items: ["sketch.trim", "sketch.extend", "sketch.split", "sketch.offset"],
                collapsedItems: [
                    "sketch.mirror",
                    "sketch.copy",
                    "sketch.paste",
                    "sketch.move",
                    "sketch.rotate",
                ],
            },
            {
                groupName: "ribbon.group.constraint",
                iconOnly: true,
                items: [
                    ["constraint.coincident", "constraint.fix", "constraint.pointOn"],
                    ["constraint.horizontal", "constraint.vertical", "constraint.midpoint"],
                    ["constraint.parallel", "constraint.perpendicular", "constraint.equal"],
                    ["constraint.tangent", "constraint.symmetric"],
                    ["constraint.collinear", "constraint.block", "constraint.construction"],
                    ["constraint.equalAngle", "constraint.scale"],
                    ["constraint.horizontalAlign", "constraint.verticalAlign"],
                ],
            },
            {
                groupName: "ribbon.group.dimension",
                items: [
                    {
                        type: "split",
                        items: [
                            "dimension.distance",
                            "dimension.horizontalDistance",
                            "dimension.verticalDistance",
                            "dimension.pointLineDistance",
                            "dimension.radius",
                            "dimension.angle",
                        ],
                    },
                ],
            },
            {
                groupName: "ribbon.group.finish",
                primary: true,
                items: ["sketch.exit", "sketch.autoConstrain"],
            },
        ],
    },
];
