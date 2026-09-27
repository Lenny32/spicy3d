// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import type { I18nKeys } from "../i18n";

/**
 * A length unit the project can be displayed and edited in. Geometry is always stored in
 * millimetres — the unit only exists at the input, display and export boundaries, which is
 * what keeps a unit change from moving a single vertex.
 */
export type LengthUnit = "mm" | "cm" | "m" | "in";

export const DEFAULT_LENGTH_UNIT: LengthUnit = "mm";

/** Every supported unit, in the order a picker lists them. */
export const LENGTH_UNITS_LIST: readonly LengthUnit[] = ["mm", "cm", "m", "in"];

/** The picker label of each unit: the full name with its symbol, "Centimetres (cm)". */
export const LENGTH_UNIT_LABELS: Readonly<Record<LengthUnit, I18nKeys>> = {
    mm: "unit.length.mm",
    cm: "unit.length.cm",
    m: "unit.length.m",
    in: "unit.length.in",
};

/** Millimetres per unit. Exact for every entry: the inch is defined as 25.4 mm. */
const MILLIMETRES_PER_UNIT: Readonly<Record<LengthUnit, number>> = {
    mm: 1,
    cm: 10,
    m: 1000,
    in: 25.4,
};

/**
 * Fraction digits a read-only label shows. Coarser units need more digits to keep the same
 * physical resolution: 0.01 mm is 0.001 cm, and 0.0001 m keeps a tenth of a millimetre.
 */
const LABEL_DECIMALS: Readonly<Record<LengthUnit, number>> = {
    mm: 2,
    cm: 3,
    m: 4,
    in: 3,
};

/**
 * Fraction digits an editor shows. Enough that a value converted for display and typed back
 * unchanged lands within a nanometre of where it started — editors also skip the write when
 * the text did not change, so an untouched field never round-trips at all.
 */
const EDITOR_DECIMALS: Readonly<Record<LengthUnit, number>> = {
    mm: 6,
    cm: 7,
    m: 9,
    in: 8,
};

export function isLengthUnit(value: unknown): value is LengthUnit {
    return typeof value === "string" && Object.hasOwn(MILLIMETRES_PER_UNIT, value);
}

/** Millimetres in one `unit`. */
export function lengthUnitFactor(unit: LengthUnit): number {
    return MILLIMETRES_PER_UNIT[unit];
}

/** A value typed in `unit`, as the millimetres it is stored in. */
export function toMillimetres(value: number, unit: LengthUnit): number {
    return unit === "mm" ? value : value * MILLIMETRES_PER_UNIT[unit];
}

/** A stored millimetre value, as it reads in `unit`. */
export function fromMillimetres(millimetres: number, unit: LengthUnit): number {
    return unit === "mm" ? millimetres : millimetres / MILLIMETRES_PER_UNIT[unit];
}

export interface LengthFormatOptions {
    /** Fraction digits; defaults to the unit's label precision. */
    decimals?: number;
    /** Append the unit symbol (`12.5 cm`). Off by default: most labels sit beside a unit header. */
    suffix?: boolean;
}

/**
 * A millimetre value as a read-only label in `unit`: fixed digits, so a column of values
 * lines up (`100.00` in mm, `10.000` in cm).
 */
export function formatLength(millimetres: number, unit: LengthUnit, options?: LengthFormatOptions): string {
    const decimals = options?.decimals ?? LABEL_DECIMALS[unit];
    const text = fromMillimetres(millimetres, unit).toFixed(decimals);
    return options?.suffix ? `${text} ${unit}` : text;
}

const POWER_SUFFIX: Readonly<Record<1 | 2 | 3, string>> = { 1: "", 2: "²", 3: "³" };

/** The symbol of `unit` raised to a power: `cm`, `cm²`, `cm³`. */
export function lengthUnitSymbol(unit: LengthUnit, dimension: 1 | 2 | 3 = 1): string {
    return `${unit}${POWER_SUFFIX[dimension]}`;
}

/**
 * A measured length, area or volume (`dimension` 1, 2 or 3, stored in mm, mm², mm³) as a
 * label in `unit`: an area scales by the factor squared, a volume by the factor cubed.
 */
export function formatMeasure(
    value: number,
    dimension: 1 | 2 | 3,
    unit: LengthUnit,
    options?: LengthFormatOptions,
): string {
    const decimals = options?.decimals ?? LABEL_DECIMALS[unit];
    const text = (value / MILLIMETRES_PER_UNIT[unit] ** dimension).toFixed(decimals);
    return options?.suffix ? `${text} ${lengthUnitSymbol(unit, dimension)}` : text;
}

/**
 * A millimetre value as an editor shows it: rounded to the editor precision, trailing zeros
 * dropped (`10`, not `10.0000000`), so the field reads like what the user would type.
 */
export function formatLengthForEditing(millimetres: number, unit: LengthUnit): string {
    const value = fromMillimetres(millimetres, unit);
    return String(Number(value.toFixed(EDITOR_DECIMALS[unit])));
}

// Each run of digits has exactly one way to match: the integer part stops at the dot, and the
// fraction only starts after it. An ambiguous split (`\d+\.?\d*`) backtracks polynomially on
// long digit runs that then fail to match, e.g. "999…9!".
const LENGTH_LITERAL = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z]*)$/;

/**
 * A typed length as millimetres: a number in `unit` (`10` in a cm project is 100 mm), or a
 * number with an explicit unit that overrides it (`1 in`, `25.4mm`). Anything else — an
 * expression, an unknown unit — is an error; callers that accept expressions try those first.
 */
export function parseLength(text: string, unit: LengthUnit): Result<number> {
    const match = LENGTH_LITERAL.exec(text.trim());
    if (match === null) return Result.err(`${text} is not a length`);
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return Result.err(`${text} is not a length`);
    const suffix = match[2];
    if (suffix === "") return Result.ok(toMillimetres(value, unit));
    const explicit = suffix.toLowerCase();
    if (!isLengthUnit(explicit)) return Result.err(`Unknown length unit: ${suffix}`);
    return Result.ok(toMillimetres(value, explicit));
}
