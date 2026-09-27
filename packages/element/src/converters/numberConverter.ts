// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IConverter, Result } from "@spicy3d/core";

export class NumberConverter implements IConverter<number> {
    convert(value: number): Result<string> {
        return Number.isNaN(value) ? Result.err("Number is NaN") : Result.ok(String(value));
    }

    convertBack(value: string): Result<number> {
        const n = Number(value);
        return Number.isNaN(n) ? Result.err(`${value} can not convert to number`) : Result.ok(n);
    }
}
