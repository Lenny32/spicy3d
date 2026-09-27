// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { DocumentFormatError } from "../documentFormat";
import { Result } from "../foundation/result";
import { applyResolutions, type MergeError } from "./merge";
import { type MergeRuleRegistry, MergeRules } from "./rules";
import type { MergeResolution, MergeResult } from "./types";

/** The history step a merge applied to an open document is (its undo is "Undo merge"). */
export const MERGE_HISTORY_NAME = "merge";

/**
 * Applies a merge to the open document it was made for — `ours` is that document's state — with
 * the user's `choices`, as one undoable step (`IDocument.replaceContent`): views, cameras and
 * unchanged nodes stay, and one undo restores the pre-merge state. Done before the merged version
 * is pushed (CLOUD-13).
 */
export function applyMergeToDocument(
    document: IDocument,
    result: MergeResult,
    choices: readonly MergeResolution[] = [],
    rules: MergeRuleRegistry = MergeRules,
): Result<void, MergeError | { kind: "document"; error: DocumentFormatError }> {
    const merged = applyResolutions(result, choices, rules);
    if (!merged.isOk) return Result.err(merged.error);
    const replaced = document.replaceContent(merged.value, MERGE_HISTORY_NAME);
    return replaced.isOk ? Result.ok(undefined) : Result.err({ kind: "document", error: replaced.error });
}
