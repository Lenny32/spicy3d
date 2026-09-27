// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { RibbonTabKeys, RibbonTabProfile } from "@spicy3d/core";

/**
 * Fusion 360-style layout: workflow tabs, task-named groups. Only direct-modeling commands live
 * here so the ribbon works without `useParametric()`; the parametric and sketch profiles prepend
 * their `feature.*` / `sketch.*` commands to the same groups.
 */
export const DefaultRibbon: RibbonTabProfile[] = [
    {
        tabName: "ribbon.tab.solid",
        groups: [
            {
                groupName: "ribbon.group.create",
                items: [
                    "create.sweep",
                    "create.loft",
                    {
                        type: "split",
                        items: [
                            "create.box",
                            "create.cylinder",
                            "create.sphere",
                            "create.cone",
                            "create.pyramid",
                        ],
                    },
                ],
                collapsedItems: [
                    "create.extrude",
                    "create.revol",
                    "create.pipe",
                    "create.helix",
                    "create.thickSolid",
                    "modify.array",
                    "modify.mirror",
                ],
            },
            {
                groupName: "ribbon.group.modify",
                items: ["modify.shell", "modify.move"],
                collapsedItems: [
                    "modify.rotate",
                    "modify.split",
                    "modify.removeFeature",
                    "modify.fillet",
                    "modify.chamfer",
                    "boolean.join",
                    "boolean.cut",
                    "boolean.common",
                    "modify.simplifyShape",
                    "modify.explode",
                    "modify.paintBucket",
                    "modify.brushAdd",
                    "modify.brushRemove",
                    "modify.brushClear",
                    "modify.deleteNode",
                    "modify.removeShapes",
                ],
            },
            {
                groupName: "ribbon.group.assemble",
                items: ["create.group"],
                collapsedItems: ["create.folder"],
            },
            {
                groupName: "ribbon.group.construct",
                items: [
                    "construct.offsetPlane",
                    "construct.axisThroughEdge",
                    "construct.pointAtVertex",
                    "construct.ucs",
                    "workingPlane.set",
                    "workingPlane.toggleDynamic",
                ],
                collapsedItems: [
                    "construct.midplane",
                    "construct.planeAtAngle",
                    "construct.planeThroughTwoEdges",
                    "construct.planeThroughThreePoints",
                    "construct.planeAlongPath",
                    "construct.tangentPlane",
                    "construct.perpendicularPlane",
                    "construct.axisThroughCylinder",
                    "construct.axisPerpendicularToFace",
                    "construct.axisThroughTwoPlanes",
                    "construct.axisThroughTwoPoints",
                    "construct.pointThroughTwoEdges",
                    "construct.pointThroughThreePlanes",
                    "construct.pointAtCenter",
                    "construct.pointAtEdgeAndPlane",
                    "construct.pointAlongPath",
                    "workingPlane.alignToPlane",
                    "workingPlane.fromSection",
                ],
            },
            {
                groupName: "ribbon.group.inspect",
                items: ["inspect.measure", "inspect.section", "inspect.interference", "inspect.centerOfMass"],
                collapsedItems: [
                    "inspect.curvatureComb",
                    "inspect.curvatureMap",
                    "inspect.draft",
                    "inspect.environmentMap",
                    "inspect.isocurves",
                    "inspect.zebra",
                    "inspect.accessibility",
                    "inspect.minimumRadius",
                    "inspect.designAdvice",
                    "inspect.fastenerStack",
                    "inspect.componentColors",
                    "inspect.meshFaceGroups",
                    "inspect.similarComponents",
                    "inspect.addToLibrary",
                    "inspect.removeFromLibrary",
                    "measure.length",
                    "measure.angle",
                    "measure.select",
                    "create.section",
                    "modify.checkShape",
                ],
            },
            {
                groupName: "ribbon.group.insert",
                items: ["file.import"],
                collapsedItems: ["convert.curveProjection"],
            },
        ],
    },
    {
        tabName: "ribbon.tab.surface",
        groups: [
            {
                groupName: "ribbon.group.create",
                items: [
                    "create.line",
                    {
                        type: "split",
                        items: ["create.rect", "create.circle", "create.ellipse", "create.regularPolygon"],
                    },
                    {
                        type: "split",
                        items: ["create.arc", "create.arc2point", "create.arc3point", "create.arcTTR"],
                    },
                    "create.extrude",
                    "create.offset",
                ],
                collapsedItems: [
                    "create.point",
                    "create.polygon",
                    "create.bezier",
                    "create.revol",
                    "create.sweep",
                    "create.loft",
                    "create.thickSolid",
                ],
            },
            {
                groupName: "ribbon.group.modify",
                items: ["modify.trim", "modify.extend", "modify.sew", "modify.split"],
                collapsedItems: ["modify.break", "create.copyShape", "modify.repairShape"],
            },
            {
                groupName: "ribbon.group.convert",
                items: ["convert.toWire", "convert.toFace", "convert.toSolid"],
                collapsedItems: ["convert.toShell", "convert.toCompound"],
            },
        ],
    },
    {
        tabName: "ribbon.tab.utilities",
        groups: [
            {
                groupName: "ribbon.group.tools",
                items: ["ai.toggleChat", "act.alignCamera"],
                collapsedItems: ["test.performance"],
            },
        ],
    },
];

/** Extras may request insertion before an existing tab instead of appending. */
export type RibbonProfileExtra = RibbonTabProfile & { before?: RibbonTabKeys };

/**
 * Ribbon contributions of the parametric module, applied by `AppBuilder.useParametric`.
 * Feature commands are prepended to the SOLID groups so they come before the direct ones.
 */
export const ParametricRibbonProfiles: RibbonProfileExtra[] = [
    {
        tabName: "ribbon.tab.solid",
        groups: [
            {
                groupName: "ribbon.group.create",
                items: ["feature.extrude", "feature.revolve"],
            },
            {
                groupName: "ribbon.group.modify",
                items: [
                    "feature.fillet",
                    "feature.chamfer",
                    { type: "split", items: ["feature.fuse", "feature.cut", "feature.common"] },
                ],
                collapsedItems: ["feature.variable"],
            },
        ],
    },
];

/**
 * Returns a new profile list with `extras` merged into a copy of `base`: extra
 * items are prepended to the matching group (contributions land first), unknown
 * groups are appended, and new tabs are inserted before their `before` tab or
 * appended. `base` is left untouched.
 */
export function mergeRibbonProfiles(
    base: RibbonTabProfile[],
    extras: RibbonProfileExtra[],
): RibbonTabProfile[] {
    const result = base.map((tab) => ({
        ...tab,
        groups: tab.groups.map((group) => ({
            ...group,
            items: [...group.items],
            collapsedItems: group.collapsedItems === undefined ? undefined : [...group.collapsedItems],
        })),
    }));
    for (const extra of extras) {
        mergeTab(result, extra);
    }
    return result;
}

function mergeTab(result: RibbonTabProfile[], extra: RibbonProfileExtra): void {
    const tab = result.find((t) => t.tabName === extra.tabName);
    if (tab === undefined) {
        const beforeIndex = result.findIndex((t) => t.tabName === extra.before);
        if (beforeIndex < 0) {
            result.push(extra);
        } else {
            result.splice(beforeIndex, 0, extra);
        }
        return;
    }
    tab.contextual = tab.contextual || extra.contextual;
    for (const group of extra.groups) {
        const existing = tab.groups.find((g) => g.groupName === group.groupName);
        if (existing === undefined) {
            tab.groups.push(group);
        } else {
            existing.items.unshift(...group.items);
            existing.iconOnly = existing.iconOnly || group.iconOnly;
            existing.primary = existing.primary || group.primary;
            if (group.collapsedItems !== undefined) {
                existing.collapsedItems = [...group.collapsedItems, ...(existing.collapsedItems ?? [])];
            }
        }
    }
}
