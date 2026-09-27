// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    command,
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
    SelectNodeStep,
    type VisualNode,
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
        this.setProperty("format", value, () => this.emitUnitChanged());
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

    protected async executeAsync() {
        const nodes = await this.selectNodesAsync();
        if (!nodes || nodes.length === 0) {
            PubSub.default.pub("showToast", "toast.select.noSelected");
            return;
        }

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
            "toast.excuting{0}",
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
        const data = await this.application.dataExchange.export(this.format, nodes, {
            lengthUnit: this.outputUnit,
        });
        if (!data) return;
        download(data, `${nodes[0].name}${this.suffix}`);
    }

    // Browsers block multiple automatic downloads, so pack the files into one zip.
    private async exportAsZipAsync(nodes: VisualNode[]) {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        const usedNames = new Set<string>();

        for (const node of nodes) {
            const data = await this.application.dataExchange.export(this.format, [node], {
                lengthUnit: this.outputUnit,
            });
            if (!data) continue;
            zip.file(this.uniqueFileName(node.name, usedNames), new Blob(data));
        }

        download([await zip.generateAsync({ type: "blob" })], `${nodes[0].name}.zip`);
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

    private async selectNodesAsync() {
        this.controller = new AsyncController();
        const step = new SelectNodeStep("prompt.select.models", { multiple: true, keepSelection: true });
        const data = await step.execute(this.application.activeView?.document!, this.controller);
        if (!data?.nodes) {
            PubSub.default.pub("showToast", "prompt.select.noModelSelected");
            return undefined;
        }
        return data.nodes;
    }
}
