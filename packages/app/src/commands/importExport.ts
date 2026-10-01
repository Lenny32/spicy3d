// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Annotation,
    AsyncController,
    CancelableCommand,
    Combobox,
    ConstructionNode,
    command,
    type DataExportOptions,
    documentLengthUnit,
    download,
    exportLengthUnit,
    I18n,
    type IApplication,
    type ICommand,
    LENGTH_UNIT_LABELS,
    LENGTH_UNITS_LIST,
    type LengthUnit,
    PropertyUtils,
    PubSub,
    property,
    Result,
    readFilesAsync,
    Transaction,
    VisualNode,
    validateStlTessellation,
} from "@spicy3d/core";
import { importFiles } from "../utils";

@command({
    key: "file.import",
    icon: "icon-import",
})
export class Import implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const extenstions = application.dataExchange.importFormats().join(",");
        const files = await readFilesAsync(extenstions, true);
        if (!files.isOk || files.value.length === 0) {
            alert(files.error);
            return;
        }
        importFiles(application, files.value);
    }
}

@command({ key: "file.importReferenceMesh", icon: "icon-import" })
export class ImportReferenceMesh implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const importer = application.dataExchange.importReferenceMesh;
        if (!importer) return;
        const files = await readFilesAsync(
            application.dataExchange.referenceMeshFormats?.().join(",") ?? ".stl",
            true,
        );
        if (!files.isOk || files.value.length === 0) return;
        const document = application.activeView?.document ?? (await application.newDocument("Untitled"));
        await Transaction.executeAsync(document, "import reference mesh", async () => {
            for (const file of files.value) {
                const result = await importer.call(application.dataExchange, document, file);
                if (!result.isOk) PubSub.default.pub("showToast", "error.default:{0}", result.error);
            }
        });
        application.activeView?.cameraController.fitContent();
    }
}

@command({
    key: "file.export",
    icon: "icon-export",
})
export class Export extends CancelableCommand {
    @property("file.format", {
        combobox: new Combobox<string>(),
    })
    public get format() {
        return this.getPrivateValue("format", ".step");
    }
    public set format(value: string) {
        this.setProperty("format", value, () => {
            this.emitUnitChanged();
            this.emitPropertyChanged("isStl", this.isStl);
        });
    }

    public get isStl(): boolean {
        return this.format === ".stl" || this.format === ".stl binary";
    }

    @property("file.stl.customTessellation", { dependencies: [{ property: "isStl", value: true }] })
    public get customTessellation(): boolean {
        return this.getPrivateValue("customTessellation", false);
    }
    public set customTessellation(value: boolean) {
        this.setProperty("customTessellation", value);
    }

    @property("file.stl.linearTolerance", {
        quantity: "length",
        dependencies: [
            { property: "isStl", value: true },
            { property: "customTessellation", value: true },
        ],
    })
    public get linearTolerance(): number {
        return this.getPrivateValue("linearTolerance", 0.1);
    }
    public set linearTolerance(value: number) {
        this.setProperty("linearTolerance", value);
    }

    @property("file.stl.angularTolerance", {
        dependencies: [
            { property: "isStl", value: true },
            { property: "customTessellation", value: true },
        ],
    })
    public get angularTolerance(): number {
        return this.getPrivateValue("angularTolerance", 10);
    }
    public set angularTolerance(value: number) {
        this.setProperty("angularTolerance", value);
    }

    private get exportOptions(): DataExportOptions {
        return {
            lengthUnit: this.outputUnit,
            ...(this.isStl &&
                this.customTessellation && {
                    stl: { linearTolerance: this.linearTolerance, angularTolerance: this.angularTolerance },
                }),
        };
    }

    /**
     * The unit the file is written in. It starts at the project unit on every export — the
     * command's cached options must not carry one project's override into the next — so the
     * choice lives in a plain field rather than the cached private value.
     */
    @property("file.outputUnit", {
        combobox: Combobox.from<LengthUnit>([...LENGTH_UNITS_LIST], {
            convert: (unit: LengthUnit) => Result.ok(I18n.translate(LENGTH_UNIT_LABELS[unit]) ?? unit),
        }),
        dependencies: [{ property: "hasFixedUnit", value: false }],
    })
    public get outputUnit(): LengthUnit {
        // The global app, like the constructor: the dialog reads this before execute assigns one.
        const projectUnit = documentLengthUnit(app.activeView?.document);
        return exportLengthUnit(this.unitHandling, this.unitOverride ?? projectUnit);
    }
    public set outputUnit(value: LengthUnit) {
        const old = this.outputUnit;
        this.unitOverride = value;
        if (old !== value) this.emitUnitChanged();
    }
    private unitOverride: LengthUnit | undefined;

    /** Read by the unit picker's visibility: a fixed-unit format offers no choice. */
    public get hasFixedUnit(): boolean {
        return this.unitHandling.kind === "fixed";
    }

    /** What the file will hold, in words: which unit, and whether the importer must be told it. */
    @property("file.unitInfo", { type: "info" })
    public get unitInfo(): string {
        const format = this.suffix.slice(1).toUpperCase();
        const unit = this.outputUnit;
        const key =
            this.unitHandling.kind === "embedded"
                ? "file.unitInfo.embedded{0}{1}"
                : this.unitHandling.kind === "fixed"
                  ? "file.unitInfo.fixed{0}{1}"
                  : "file.unitInfo.none{0}{1}";
        return I18n.translate(key, format, unit) ?? "";
    }

    private get unitHandling() {
        return app.dataExchange.exportUnitHandling?.(this.format) ?? { kind: "none" as const };
    }

    private emitUnitChanged() {
        this.emitPropertyChanged("outputUnit", this.outputUnit);
        this.emitPropertyChanged("hasFixedUnit", this.hasFixedUnit);
        this.emitPropertyChanged("unitInfo", this.unitInfo);
    }

    @property("option.command.merge")
    public get merge() {
        return this.getPrivateValue("merge", true);
    }
    public set merge(value: boolean) {
        this.setProperty("merge", value);
    }

    constructor() {
        super();
        const property = PropertyUtils.getProperty(Export.prototype, "format")!;
        property.combobox!.items.clear();
        // In the constructor, this.application has not been assigned yet, so use the global app.
        property.combobox!.items.push(...app.dataExchange.exportFormats());
    }

    @property("common.confirm")
    public confirm() {
        this.controller?.success();
    }

    protected async executeAsync() {
        const error = validateStlTessellation(this.exportOptions.stl);
        if (error) {
            PubSub.default.pub("showToast", "error.default:{0}", error);
            return;
        }
        const nodes = await this.selectNodesAsync();
        if (this.checkCanceled()) return;
        if (!nodes || nodes.length === 0) {
            PubSub.default.pub("showToast", "error.export.noNodeCanBeExported");
            return;
        }

        // Keep the options panel open even when no interactive model pick is needed.
        const controller = new AsyncController();
        this.controller = controller;
        const confirmed = await new Promise<boolean>((resolve) => {
            controller.onCompleted(() => resolve(true));
            controller.onCancelled(() => resolve(false));
        });
        if (!confirmed || this.checkCanceled()) return;

        PubSub.default.pub(
            "showPermanent",
            async () => {
                PubSub.default.pub("showToast", "toast.downloading");
                if (this.merge || nodes.length === 1) {
                    await this.exportMergedAsync(nodes);
                } else {
                    await this.exportAsZipAsync(nodes);
                }
            },
            "toast.executing{0}",
            I18n.translate("command.file.export"),
        );
    }

    private get suffix() {
        // ".stl binary" and ".ply binary" share the plain file extension.
        if (this.format === ".stl binary") return ".stl";
        if (this.format === ".ply binary") return ".ply";
        return this.format;
    }

    private async exportMergedAsync(nodes: VisualNode[]) {
        const data = await this.application.dataExchange.export(this.format, nodes, this.exportOptions);
        if (!data) return;
        download(data, `${this.fileBaseName ?? nodes[0].name}${this.suffix}`);
    }

    // Browsers block multiple automatic downloads, so pack the files into one zip.
    private async exportAsZipAsync(nodes: VisualNode[]) {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        const usedNames = new Set<string>();

        for (const node of nodes) {
            const data = await this.application.dataExchange.export(this.format, [node], this.exportOptions);
            if (!data) continue;
            zip.file(this.uniqueFileName(node.name, usedNames), new Blob(data));
        }

        download([await zip.generateAsync({ type: "blob" })], `${this.fileBaseName ?? nodes[0].name}.zip`);
    }

    private uniqueFileName(nodeName: string, usedNames: Set<string>) {
        let fileName = `${nodeName}${this.suffix}`;
        let counter = 1;
        while (usedNames.has(fileName)) {
            fileName = `${nodeName}-${counter++}${this.suffix}`;
        }
        usedNames.add(fileName);
        return fileName;
    }

    /** Set when the whole model is exported: the files are named after the document. */
    private fileBaseName: string | undefined;

    /**
     * The selected models, or — with nothing selected — every visible model of the document, so an
     * export without a selection writes the full model. Construction geometry and annotations are
     * references, not part of the model, and stay out.
     */
    private async selectNodesAsync(): Promise<VisualNode[] | undefined> {
        const document = this.application.activeView?.document;
        if (!document) return undefined;
        const selected = document.selection.getSelectedVisualNodes();
        if (selected.length > 0) return selected;

        this.fileBaseName = document.name;
        return document.modelManager
            .findNodes()
            .filter(
                (x): x is VisualNode =>
                    x instanceof VisualNode &&
                    !(x instanceof ConstructionNode) &&
                    !(x instanceof Annotation) &&
                    x.visible &&
                    x.parentVisible,
            );
    }
}
