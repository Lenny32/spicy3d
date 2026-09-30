// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type DialogButton, I18n, PubSub } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { showRadiusLawEditor } from "../src/commands/radiusLawEditor";
import type { FilletRadiusPoint } from "../src/features/radiusLaw";

describe("fillet radius law editor", () => {
    let originalPub: typeof PubSub.default.pub;
    let content: HTMLElement;
    let buttons: DialogButton[];
    beforeEach(() => {
        originalPub = PubSub.default.pub;
        PubSub.default.pub = ((topic: string, ...args: unknown[]) => {
            if (topic === "showDialog") {
                content = args[1] as HTMLElement;
                buttons = args[2] as DialogButton[];
            }
        }) as typeof PubSub.default.pub;
    });
    afterEach(() => {
        PubSub.default.pub = originalPub;
    });
    function radius(index: number): HTMLInputElement {
        const input = content.querySelectorAll<HTMLInputElement>('input[data-role="radius"]')[index];
        expect(input).not.toBeUndefined();
        return input;
    }
    function accept(): boolean {
        expect(buttons[0].content).toBe("common.confirm");
        const close = buttons[0].shouldClose?.() !== false;
        // Dialog invokes the callback even when validation prevents closing.
        buttons[0].onclick?.();
        return close;
    }

    test("converts project-unit inputs and confirms a draft without mutating its initial law", () => {
        const doc = new TestDocument();
        doc.settings.lengthUnit = "cm";
        const initial = [
            { position: 0, radius: 20 },
            { position: 1, radius: 30 },
        ];
        const accepted = rs.fn((_law: FilletRadiusPoint[]) => {});
        showRadiusLawEditor(doc, initial, accepted);
        expect(radius(0).value).toBe("2");
        expect(radius(1).value).toBe("3");
        radius(0).value = "1.5";
        radius(1).value = "4 mm";
        expect(accept()).toBe(true);
        expect(accepted).toHaveBeenCalledWith([
            { position: 0, radius: 15 },
            { position: 1, radius: 4 },
        ]);
        expect(initial).toEqual([
            { position: 0, radius: 20 },
            { position: 1, radius: 30 },
        ]);
    });

    test("invalid confirmation shows a diagnostic and never accepts until the radius is corrected", () => {
        const accepted = rs.fn((_law: FilletRadiusPoint[]) => {});
        showRadiusLawEditor(
            new TestDocument(),
            [
                { position: 0, radius: 2 },
                { position: 1, radius: 3 },
            ],
            accepted,
        );
        radius(0).value = "-1";
        expect(accept()).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
        const error = content.querySelector('[role="alert"]');
        expect(error).not.toBeNull();
        expect(error!.textContent).toContain("positive finite");
        radius(0).value = "2 mm * 2";
        expect(accept()).toBe(true);
        expect(accepted.mock.calls[0][0][0].radius).toBe("2 mm * 2");
    });

    test("adds an interpolated sample, keeps endpoints fixed and allows an invalid interior sample to be removed", () => {
        const accepted = rs.fn((_law: FilletRadiusPoint[]) => {});
        showRadiusLawEditor(
            new TestDocument(),
            [
                { position: 0, radius: 2 },
                { position: 1, radius: 4 },
            ],
            accepted,
        );
        const add = Array.from(content.querySelectorAll("button")).find(
            (button) => button.textContent === I18n.translate("fillet.addSample"),
        );
        expect(add).not.toBeUndefined();
        add!.click();
        const positions = content.querySelectorAll<HTMLInputElement>('input[data-role="position"]');
        expect(positions.length).toBe(3);
        expect(positions[0].disabled).toBe(true);
        expect(positions[1].value).toBe("50");
        expect(positions[2].disabled).toBe(true);
        expect(radius(1).value).toBe("3");
        radius(1).value = "missing";
        expect(accept()).toBe(false);
        content.querySelectorAll<HTMLButtonElement>("tbody button")[1].click();
        expect(accept()).toBe(true);
        expect(accepted).toHaveBeenCalledWith([
            { position: 0, radius: 2 },
            { position: 1, radius: 4 },
        ]);
    });

    test("cancelling discards typed changes", () => {
        const accepted = rs.fn((_law: FilletRadiusPoint[]) => {});
        const initial = [
            { position: 0, radius: 2 },
            { position: 1, radius: 4 },
        ];
        showRadiusLawEditor(new TestDocument(), initial, accepted);
        radius(0).value = "6";
        expect(buttons[1].content).toBe("common.cancel");
        buttons[1].onclick?.();
        expect(accepted).not.toHaveBeenCalled();
        expect(initial[0].radius).toBe(2);
    });
});
