// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
    AutosaveSettings,
    AutosaveStatus,
    type FileAutosaveState,
    formatTime,
    I18n,
    type IDocument,
    type IView,
    ObjectStorage,
    PubSub,
} from "@spicy3d/core";
import { AutosaveSelector } from "../src/home/autosaveSelector";
import { AutosaveIndicator } from "../src/statusbar/autosaveStatus";

afterEach(() => {
    document.body.innerHTML = "";
});

describe("AutosaveSelector", () => {
    test("offers Off to 30 minutes, shows the setting and changes it", () => {
        const settings = new AutosaveSettings(new ObjectStorage("spicy3d-test", `sel-${Math.random()}`));
        const selector = new AutosaveSelector(settings);
        document.body.append(selector);

        expect(Array.from(selector.select.options, (x) => x.value)).toEqual([
            "0",
            "1",
            "2",
            "5",
            "10",
            "15",
            "30",
        ]);
        expect(selector.select.options[0].textContent).toBe(I18n.translate("autosave.interval.off"));
        expect(selector.select.value).toBe("5");

        selector.select.value = "10";
        selector.select.dispatchEvent(new Event("change"));
        expect(settings.intervalMinutes).toBe(10);
        expect(settings.localIntervalMinutes).toBe(10);
    });

    test("follows a value that arrives from elsewhere (the server, signed in)", () => {
        const settings = new AutosaveSettings(new ObjectStorage("spicy3d-test", `sel-${Math.random()}`));
        const selector = new AutosaveSelector(settings);
        document.body.append(selector);

        settings.attach({ save: () => {} }, "user-1");
        settings.applyStoreValue(30);

        expect(selector.select.value).toBe("30");
    });
});

describe("AutosaveIndicator", () => {
    function documentIn(kind: "local" | "cloud") {
        return { repository: { kind } } as unknown as IDocument;
    }

    function show(status: AutosaveStatus, active: IDocument) {
        const indicator = new AutosaveIndicator(status);
        document.body.append(indicator);
        PubSub.default.pub("activeViewChanged", { document: active } as unknown as IView);
        return indicator;
    }

    test("'Autosaved 14:05' in local time for the active local document", () => {
        const status = new AutosaveStatus();
        const doc = documentIn("local");
        const indicator = show(status, doc);
        expect(indicator.textContent).toBe("");

        const at = Date.UTC(2026, 8, 27, 12, 5);
        status.recordAutosave(doc, at);

        expect(indicator.textContent).toBe(I18n.translate("autosave.status.autosaved{0}", formatTime(at)));
    });

    test("a cloud document's autosave shows in the title bar, not here", () => {
        const status = new AutosaveStatus();
        const doc = documentIn("cloud");
        const indicator = show(status, doc);

        status.recordAutosave(doc, Date.now());

        expect(indicator.textContent).toBe("");
    });

    test("an opened .spicy file offers the per-file opt-in", async () => {
        const status = new AutosaveStatus();
        let state: FileAutosaveState = "off";
        const set = rs.fn(async (_document: IDocument, enabled: boolean) => {
            state = enabled ? "on" : "off";
            return enabled;
        });
        status.fileAutosave = { state: () => state, set };
        const doc = documentIn("local");
        const indicator = show(status, doc);

        const box = indicator.querySelector("input[type=checkbox]") as HTMLInputElement;
        expect(box).not.toBeNull();
        expect(box.checked).toBe(false);
        box.checked = true;
        box.dispatchEvent(new Event("change"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(set).toHaveBeenCalledWith(doc, true);
        expect((indicator.querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(true);
    });

    test("no opt-in for a document without a writable file", () => {
        const status = new AutosaveStatus();
        status.fileAutosave = { state: () => "unavailable", set: async () => false };
        const indicator = show(status, documentIn("local"));

        expect(indicator.querySelector("input")).toBeNull();
    });
});
