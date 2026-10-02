// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, LENGTH_UNITS, type ParameterValue, property, resolveUnitSpec } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { SketchGeometryCommand } from "./sketchGeometryCommand";

@command({ key: "sketch.offset", icon: "icon-offset", helpText: "tooltip.sketch.offset" })
export class SketchOffsetCommand extends SketchGeometryCommand {
    protected readonly operation = "offset";

    @property("sketch.offsetDistance", { unit: LENGTH_UNITS })
    get distance(): ParameterValue {
        return this.getPrivateValue("distance", 1);
    }
    set distance(value: ParameterValue) {
        if (typeof value === "string" ? value.trim() !== "" : Number.isFinite(value) && value > 0)
            this.setProperty("distance", value);
    }

    private static rememberedAssociative = false;

    @property("sketch.offsetAssociative")
    get associative(): boolean {
        return this.getPrivateValue("associative", SketchOffsetCommand.rememberedAssociative);
    }
    set associative(value: boolean) {
        SketchOffsetCommand.rememberedAssociative = value;
        this.setProperty("associative", value);
    }

    protected override get associativeOffset(): boolean {
        return this.associative;
    }

    protected override offsetValue(editor: SketchEditor, side: number): ParameterValue {
        const resolved = resolveUnitSpec(
            this.distance,
            editor.document.variables.evaluate().scope,
            LENGTH_UNITS,
        );
        if (!resolved.isOk) throw new Error(resolved.error);
        if (!(resolved.value > 0)) throw new Error("Offset distance must be positive");
        return typeof this.distance === "string" && this.associative
            ? side < 0
                ? `-(${this.distance})`
                : this.distance
            : side * resolved.value;
    }
}
