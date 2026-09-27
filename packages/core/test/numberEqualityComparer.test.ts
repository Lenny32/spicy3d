// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { NumberEqualityComparer } from "../src/foundation/comparers/NumberEqualityComparer";

describe("NumberEqualityComparer", () => {
    describe("default tolerance", () => {
        test("should return true for identical numbers", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(42, 42)).toBe(true);
        });

        test("should return true for numbers within default tolerance", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(1.0, 1.00000000000001)).toBe(true);
        });

        test("should return false for numbers outside default tolerance", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(1, 2)).toBe(false);
        });

        test("should return true for both zero", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(0, 0)).toBe(true);
        });

        test("should return true for both negative zero", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(-0, 0)).toBe(true);
        });

        test("should return true for negative numbers within tolerance", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(-1, -1.00000000000001)).toBe(true);
        });

        test("should return false for very different negative numbers", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(-1, -2)).toBe(false);
        });
    });

    describe("custom tolerance", () => {
        test("should use custom tolerance when provided", () => {
            const comparer = new NumberEqualityComparer(0.5);
            expect(comparer.equals(1.0, 1.4)).toBe(true);
        });

        test("should reject outside custom tolerance", () => {
            const comparer = new NumberEqualityComparer(0.1);
            expect(comparer.equals(1.0, 1.2)).toBe(false);
        });

        test("zero tolerance uses strict inequality (< 0)", () => {
            // Math.abs(1.0 - 1.0) < 0 is false (0 is not less than 0)
            const comparer = new NumberEqualityComparer(0);
            expect(comparer.equals(1.0, 1.0)).toBe(false);
        });

        test("should reject different numbers with zero tolerance", () => {
            const comparer = new NumberEqualityComparer(0);
            expect(comparer.equals(1.0, 1.0001)).toBe(false);
        });

        test("very small epsilon works for equal numbers", () => {
            const comparer = new NumberEqualityComparer(1e-12);
            expect(comparer.equals(1.0, 1.0)).toBe(true);
        });
    });

    describe("edge cases", () => {
        test("should handle large numbers", () => {
            const comparer = new NumberEqualityComparer(1);
            expect(comparer.equals(1e10, 1e10 + 0.5)).toBe(true);
        });

        test("should handle very small numbers", () => {
            const comparer = new NumberEqualityComparer(1e-10);
            expect(comparer.equals(1e-15, 2e-15)).toBe(true);
        });

        test("Infinity - Infinity is NaN, so comparison returns false", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
        });

        test("negative Infinity comparison returns false (NaN)", () => {
            const comparer = new NumberEqualityComparer();
            expect(comparer.equals(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe(false);
        });

        test("should return true for very small positive difference", () => {
            const comparer = new NumberEqualityComparer(0.001);
            expect(comparer.equals(1.0, 1.0005)).toBe(true);
        });
    });
});
