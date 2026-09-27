// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IConverter } from "../foundation/converter";
import { Result } from "../foundation/result";
import { XYZ } from "../math";
import { formatLengthForEditing, type LengthUnit, parseLength } from "./lengthUnit";

/**
 * A millimetre number shown and typed in the project unit. The unit is read on every call
 * rather than captured, so a field keeps following the project when its unit changes.
 */
export class LengthConverter implements IConverter<number> {
    constructor(private readonly unit: () => LengthUnit) {}

    convert(value: number): Result<string> {
        if (typeof value !== "number" || Number.isNaN(value)) return Result.err("Number is NaN");
        return Result.ok(formatLengthForEditing(value, this.unit()));
    }

    convertBack(value: string): Result<number> {
        const parsed = parseLength(value, this.unit());
        return parsed.isOk ? parsed : Result.err(`${value} can not convert to number`);
    }
}

/** A millimetre point, `x,y,z`, shown and typed in the project unit. */
export class XYZLengthConverter implements IConverter<XYZ> {
    constructor(private readonly unit: () => LengthUnit) {}

    convert(value: XYZ): Result<string> {
        const unit = this.unit();
        return Result.ok([value.x, value.y, value.z].map((x) => formatLengthForEditing(x, unit)).join(","));
    }

    convertBack(value: string): Result<XYZ> {
        const unit = this.unit();
        const parts = value.split(",").map((x) => parseLength(x, unit));
        if (parts.length !== 3 || parts.some((x) => !x.isOk)) {
            return Result.err(`${value} convert to XYZ error`);
        }
        return Result.ok(XYZ.fromArray(parts.map((x) => x.value)));
    }
}
