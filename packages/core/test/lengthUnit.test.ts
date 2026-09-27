// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AngleSnapEventHandler,
    AsyncController,
    documentLengthUnit,
    evaluateExpression,
    formatLength,
    formatLengthForEditing,
    formatLengthParameter,
    formatMeasure,
    fromMillimetres,
    isLengthProperty,
    isLengthUnit,
    LENGTH_UNITS,
    LENGTH_UNITS_LIST,
    LengthConverter,
    lengthExpressionFromInput,
    lengthParameterFromInput,
    Plane,
    ProjectSettings,
    parseLength,
    resolveUnitSpec,
    SnapLengthAtAxisHandler,
    Transaction,
    toMillimetres,
    XYZ,
    XYZLengthConverter,
} from "../src";
import { TestDocument } from "../test-utils";

describe("length units", () => {
    test.each([
        ["mm", "100.00"],
        ["cm", "10.000"],
        ["m", "0.1000"],
        ["in", "3.937"],
    ] as const)("100 mm reads %s as %s", (unit, text) => {
        expect(formatLength(100, unit)).toBe(text);
    });

    test("a label can carry its unit symbol", () => {
        expect(formatLength(100, "cm", { suffix: true })).toBe("10.000 cm");
    });

    test("entering 1 in creates 25.4 mm, and 10 cm is 100 mm", () => {
        expect(parseLength("1", "in").value).toBeCloseTo(25.4, 12);
        expect(parseLength("10", "cm").value).toBe(100);
    });

    test("an explicit unit wins over the project unit", () => {
        expect(parseLength("1 in", "cm").value).toBeCloseTo(25.4, 12);
        expect(parseLength("25.4mm", "in").value).toBeCloseTo(25.4, 12);
        expect(parseLength("-2.5e1 CM", "mm").value).toBe(-250);
    });

    test.each(["", "abc", "1 ft", "1,2", "w * 2"])("%j is not a plain length", (text) => {
        expect(parseLength(text, "mm").isOk).toBe(false);
    });

    test("rejects a long digit run in linear time", () => {
        // CodeQL: an ambiguous digit split backtracked polynomially on "9" + "99"×n + a bad tail.
        const hostile = `9${"99".repeat(50_000)}!`;
        const start = performance.now();
        expect(parseLength(hostile, "mm").isOk).toBe(false);
        expect(performance.now() - start).toBeLessThan(500);
        expect(parseLength("12.", "mm").value).toBe(12);
        expect(parseLength(".5", "cm").value).toBe(5);
    });

    test("conversions round-trip every supported unit", () => {
        for (const unit of LENGTH_UNITS_LIST) {
            expect(toMillimetres(fromMillimetres(123.456, unit), unit)).toBeCloseTo(123.456, 10);
        }
        expect(isLengthUnit("in")).toBe(true);
        expect(isLengthUnit("ft")).toBe(false);
        expect(isLengthUnit("toString")).toBe(false);
    });

    test("areas and volumes scale by the factor squared and cubed", () => {
        expect(formatMeasure(100, 2, "cm", { suffix: true })).toBe("1.000 cm²");
        expect(formatMeasure(1000, 3, "cm", { suffix: true })).toBe("1.000 cm³");
    });

    test("editor text re-reads to within a nanometre of the stored value", () => {
        for (const unit of LENGTH_UNITS_LIST) {
            for (const value of [100, 12.3456789, 0.001, 98765.4321]) {
                const reread = parseLength(formatLengthForEditing(value, unit), unit).value;
                expect(Math.abs(reread - value)).toBeLessThan(1e-6);
            }
        }
        expect(formatLengthForEditing(100, "cm")).toBe("10");
    });
});

describe("unit suffixes in expressions", () => {
    const scope = new Map([["w", { value: 50, unit: LENGTH_UNITS }]]);

    test("a number with a unit is a length in millimetres", () => {
        const value = evaluateExpression("1 in", scope).value;
        expect(value.value).toBeCloseTo(25.4, 12);
        expect(value.unit).toEqual(LENGTH_UNITS);
        expect(evaluateExpression("w + 1cm", scope).value.value).toBe(60);
        expect(evaluateExpression("(2 + 3) cm", scope).value.value).toBe(50);
    });

    test("a unit on a value that already has one is rejected", () => {
        expect(evaluateExpression("(w) cm", scope).isOk).toBe(false);
        expect(evaluateExpression("2 ft", scope).isOk).toBe(false);
    });

    test("identifiers and functions after an operator are unaffected", () => {
        const withM = new Map([["m", { value: 3, unit: LENGTH_UNITS }]]);
        expect(evaluateExpression("2 * m", withM).value.value).toBe(6);
        expect(evaluateExpression("sqrt(4) * w", scope).value.value).toBe(100);
    });
});

describe("length parameters at the input boundary", () => {
    const scope = new Map([["w", { value: 50, unit: LENGTH_UNITS }]]);

    test("a literal typed in the project unit is stored in millimetres", () => {
        expect(lengthParameterFromInput("10", "cm", scope)).toBe(100);
        expect(lengthParameterFromInput("1 in", "cm", scope)).toBeCloseTo(25.4, 12);
    });

    test("a unitless expression gets the project unit written onto it", () => {
        const stored = lengthParameterFromInput("20 / 2", "cm", scope);
        expect(stored).toBe("(20 / 2) cm");
        expect(resolveUnitSpec(stored, scope, LENGTH_UNITS).value).toBe(100);
    });

    test("an expression that already carries a length is kept verbatim", () => {
        expect(lengthParameterFromInput("w * 2", "cm", scope)).toBe("w * 2");
        expect(lengthParameterFromInput("20 / 2", "mm", scope)).toBe("20 / 2");
    });

    test("an expression variable typed as a bare number stores its unit", () => {
        expect(lengthExpressionFromInput("10", "cm", scope)).toBe("10 cm");
        expect(lengthExpressionFromInput("10", "mm", scope)).toBe("10");
    });

    test("a stored parameter displays in the project unit, an expression as written", () => {
        expect(formatLengthParameter(100, "cm")).toBe("10");
        expect(formatLengthParameter("w * 2", "cm")).toBe("w * 2");
    });
});

describe("length converters", () => {
    test("a number field shows and reads the project unit", () => {
        let unit: "mm" | "cm" = "cm";
        const converter = new LengthConverter(() => unit);
        expect(converter.convert(100).value).toBe("10");
        expect(converter.convertBack("10").value).toBe(100);
        unit = "mm";
        expect(converter.convert(100).value).toBe("100");
        expect(converter.convertBack("abc").isOk).toBe(false);
    });

    test("a point field converts each coordinate", () => {
        const converter = new XYZLengthConverter(() => "cm");
        expect(converter.convert(new XYZ({ x: 10, y: 20, z: -5 })).value).toBe("1,2,-0.5");
        const point = converter.convertBack("1, 2, 1in").value;
        expect(point.x).toBe(10);
        expect(point.y).toBe(20);
        expect(point.z).toBeCloseTo(25.4, 12);
        expect(converter.convertBack("1,2").isOk).toBe(false);
    });

    test("a property is a length when marked so, or when its unit is a length", () => {
        expect(isLengthProperty({ name: "a", display: "common.length", quantity: "length" })).toBe(true);
        expect(isLengthProperty({ name: "a", display: "common.length", unit: LENGTH_UNITS })).toBe(true);
        expect(isLengthProperty({ name: "a", display: "common.length" })).toBe(false);
    });
});

describe("ProjectSettings", () => {
    test("defaults to millimetres, including for files saved before project settings", () => {
        const document = new TestDocument();
        expect(document.settings.lengthUnit).toBe("mm");
        document.settings.load(undefined);
        expect(document.settings.lengthUnit).toBe("mm");
        document.settings.load({ lengthUnit: "furlong" });
        expect(document.settings.lengthUnit).toBe("mm");
    });

    test("restores a stored unit and serializes it", () => {
        const document = new TestDocument();
        document.settings.load({ lengthUnit: "in" });
        expect(document.settings.lengthUnit).toBe("in");
        expect(document.settings.toData()).toEqual({ lengthUnit: "in" });
    });

    test("ignores an unknown unit and undoes a change", () => {
        const document = new TestDocument();
        const settings = document.settings;
        (settings as { lengthUnit: string }).lengthUnit = "ft";
        expect(settings.lengthUnit).toBe("mm");

        Transaction.execute(document, "unit", () => {
            settings.lengthUnit = "cm";
        });
        expect(settings.lengthUnit).toBe("cm");
        document.history.undo();
        expect(settings.lengthUnit).toBe("mm");
    });

    test("repeated unit changes leave a stored value untouched", () => {
        const document = new TestDocument();
        const stored = 100;
        const shown: string[] = [];
        for (let i = 0; i < 50; i++) {
            for (const unit of LENGTH_UNITS_LIST) {
                document.settings.lengthUnit = unit;
                shown.push(formatLength(stored, documentLengthUnit(document)));
            }
        }
        expect(stored).toBe(100);
        expect(new Set(shown).size).toBe(LENGTH_UNITS_LIST.length);
    });

    test("a document without settings reads as millimetres", () => {
        expect(documentLengthUnit(undefined)).toBe("mm");
        expect(documentLengthUnit({} as never)).toBe("mm");
        expect(new ProjectSettings(new TestDocument(), { lengthUnit: "m" }).lengthUnit).toBe("m");
    });
});

describe("typed viewport input", () => {
    function handlerIn(unit: "mm" | "cm" | "in") {
        const document = new TestDocument();
        document.settings.lengthUnit = unit;
        const handler = new SnapLengthAtAxisHandler(document, new AsyncController(), {
            point: XYZ.zero,
            direction: XYZ.unitX,
        });
        return handler as unknown as { normalizeInput(text: string): string };
    }

    test("reads each number in the project unit and hands millimetres on", () => {
        expect(handlerIn("cm").normalizeInput("10")).toBe("100");
        expect(handlerIn("cm").normalizeInput("1,2,-3")).toBe("10,20,-30");
        expect(handlerIn("cm").normalizeInput("#1,2,3")).toBe("#10,20,30");
        expect(Number(handlerIn("cm").normalizeInput("1in"))).toBeCloseTo(25.4, 12);
        expect(handlerIn("mm").normalizeInput("10")).toBe("10");
    });

    test("keeps what is not a length, for the handler to reject", () => {
        expect(handlerIn("cm").normalizeInput("abc")).toBe("abc");
    });

    test("leaves an angle in degrees", () => {
        const document = new TestDocument();
        document.settings.lengthUnit = "cm";
        const handler = new AngleSnapEventHandler(
            document,
            new AsyncController(),
            () => XYZ.zero,
            XYZ.unitX,
            {
                plane: () => Plane.XY,
            },
        ) as unknown as { normalizeInput(text: string): string };
        expect(handler.normalizeInput("45")).toBe("45");
    });
});
