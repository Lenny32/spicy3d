// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { AnalysisManager } from "./analysis";
import type { IApplication } from "./application";
import type {
    DocumentRepositoryError,
    History,
    IDisposable,
    IDocumentRepository,
    IPropertyChanged,
    ObservableCollection,
    Result,
    SaveKind,
    SaveOutcome,
} from "./foundation";
import type { ModelManager } from "./modelManager";
import type { IVariableTable } from "./parameters/variableTable";
import type { IPicker, ISelection } from "./selection";
import type { Serialized } from "./serialize";
import type { ProjectSettings } from "./units/projectSettings";
import type { Act, IVisual } from "./visual";

export const DOCUMENT_FILE_EXTENSION = ".spicy";
export const PLUGIN_FILE_EXTENSION = ".spicyplugin";

export interface IDocument extends IPropertyChanged, IDisposable {
    readonly analyses: AnalysisManager;
    readonly selection: ISelection;
    readonly picker: IPicker;
    readonly id: string;
    readonly history: History;
    readonly visual: IVisual;
    readonly application: IApplication;
    readonly modelManager: ModelManager;
    /** Document-wide parameters shared by every body and sketch (see `variableTable.ts`). */
    readonly variables: IVariableTable;
    /** Project properties (length unit, ...), shown under the Items tree's Project Properties row. */
    readonly settings: ProjectSettings;
    name: string;
    acts: ObservableCollection<Act>;
    userData?: Record<string, unknown>;
    /** Where the document is saved: the repository it was opened from (local for new ones). */
    repository: IDocumentRepository;
    /** The repository version the document was loaded from or last saved as (cloud only). */
    version?: string;
    /** Whether the undo position differs from the one of the last save (or of the opening). */
    readonly isDirty: boolean;
    /** Saves through `repository`; a successful save makes the document clean. */
    save(kind?: SaveKind): Promise<Result<SaveOutcome, DocumentRepositoryError>>;
    /**
     * Asks to save unsaved changes, then closes the document and its views. Resolves `false`
     * when the user cancels or the save fails (the document stays open).
     */
    close(): Promise<boolean>;
    serialize(): Serialized;
}
