// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { en } from "../src";

describe("i18n locales", () => {
    const locales = [{ name: "en", locale: en }] as const;

    describe("locale structure", () => {
        for (const { name, locale } of locales) {
            test(`${name} should have display and language`, () => {
                expect(typeof locale.display).toBe("string");
                expect(locale.display.length).toBeGreaterThan(0);
                expect(typeof locale.language).toBe("string");
                expect(locale.language.length).toBeGreaterThan(0);
            });

            test(`${name} should have a non-empty translation object`, () => {
                expect(typeof locale.translation).toBe("object");
                expect(Object.keys(locale.translation).length).toBeGreaterThan(0);
            });
        }
    });

    describe("locale languages", () => {
        test("en language should be en", () => {
            expect(en.language).toBe("en");
        });
    });

    describe("common translation keys", () => {
        test("should contain essential UI keys", () => {
            const essentialKeys = [
                "common.confirm",
                "common.cancel",
                "common.name",
                "common.color",
                "toast.success",
                "toast.fail",
            ] as const;
            for (const key of essentialKeys) {
                expect(en.translation[key]).toBeDefined();
                expect(typeof en.translation[key]).toBe("string");
            }
        });

        test("should contain ribbon tab keys", () => {
            expect(en.translation["ribbon.tab.solid"]).toBe("Solid");
            expect(en.translation["ribbon.tab.surface"]).toBe("Surface");
            expect(en.translation["ribbon.tab.utilities"]).toBe("Utilities");
        });

        test("should contain error keys", () => {
            expect(en.translation["error.default:{0}"]).toBeDefined();
            expect(en.translation["error.export.noNodeCanBeExported"]).toBeDefined();
            expect(en.translation["error.import.unsupportedFileType:{0}"]).toBeDefined();
        });
    });

    describe("translation values", () => {
        test("all translation values should be non-empty strings", () => {
            for (const [key, value] of Object.entries(en.translation)) {
                expect(typeof value).toBe("string");
                if (value.length === 0) {
                    throw new Error(`Empty translation for key: ${key}`);
                }
            }
        });
    });
});
