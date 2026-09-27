// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { evaluateExpression, type ParameterValue, type Scope } from "../parameters/expression";
import { UNITLESS, unitSpecEquals } from "../parameters/unitSpec";
import { formatLengthForEditing, type LengthUnit, parseLength } from "./lengthUnit";

/**
 * A length parameter as its editor shows it: a stored literal (millimetres) converted to
 * `unit`, an expression exactly as written — its text is the user's intent, and any unit it
 * needs is spelled out inside it.
 */
export function formatLengthParameter(value: ParameterValue, unit: LengthUnit): string {
    return typeof value === "number" ? formatLengthForEditing(value, unit) : value;
}

/**
 * What a length editor stores for the text typed into it, read in the project `unit`:
 *
 * - a number, optionally with an explicit unit (`10`, `1 in`), becomes its millimetres;
 * - an expression that evaluates to a plain number (`20 / 2`) was typed in `unit` too, so
 *   the unit is written onto it — `(20 / 2) cm` — keeping its meaning fixed when the
 *   project unit later changes;
 * - an expression that already carries a length (`w * 2`, `w + 1 cm`) is kept verbatim.
 *
 * An expression that does not evaluate against `scope` is kept verbatim as well: whether it
 * is acceptable is the slot's decision (a feature reports it on its row), not this one's.
 */
export function lengthParameterFromInput(text: string, unit: LengthUnit, scope: Scope): ParameterValue {
    const literal = parseLength(text, unit);
    return literal.isOk ? literal.value : lengthExpressionFromInput(text, unit, scope);
}

/**
 * The expression-only counterpart, for slots that always store text (a document variable):
 * a plain number or unitless expression typed in `unit` gets that unit written onto it
 * (`10` → `10 cm`, `20 / 2` → `(20 / 2) cm`); millimetre projects and expressions that
 * already carry a length keep the text as typed.
 */
export function lengthExpressionFromInput(text: string, unit: LengthUnit, scope: Scope): string {
    const trimmed = text.trim();
    if (unit === "mm" || trimmed === "") return trimmed;
    const evaluated = evaluateExpression(trimmed, scope);
    if (!evaluated.isOk || !unitSpecEquals(evaluated.value.unit, UNITLESS)) return trimmed;
    return Number.isFinite(Number(trimmed)) ? `${trimmed} ${unit}` : `(${trimmed}) ${unit}`;
}
