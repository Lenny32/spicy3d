// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IConverter, Result } from "@spicy3d/core";

export class UrlStringConverter implements IConverter<string> {
    convert(value: string): Result<string> {
        return Result.ok(`url('${value}')`);
    }
}
