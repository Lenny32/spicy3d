// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    displayNodeName,
    formatDateTime,
    I18n,
    type I18nKeys,
    type MergeConflict,
    type MergeResult,
    parseMergePath,
    type ResolutionChoice,
    type Serialized,
} from "@spicy3d/core";
import type { SyncSide } from "../sync/syncEngine";

// What the conflict panel says (CLOUD-13): the sides' labels, the conflicts' descriptions and
// values. Formatted at render time (dates in the browser's locale, CLOUD-08).

/** The label of each choice: a side, both sides in an order, or the merge as it is. */
export const CHOICE_LABELS: Readonly<Record<ResolutionChoice, I18nKeys>> = {
    ours: "cloud.merge.choice.ours",
    theirs: "cloud.merge.choice.theirs",
    "ours-first": "cloud.merge.choice.oursFirst",
    "theirs-first": "cloud.merge.choice.theirsFirst",
    accept: "cloud.merge.choice.accept",
};

function sideTime(side: SyncSide): string {
    return side.at !== undefined && Number.isFinite(side.at)
        ? formatDateTime(side.at)
        : I18n.translate("cloud.conflict.unknownTime");
}

/** "This device (Desktop – Firefox) · 27/09/2026 14:05". */
export function oursLabel(side: SyncSide): string {
    return side.deviceName
        ? I18n.translate("cloud.merge.thisDeviceNamed{0}{1}", side.deviceName, sideTime(side))
        : I18n.translate("cloud.merge.thisDevice{0}", sideTime(side));
}

/** "Laptop – Chrome · 27/09/2026 14:02", or "Agent (MCP) · …" for a version an agent saved. */
export function theirsLabel(side: SyncSide): string {
    if (side.kind === "mcp") return I18n.translate("cloud.merge.agent{0}", sideTime(side));
    const device = side.deviceName || I18n.translate("cloud.conflict.unknownDevice");
    return I18n.translate("cloud.merge.otherDevice{0}{1}", device, sideTime(side));
}

/** Short name of the other side, for buttons and notes ("Laptop – Chrome", "Agent (MCP)"). */
export function theirsName(side: SyncSide): string {
    if (side.kind === "mcp") return I18n.translate("cloud.merge.agentName");
    return side.deviceName || I18n.translate("cloud.conflict.unknownDevice");
}

/** Node names of the three inputs and the merge (`id → display name`), for labels and values. */
export class MergeNames {
    private readonly names = new Map<string, string>();

    constructor(result: MergeResult) {
        for (const doc of [result.inputs.base, result.inputs.theirs, result.inputs.ours, result.merged]) {
            for (const node of nodesOf(doc)) {
                const id = node["id"];
                const name = node["name"];
                if (typeof id !== "string") continue;
                if (typeof name === "string" && name !== "") this.names.set(id, displayNodeName(name));
                else if (!this.names.has(id)) this.names.set(id, String(node["__cla$$__"] ?? id));
            }
        }
    }

    node(id: string): string {
        return this.names.get(id) ?? id;
    }
}

function nodesOf(doc: Serialized): Record<string, unknown>[] {
    const models = doc["models"] as { nodes?: unknown } | undefined;
    return Array.isArray(models?.nodes) ? (models.nodes as Record<string, unknown>[]) : [];
}

/** What the conflict is about, e.g. "Extrude 3: depth was changed on both devices". */
export function conflictDescription(conflict: MergeConflict): string {
    // The label is a stored name ("body.box1" → "Box 1").
    const args = conflict.args.map((arg, index) =>
        index === 0 && typeof arg === "string" ? displayNodeName(arg) : arg,
    );
    return I18n.translate(conflict.messageKey, ...args);
}

const MAX_TEXT = 80;

function shorten(text: string): string {
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/**
 * One side's value of a conflict, for display: absent = "Deleted" / "Not there", a parent id =
 * that node's name, a number or expression as it is, an item by its name, anything bigger as
 * "changed" (the full value is in the merge report).
 */
export function formatConflictValue(conflict: MergeConflict, value: unknown, names: MergeNames): string {
    if (value === undefined || value === null) {
        return I18n.translate(
            conflict.kind === "delete-vs-modify" ? "cloud.merge.value.deleted" : "cloud.merge.value.absent",
        );
    }
    const field = parseMergePath(conflict.path).at(-1);
    if (typeof value === "string") {
        if (field === "parent") return names.node(value);
        return shorten(value);
    }
    if (typeof value === "number") return String(Number(value.toFixed(6)));
    if (typeof value === "boolean")
        return I18n.translate(value ? "cloud.merge.value.yes" : "cloud.merge.value.no");
    if (Array.isArray(value)) return I18n.translate("cloud.merge.value.items{0}", value.length);
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (
            typeof record["type"] === "string" &&
            parseMergePath(conflict.path).includes("entity") &&
            [conflict.base, conflict.ours, conflict.theirs].some(
                (side) =>
                    side !== null &&
                    typeof side === "object" &&
                    (side as Record<string, unknown>)["derivation"] === "offset",
            )
        )
            return I18n.translate(
                record["derivation"] === "offset"
                    ? "cloud.merge.value.associativeOffset"
                    : "cloud.merge.value.detached",
            );
        if ("datum" in record) {
            const datum = formatConflictValue(conflict, record["datum"], names);
            if (record["angleSide"] === -1 || record["angleSide"] === 1) {
                const side = I18n.translate(
                    record["angleSide"] === -1
                        ? "cloud.merge.value.clockwise"
                        : "cloud.merge.value.counterclockwise",
                );
                const angle =
                    typeof record["datum"] === "number"
                        ? String(Number(((record["datum"] * 180) / Math.PI).toFixed(6)))
                        : datum;
                return `${angle}° (${side})`;
            }
            return datum;
        }
        if (typeof record["$blob"] === "string") return I18n.translate("cloud.merge.value.data");
        if (typeof record["name"] === "string" && record["name"] !== "")
            return shorten(displayNodeName(record["name"]));
        if (typeof record["type"] === "string") return shorten(record["type"]);
        if (typeof record["expression"] === "string") return shorten(record["expression"]);
        return I18n.translate("cloud.merge.value.changed");
    }
    return shorten(String(value));
}
