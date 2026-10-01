// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentFormatError, DocumentMigrations } from "./documentFormat";
import { Result, trimEndChars } from "./foundation";
import { I18n, type I18nKeys } from "./i18n";
import { diffViews } from "./merge/diff";
import { DocumentView, payloadProperties, timelineProperty } from "./merge/documentView";
import { isRecord } from "./merge/json";
import { type MergeRuleRegistry, MergeRules } from "./merge/rules";
import type { Change } from "./merge/types";
import { parseMergePath } from "./merge/types";
import type { Serialized } from "./serialize";
import { formatLengthForEditing, isLengthUnit, type LengthUnit } from "./units/lengthUnit";

export type DocumentChangeKind = "added" | "removed" | "renamed" | "modified" | "moved" | "reordered";

/** One line of a comparison, e.g. "Extrude 3: depth 10 mm → 15 mm"; the text is `I18n.translate(message, ...args)`. */
export interface DocumentChange {
    kind: DocumentChangeKind;
    /** What changed (a merge path, docs/merge.md), stable across comparisons. */
    target: string;
    message: I18nKeys;
    args: unknown[];
}

/**
 * Tells what changed between two serialized documents, both already migrated to this build's
 * format (`compareDocuments` does that). The version history's "Compare" lists its answer.
 */
export interface IDocumentDiffer {
    diff(before: Serialized, after: Serialized): DocumentChange[];
}

// ------------------------------------------------------------------ Display

/** Parameters shown with the document's length unit, and in degrees. */
const LENGTH_FIELDS = new Set([
    "depth",
    "startOffset",
    "radius",
    "distance",
    "dx",
    "dy",
    "dz",
    "length",
    "width",
    "height",
    "thickness",
    "offset",
    "pitch",
    "displaySize",
]);
const ANGLE_FIELDS = new Set(["angle"]);

/** A node name for display: names like `body.box1` are an i18n key plus a counter ("Box 1"). */
export function displayNodeName(name: string): string {
    if (I18n.isI18nKey(name)) return I18n.translate(name);
    const key = trimEndChars(name, "0123456789");
    if (key.length < name.length && I18n.isI18nKey(key))
        return `${I18n.translate(key as I18nKeys)} ${name.slice(key.length)}`;
    return name;
}

function fieldLabel(field: string): string {
    const key = `diff.field.${field}`;
    return I18n.isI18nKey(key) ? I18n.translate(key) : field;
}

function formatValue(field: string, value: unknown, unit: LengthUnit): string {
    if (typeof value === "number") {
        if (ANGLE_FIELDS.has(field)) return `${Number(value.toFixed(3))}°`;
        if (LENGTH_FIELDS.has(field)) return `${formatLengthForEditing(value, unit)} ${unit}`;
        return String(Number(value.toFixed(6)));
    }
    return String(value);
}

/** Sketch items summarized per sketch ("Sketch 2: +3 lines, −1 constraint"). */
const SKETCH_SEGMENTS = new Set(["entity", "constraint", "external", "anchor", "text"]);
const NOUNS: Record<string, [I18nKeys, I18nKeys]> = {
    text: ["diff.noun.text", "diff.noun.texts"],
    line: ["diff.noun.line", "diff.noun.lines"],
    circle: ["diff.noun.circle", "diff.noun.circles"],
    arc: ["diff.noun.arc", "diff.noun.arcs"],
    point: ["diff.noun.point", "diff.noun.points"],
    ellipse: ["diff.noun.ellipse", "diff.noun.ellipses"],
    spline: ["diff.noun.spline", "diff.noun.splines"],
    bspline: ["diff.noun.bspline", "diff.noun.bsplines"],
    entity: ["diff.noun.entity", "diff.noun.entities"],
    constraint: ["diff.noun.constraint", "diff.noun.constraints"],
    external: ["diff.noun.external", "diff.noun.externals"],
    anchor: ["diff.noun.anchor", "diff.noun.anchors"],
};

function noun(kind: string, count: number): string {
    const [one, many] = NOUNS[kind] ?? NOUNS["entity"];
    return I18n.translate(count === 1 ? one : many);
}

/**
 * The Compare lines of a list of changes (`diffDocuments`, a merge's `changes`): one line per
 * change, with display names ("Extrude 3", "Box 1") and values in the document's unit; the items
 * inside an added or removed node are not listed again, and a sketch's entity and constraint
 * changes are summarized in one line.
 */
export function summarizeChanges(
    changes: readonly Change[],
    before: Serialized,
    after: Serialized,
    rules: MergeRuleRegistry = MergeRules,
): DocumentChange[] {
    const views = [new DocumentView("base", before, rules), new DocumentView("merged", after, rules)];
    const settings = after["settings"];
    const unitValue = isRecord(settings) ? settings["lengthUnit"] : undefined;
    const unit: LengthUnit = typeof unitValue === "string" && isLengthUnit(unitValue) ? unitValue : "mm";

    const nodeName = (id: string) => {
        const node = views[1].byId.get(id) ?? views[0].byId.get(id);
        const name = node?.["name"];
        return typeof name === "string" && name !== ""
            ? displayNodeName(name)
            : String(node?.["__cla$$__"] ?? id);
    };
    const featureName = (bodyId: string, featureId: string) => {
        for (const view of [views[1], views[0]]) {
            const ids = view.timeline(bodyId);
            const index = ids?.indexOf(featureId) ?? -1;
            if (ids === undefined || index < 0) continue;
            const property = timelineProperty(rules, view.className(bodyId)!);
            const list = property === undefined ? undefined : view.payload(bodyId, property).value;
            const feature = Array.isArray(list) ? list[index] : undefined;
            if (!isRecord(feature)) continue;
            if (typeof feature["name"] === "string" && feature["name"] !== "") return feature["name"];
            const kind = feature["type"] === "boolean" ? feature["operation"] : feature["type"];
            const key = `command.feature.${String(kind)}`;
            return `${I18n.isI18nKey(key) ? I18n.translate(key) : String(kind)} ${index + 1}`;
        }
        return featureId;
    };

    /** An entity's type from the version that has it (a changed entity's change carries only its params). */
    const entityType = (sketchId: string, entityId: string): string => {
        for (const view of [views[1], views[0]]) {
            const className = view.className(sketchId);
            if (className === undefined) continue;
            for (const property of payloadProperties(rules, className).keys()) {
                const data = view.payload(sketchId, property).value;
                const entities = isRecord(data) && Array.isArray(data["entities"]) ? data["entities"] : [];
                const entity = entities.find((e) => isRecord(e) && String(e["id"]) === entityId);
                if (isRecord(entity) && typeof entity["type"] === "string") return entity["type"];
            }
        }
        return "entity";
    };

    // What is inside an added / removed node is not listed on its own.
    const whole = new Map<string, "added" | "removed">();
    for (const change of changes) {
        const segments = parseMergePath(change.path);
        if (
            segments[0] === "node" &&
            segments.length === 2 &&
            (change.kind === "added" || change.kind === "removed")
        ) {
            whole.set(segments[1], change.kind);
        }
    }
    const coveredBy = (id: string, kind: "added" | "removed") => {
        const view = kind === "added" ? views[1] : views[0];
        for (let parent = view.parentOf(id); parent !== undefined; parent = view.parentOf(parent)) {
            if (whole.get(parent) === kind) return true;
        }
        return false;
    };

    const lines: DocumentChange[] = [];
    const sketchSummaries = new Map<string, { line: DocumentChange; counts: Map<string, number> }>();
    for (const change of changes) {
        const segments = parseMergePath(change.path);
        const nodeId = segments[0] === "node" ? segments[1] : undefined;
        if (nodeId !== undefined) {
            const own = whole.get(nodeId);
            if (own !== undefined && (segments.length > 2 || coveredBy(nodeId, own))) continue;
        }
        const line = (message: I18nKeys, ...args: unknown[]) =>
            lines.push({ kind: change.kind, target: change.path, message, args });

        if (nodeId !== undefined && segments.length >= 4 && SKETCH_SEGMENTS.has(segments[2])) {
            let summary = sketchSummaries.get(nodeId);
            if (summary === undefined) {
                summary = {
                    line: {
                        kind: "modified",
                        target: `node/${nodeId}/sketch`,
                        message: "diff.summary{0}{1}",
                        args: [],
                    },
                    counts: new Map(),
                };
                sketchSummaries.set(nodeId, summary);
                lines.push(summary.line);
            }
            const type = segments[2] === "entity" ? entityType(nodeId, segments[3]) : segments[2];
            const sign = segments.length === 4 && change.kind !== "modified" ? change.kind : "modified";
            const key = `${sign}\u0000${type}\u0000${segments[3]}`;
            summary.counts.set(key, 1);
            continue;
        }
        if (nodeId !== undefined && segments[2] === "feature" && segments.length >= 4) {
            const label = featureName(nodeId, segments[3]);
            if (segments.length === 4) {
                line(
                    change.kind === "added"
                        ? "diff.added{0}"
                        : change.kind === "removed"
                          ? "diff.removed{0}"
                          : "diff.modified{0}",
                    label,
                );
            } else if (change.kind === "reordered") {
                line("diff.reordered{0}", label);
            } else if (change.kind === "renamed") {
                line("diff.renamed{0}{1}", ...change.args);
            } else {
                const field = segments.at(-1)!;
                if (change.messageKey === "diff.changedValue{0}{1}{2}{3}") {
                    line(
                        change.messageKey,
                        label,
                        fieldLabel(field),
                        formatValue(field, change.before, unit),
                        formatValue(field, change.after, unit),
                    );
                } else {
                    line("diff.modifiedField{0}{1}", label, fieldLabel(field));
                }
            }
            continue;
        }
        const label = nodeId !== undefined ? nodeName(nodeId) : String(change.args[0] ?? "");
        switch (change.messageKey) {
            case "diff.changedValue{0}{1}{2}{3}": {
                const field = String(change.args[1]);
                line(
                    change.messageKey,
                    label,
                    fieldLabel(field),
                    formatValue(field, change.before, unit),
                    formatValue(field, change.after, unit),
                );
                break;
            }
            case "diff.renamed{0}{1}": {
                const display = (x: unknown) =>
                    nodeId !== undefined ? displayNodeName(String(x)) : String(x);
                line(change.messageKey, display(change.args[0]), display(change.args[1]));
                break;
            }
            case "diff.modified{0}":
                if (nodeId !== undefined && segments[2] === "prop" && segments[3] !== undefined) {
                    line("diff.modifiedField{0}{1}", label, fieldLabel(segments[3]));
                } else {
                    line(change.messageKey, label);
                }
                break;
            default:
                line(change.messageKey, label);
        }
    }
    for (const [nodeId, summary] of sketchSummaries) {
        const totals = new Map<string, number>();
        for (const key of summary.counts.keys()) {
            const [sign, type] = key.split("\u0000");
            totals.set(`${sign}\u0000${type}`, (totals.get(`${sign}\u0000${type}`) ?? 0) + 1);
        }
        const parts: string[] = [];
        for (const sign of ["added", "removed", "modified"]) {
            for (const [key, count] of totals) {
                const [s, type] = key.split("\u0000");
                if (s !== sign) continue;
                const message: I18nKeys =
                    sign === "added"
                        ? "diff.count.added{0}{1}"
                        : sign === "removed"
                          ? "diff.count.removed{0}{1}"
                          : "diff.count.changed{0}{1}";
                parts.push(I18n.translate(message, count, noun(type, count)));
            }
        }
        summary.line.args = [nodeName(nodeId), parts.join(", ")];
    }
    return lines;
}

/** The semantic differ (CLOUD-12): the merge engine's two-way diff, as Compare lines. */
export class SemanticDiffer implements IDocumentDiffer {
    constructor(private readonly rules: MergeRuleRegistry = MergeRules) {}

    diff(before: Serialized, after: Serialized): DocumentChange[] {
        const changes = diffViews(
            new DocumentView("base", before, this.rules),
            new DocumentView("merged", after, this.rules),
            this.rules,
        );
        return summarizeChanges(changes, before, after, this.rules);
    }
}

/** The differ "Compare" uses: {@link SemanticDiffer} unless another one is registered. */
export class DocumentDiffers {
    private static differ: IDocumentDiffer = new SemanticDiffer();

    static get current(): IDocumentDiffer {
        return DocumentDiffers.differ;
    }

    /** Replaces the differ; returns a function that puts the previous one back. */
    static register(differ: IDocumentDiffer): () => void {
        const previous = DocumentDiffers.differ;
        DocumentDiffers.differ = differ;
        return () => {
            if (DocumentDiffers.differ === differ) DocumentDiffers.differ = previous;
        };
    }
}

/**
 * The Compare lines from `before` to `after` (serialized documents of any supported format: both
 * are migrated first, never modified), by the registered differ. A document that can't be
 * migrated (a newer format, not a Spicy3D document) is the error.
 */
export function compareDocuments(
    before: Serialized,
    after: Serialized,
    differ: IDocumentDiffer = DocumentDiffers.current,
): Result<DocumentChange[], DocumentFormatError> {
    const from = DocumentMigrations.migrate(before);
    if (!from.isOk) return Result.err(from.error);
    const to = DocumentMigrations.migrate(after);
    if (!to.isOk) return Result.err(to.error);
    return Result.ok(differ.diff(from.value, to.value));
}
