// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentSource,
    EditSessions,
    I18n,
    type IApplication,
    type IDocument,
    Id,
    type IMergeEvaluator,
    Logger,
    type MergeConflict,
    MergeEvaluators,
    type MergeResolution,
    type MergeResult,
    mergeDocuments,
    nodeOfMergePath,
    type ResolutionChoice,
    Result,
    type RevealedTarget,
    revealMergePath,
    type Serialized,
    validateMerge,
} from "@spicy3d/core";
import type { CloudDocumentRepository } from "../documents/repository";
import type { SyncConflict, SyncEngine } from "../sync/syncEngine";
import { conflictDescription, theirsName } from "./conflictText";
import { MergePreviewRepository } from "./mergePreview";
import { downloadMergeReport, type MergeReport, mergeReport } from "./mergeReport";
import { keepMineChoice, reapplyResolutions, takeTheirsChoice } from "./resolutions";

/** How the rebuild of the merge with the current choices stands. */
export type ValidationState =
    /** Not rebuilt with the current choices yet. */
    | "stale"
    | "running"
    /** Rebuilt with the current choices: `rebuildFailures` is up to date. */
    | "done"
    /** The rebuild could not run (the error is logged): the merge goes unvalidated, as the sync does. */
    | "failed";

/** One conflict of the panel, with the user's choice so far. */
export interface ConflictRow {
    conflict: MergeConflict;
    choice?: ResolutionChoice;
    /** A `rebuild-failure` of the validation pass (only `accept`, or fix it and re-validate). */
    rebuild: boolean;
}

export type FinishError =
    /** Conflicts without a choice (`count`). */
    | { kind: "unresolved"; count: number }
    /** Rebuild failures not accepted. */
    | { kind: "rebuild"; count: number }
    /** The head moved, or the merge changed, meanwhile: the panel shows it, to check and finish again. */
    | { kind: "changed" }
    /** A command runs: nothing is replaced under it. */
    | { kind: "busy" }
    | { kind: "failed"; message: string };

export interface ConflictResolutionOptions {
    app: IApplication;
    engine: SyncEngine;
    repository: CloudDocumentRepository;
    /** The open cloud document in conflict. */
    document: IDocument;
    /** Rebuilds the merge (default: the sync's, else the app's registered evaluator). */
    evaluator?: IMergeEvaluator;
    /** The preview is refreshed this long after the last choice (default 300 ms). */
    previewDelayMs?: number;
    /** Opens the preview document (default `app.loadDocument`). */
    loadPreview?: (data: Serialized, source: DocumentSource) => Promise<IDocument | undefined>;
}

const PREVIEW_HISTORY_NAME = "merge preview";

/**
 * The resolution of one document's merge conflicts (CLOUD-13), behind the conflict panel.
 *
 * The user's local state is never touched until the merge is finished: choices are kept by merge
 * path and reapplied to the sync's merge (`reapplyResolutions`, in rounds, so a conflict a choice
 * creates is answered too), and the **live preview** is a *separate*, read-only document
 * ({@link MergePreviewRepository}, a fresh id) whose content is replaced with the merge of the
 * current choices, debounced — never the open document itself, whose content is this device's
 * side of the merge (a crash or a closed tab while resolving loses nothing), and which the sync
 * merges from again when it finishes.
 *
 * While it lives, the document's sync and autosave are held (`SyncEngine.hold`); a newer head
 * still re-merges (the engine keeps pulling in `conflict`), and the choices are reapplied to it by
 * path — those whose path is gone are dropped with a note. Finishing re-merges with the document
 * as it is now (edits made meanwhile count), rebuilds the result (`validateMerge`: rebuild failures
 * need an explicit `accept`, or a fix and "Re-validate"), then `SyncEngine.resolve` applies it as
 * one undo step and pushes the `merge` version.
 */
export class ConflictResolution {
    private source: MergeResult;
    /** The engine's last result (a new one = the engine merged again: a newer head). */
    private engineResult: MergeResult;
    private current: MergeResult;
    private readonly choices = new Map<string, ResolutionChoice>();
    /** Rows in the order they were first listed (a choice never makes rows jump). */
    private readonly order = new Map<string, number>();
    private rebuildFailures: MergeConflict[] = [];
    /** `JSON` of the merged document the failures are for (`undefined`: never validated). */
    private validatedFor?: string;
    private validationFailed = false;
    private validating?: Promise<void>;
    /** The merge `validating` is for. */
    private validatingKey?: string;
    private dropped: MergeResolution[] = [];
    private readonly notesList: string[] = [];
    private preview?: IDocument;
    private previewTimer?: ReturnType<typeof setTimeout>;
    private readonly release: () => void;
    private readonly unsubscribe: () => void;
    private disposed = false;
    private resolvedElsewhere = false;
    /** Told after every change of state (never from a render: no render → change → render loop). */
    onChanged?: () => void;

    private constructor(
        readonly options: ConflictResolutionOptions,
        private conflict: SyncConflict,
        result: MergeResult,
    ) {
        this.source = this.structural(result);
        this.engineResult = result;
        this.current = this.source;
        this.takeRebuildFailures(result);
        this.remember();
        this.release = options.engine.hold(this.docId);
        this.unsubscribe = options.engine.onChanged((id) => {
            if (id === this.docId) this.onEngineChanged();
        });
    }

    /** The resolution of `document`'s conflict, or `undefined` when there is no merge to resolve. */
    static open(options: ConflictResolutionOptions): ConflictResolution | undefined {
        const conflict = options.engine.syncConflictOf(options.document.id);
        if (!conflict?.result) return undefined;
        return new ConflictResolution(options, conflict, conflict.result);
    }

    get docId(): string {
        return this.options.document.id;
    }

    get document(): IDocument {
        return this.options.document;
    }

    get sides(): Pick<SyncConflict, "base" | "ours" | "theirs"> {
        return this.conflict;
    }

    /** "Undo merge" put the document here: there may be nothing to choose, only to merge again. */
    get undone(): boolean {
        return this.conflict.undone === true;
    }

    /** The merge with the current choices. */
    get result(): MergeResult {
        return this.current;
    }

    get notes(): readonly string[] {
        return this.notesList;
    }

    get isDisposed(): boolean {
        return this.disposed;
    }

    /** The conflict went away without this panel (another tab, "Open latest"…). */
    get isResolvedElsewhere(): boolean {
        return this.resolvedElsewhere;
    }

    get previewDocument(): IDocument | undefined {
        return this.preview;
    }

    get validation(): ValidationState {
        if (this.validating) return "running";
        if (this.validatedFor !== this.mergedKey()) return "stale";
        return this.validationFailed ? "failed" : "done";
    }

    /** Every conflict: the structural ones, then the rebuild failures of the last validation. */
    get rows(): ConflictRow[] {
        const structural = [...this.current.conflicts, ...this.current.resolved]
            .filter((c) => c.kind !== "rebuild-failure")
            .sort((a, b) => (this.order.get(a.path) ?? 0) - (this.order.get(b.path) ?? 0))
            .map((conflict) => this.row(conflict, false));
        return [...structural, ...this.rebuildFailures.map((conflict) => this.row(conflict, true))];
    }

    private row(conflict: MergeConflict, rebuild: boolean): ConflictRow {
        const choice = this.choices.get(conflict.path);
        return choice === undefined ? { conflict, rebuild } : { conflict, choice, rebuild };
    }

    /** Conflicts still without a choice (rebuild failures only once validated). */
    get unresolvedCount(): number {
        return this.rows.filter((r) => r.choice === undefined).length;
    }

    /** Whether "Finish" can push now: everything chosen, and the rebuild of exactly this merge done. */
    get canFinish(): boolean {
        const validation = this.validation;
        return this.unresolvedCount === 0 && (validation === "done" || validation === "failed");
    }

    // ---- Choices -----------------------------------------------------------------------------

    choose(path: string, choice: ResolutionChoice): void {
        const row = this.rows.find((r) => r.conflict.path === path);
        if (!row?.conflict.choices.includes(choice)) return;
        this.choices.set(path, choice);
        // Accepting a rebuild failure changes nothing in the merge; any other choice does.
        if (!row.rebuild) this.recompute();
        this.changed();
    }

    /** "Keep all from this device" / "Take all from <other>": every structural conflict, new ones too. */
    chooseAll(side: "ours" | "theirs"): void {
        const pick = side === "ours" ? keepMineChoice : takeTheirsChoice;
        // A choice can create a conflict (a dangling reference): answered in the next round.
        for (let round = 0; round < 10; round++) {
            const open = this.rows.filter(
                (r) => !r.rebuild && this.choices.get(r.conflict.path) !== pick(r.conflict.choices),
            );
            if (open.length === 0) break;
            for (const row of open) this.choices.set(row.conflict.path, pick(row.conflict.choices));
            this.recompute();
        }
        this.changed();
    }

    private recompute() {
        const structuralChoices = [...this.choices]
            .filter(([path]) => !this.rebuildFailures.some((f) => f.path === path))
            .map(([path, choice]) => ({ path, choice }));
        const reapplied = reapplyResolutions(this.source, structuralChoices);
        if (!reapplied.isOk) {
            Logger.warn(`[cloud] conflict choices could not be applied: ${reapplied.error.kind}`);
            return;
        }
        const before = new Map(this.rows.map((r) => [r.conflict.path, r.conflict]));
        this.current = reapplied.value.result;
        this.forget(reapplied.value.dropped, before);
        this.remember();
        this.schedulePreview();
    }

    /** Choices a re-merge no longer has a conflict for: dropped, with a note. */
    private forget(dropped: readonly MergeResolution[], before: ReadonlyMap<string, MergeConflict>) {
        if (dropped.length === 0) return;
        for (const { path } of dropped) {
            this.choices.delete(path);
            const conflict = before.get(path);
            this.notesList.push(
                I18n.translate("cloud.merge.dropped{0}", conflict ? conflictDescription(conflict) : path),
            );
        }
        this.dropped.push(...dropped);
    }

    private remember() {
        for (const conflict of [...this.current.conflicts, ...this.current.resolved]) {
            if (!this.order.has(conflict.path)) this.order.set(conflict.path, this.order.size);
        }
    }

    // ---- Re-merges ---------------------------------------------------------------------------

    /** The merge without its rebuild failures (they are the validation's, kept apart). */
    private structural(result: MergeResult): MergeResult {
        return { ...result, conflicts: result.conflicts.filter((c) => c.kind !== "rebuild-failure") };
    }

    /** The engine's own validation (a clean merge that failed to rebuild) counts as done for its merge. */
    private takeRebuildFailures(result: MergeResult) {
        const failures = result.conflicts.filter((c) => c.kind === "rebuild-failure");
        if (failures.length === 0) return;
        this.rebuildFailures = failures;
        this.validatedFor = JSON.stringify(this.structural(result).merged);
        this.validationFailed = false;
    }

    private readonly onEngineChanged = () => {
        if (this.disposed) return;
        const conflict = this.options.engine.syncConflictOf(this.docId);
        if (!conflict) {
            this.resolvedElsewhere = true;
            this.changed();
            return;
        }
        const previousHead = this.conflict.theirs.versionId;
        this.conflict = conflict;
        // Still in conflict without a merge (a re-merge that could not load the base): the last
        // merge stays on screen.
        if (!conflict.result || conflict.result === this.engineResult) {
            this.changed();
            return;
        }
        this.engineResult = conflict.result;
        this.rebase(conflict.result);
        if (conflict.theirs.versionId !== previousHead) {
            this.notesList.push(I18n.translate("cloud.merge.remoteUpdated{0}", theirsName(conflict.theirs)));
        }
        this.changed();
    };

    /** A new merge (a newer head, the document edited): the choices reapplied to it by path. */
    private rebase(result: MergeResult) {
        this.source = this.structural(result);
        const failures = result.conflicts.filter((c) => c.kind === "rebuild-failure");
        if (failures.length > 0) this.takeRebuildFailures(result);
        this.recompute();
    }

    /**
     * The merge again, with the document as it is now (after the user fixed a failing feature, or
     * edited meanwhile) — then rebuilt ("Re-validate").
     */
    remergeFromDocument(): Result<void, { kind: "failed"; message: string }> {
        const { base, theirs } = this.source.inputs;
        const merged = mergeDocuments(base, this.document.serialize(), theirs);
        if (!merged.isOk) return Result.err({ kind: "failed", message: merged.error.kind });
        this.rebase(merged.value);
        this.changed();
        return Result.ok(undefined);
    }

    // ---- Validation --------------------------------------------------------------------------

    private keyOf?: { merged: Serialized; key: string };

    /** The merged document as text (what a validation is for), computed once per merge. */
    private mergedKey(): string {
        if (this.keyOf?.merged !== this.current.merged) {
            this.keyOf = { merged: this.current.merged, key: JSON.stringify(this.current.merged) };
        }
        return this.keyOf.key;
    }

    /** Rebuilds the merge with the current choices; its failures become rows to accept (or fix). */
    validate(): Promise<void> {
        const key = this.mergedKey();
        if (this.validating && this.validatingKey === key) return this.validating;
        // One for an older merge still running: this one follows it (its answer is for the old key).
        const result = this.current;
        const previous = this.validating ?? Promise.resolve();
        this.validatingKey = key;
        const validating = previous
            .then(() => this.runValidation(result, key))
            .finally(() => {
                if (this.validating === validating) this.validating = undefined;
                this.changed();
            });
        this.validating = validating;
        this.changed();
        return validating;
    }

    private async runValidation(result: MergeResult, key: string): Promise<void> {
        const evaluator =
            this.options.evaluator ?? this.options.engine.options.evaluator ?? MergeEvaluators.current;
        if (!evaluator) {
            // As the sync does: without an evaluator (tests, no kernel) the merge goes unvalidated.
            Logger.info("[cloud] no merge evaluator: the resolved merge is pushed unvalidated");
            this.setValidation(key, [], false);
            return;
        }
        const validated = await validateMerge(result, { evaluator });
        if (this.disposed) return;
        if (!validated.isOk) {
            Logger.warn(`[cloud] merge validation failed: ${validated.error.kind}`);
            this.setValidation(key, [], true);
            return;
        }
        this.setValidation(
            key,
            validated.value.conflicts.filter((c) => c.kind === "rebuild-failure"),
            false,
        );
    }

    private setValidation(key: string, failures: MergeConflict[], failed: boolean) {
        // Accepting a failure is kept while the same failure is reported again.
        const known = new Set(failures.map((f) => f.path));
        for (const old of this.rebuildFailures) {
            if (!known.has(old.path)) this.choices.delete(old.path);
        }
        this.rebuildFailures = failures;
        this.validatedFor = key;
        this.validationFailed = failed;
    }

    // ---- Finish ------------------------------------------------------------------------------

    /**
     * Pushes the merge: re-merged with the document as it is now, rebuilt if not yet, then
     * `SyncEngine.resolve` (one undo step, a `merge` version). Refused while anything is
     * unanswered; a head that moved meanwhile with new conflicts shows them (`changed`).
     */
    async finish(): Promise<Result<void, FinishError>> {
        const dropped = this.dropped.length;
        const remerged = this.remergeFromDocument();
        if (!remerged.isOk) return Result.err(remerged.error);
        // A choice no longer applies (edited meanwhile): the user sees the note first.
        if (this.dropped.length > dropped) return Result.err({ kind: "changed" });
        const structuralOpen = () => this.rows.filter((r) => !r.rebuild && r.choice === undefined).length;
        if (structuralOpen() > 0) return Result.err({ kind: "unresolved", count: structuralOpen() });
        const key = this.mergedKey();
        if (this.validation !== "done" && this.validation !== "failed") await this.validate();
        if (this.disposed) return Result.err({ kind: "failed", message: "closed" });
        // A newer head, a choice or an edit while it rebuilt: that merge was not the one validated.
        const validation = this.validation;
        if (this.mergedKey() !== key || (validation !== "done" && validation !== "failed")) {
            return Result.err({ kind: "changed" });
        }
        if (structuralOpen() > 0) return Result.err({ kind: "unresolved", count: structuralOpen() });
        const failures = this.rows.filter((r) => r.rebuild && r.choice === undefined).length;
        if (failures > 0) return Result.err({ kind: "rebuild", count: failures });
        const choices = [...this.choices].map(([path, choice]) => ({ path, choice }));
        // The engine pushes exactly this merge, against this head — anything else comes back `changed`.
        const resolved = await this.options.engine.resolve(this.docId, choices, {
            headVersionId: this.conflict.theirs.versionId,
            merged: key,
        });
        if (resolved.isOk) {
            this.dispose();
            return Result.ok(undefined);
        }
        if (resolved.error.kind === "unresolved" || resolved.error.kind === "changed") {
            return Result.err({ kind: "changed" });
        }
        if (resolved.error.kind === "busy") return Result.err({ kind: "busy" });
        if (resolved.error.kind === "notInConflict") {
            this.resolvedElsewhere = true;
            this.changed();
            return Result.err({ kind: "failed", message: "notInConflict" });
        }
        return Result.err({ kind: "failed", message: resolved.error.message });
    }

    // ---- Selection ---------------------------------------------------------------------------

    /** The document a selection shows in: the preview while it is the one on screen, else mine. */
    private shownDocument(): IDocument {
        const active = this.options.app.activeView?.document;
        return this.preview && active === this.preview ? this.preview : this.document;
    }

    private activate(document: IDocument) {
        const app = this.options.app;
        if (app.activeView?.document === document) return;
        const view = app.views.find((x) => x.document === document);
        if (view) app.activeView = view;
    }

    /** Selects what a conflict is about (highlight, timeline, sketch entity) where it is shown. */
    reveal(conflict: Pick<MergeConflict, "path">): RevealedTarget | undefined {
        const target = this.shownDocument();
        this.activate(target);
        return revealMergePath(target, conflict.path);
    }

    /**
     * "Open failing feature": in this device's document when it has the node (the user fixes it
     * there, then re-validates), else in the preview (the merge brought it).
     */
    async openFailing(conflict: MergeConflict): Promise<RevealedTarget | undefined> {
        let target: IDocument | undefined = this.document;
        if (!nodeOfMergePath(this.document, conflict.path)) {
            target = this.preview ?? (await this.showPreview());
        }
        if (!target) return undefined;
        this.activate(target);
        return revealMergePath(target, conflict.path);
    }

    // ---- Preview -----------------------------------------------------------------------------

    private previewData(): Serialized {
        const name = I18n.translate("cloud.merge.previewName{0}", this.document.name);
        return { ...this.current.merged, id: this.preview?.id ?? Id.generate(), name };
    }

    /** Opens the live preview of the merge with the current choices (a separate, read-only document). */
    async showPreview(): Promise<IDocument | undefined> {
        if (this.preview) {
            this.activate(this.preview);
            return this.preview;
        }
        const load =
            this.options.loadPreview ??
            ((data: Serialized, source: DocumentSource) => this.options.app.loadDocument(data, source));
        const document = await load(this.previewData(), {
            repository: new MergePreviewRepository(this.docId),
        });
        if (!document) return undefined;
        if (this.disposed || this.preview) {
            await document.close({ discardChanges: true });
            return this.preview;
        }
        this.preview = document;
        this.changed();
        return document;
    }

    /** Closes the preview and shows this device's document again. */
    async closePreview(): Promise<void> {
        clearTimeout(this.previewTimer);
        this.previewTimer = undefined;
        const preview = this.preview;
        this.preview = undefined;
        if (preview && this.options.app.documents.has(preview)) await preview.close({ discardChanges: true });
        if (this.options.app.documents.has(this.document)) this.activate(this.document);
        if (preview) this.changed();
    }

    /** The preview follows the choices, debounced (a rebuild per burst of clicks). */
    private schedulePreview() {
        if (!this.preview) return;
        clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => this.refreshPreview(), this.options.previewDelayMs ?? 300);
    }

    /** Applies the current merge to the preview now (the debounce's end). */
    refreshPreview(): void {
        clearTimeout(this.previewTimer);
        this.previewTimer = undefined;
        const preview = this.preview;
        if (!preview || this.disposed) return;
        if (!this.options.app.documents.has(preview)) {
            this.preview = undefined;
            this.changed();
            return;
        }
        // A sketch opened in the preview (a revealed entity) closes before its nodes are replaced.
        EditSessions.endAll(preview);
        const replaced = preview.replaceContent(this.previewData(), PREVIEW_HISTORY_NAME);
        if (!replaced.isOk) Logger.warn(`[cloud] merge preview not updated: ${replaced.error.kind}`);
    }

    /** The preview was closed from elsewhere (its tab closed). */
    documentClosed(document: IDocument): void {
        if (document !== this.preview) return;
        this.preview = undefined;
        this.changed();
    }

    // ---- Report ------------------------------------------------------------------------------

    report(): MergeReport {
        return mergeReport(this.conflict, this.current, {
            rebuildFailures: this.rebuildFailures,
            dropped: this.dropped,
        });
    }

    exportReport(): void {
        downloadMergeReport(this.report(), this.document.name);
    }

    // ---- Lifecycle ---------------------------------------------------------------------------

    /** Lets the sync and autosave go on and closes the preview; the conflict stays unless finished. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe();
        this.release();
        void this.closePreview();
    }

    private changed() {
        if (!this.disposed) this.onChanged?.();
    }
}
