// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, rs, test } from "@rstest/core";
import {
    AUTOSAVE_INTERVALS,
    AutosaveHolds,
    type AutosaveInterval,
    AutosaveSettings,
    AutosaveStatus,
    autosaveIntervalLabel,
    type IDocument,
    ObjectStorage,
} from "../src";

/** A storage of its own, as `localStorage` holds it (`spicy3d-test.<id>.<key>`). */
function storage() {
    return new ObjectStorage("spicy3d-test", `autosave-${Math.random()}`);
}

describe("AutosaveSettings", () => {
    test("5 minutes by default; the options are Off, 1, 2, 5, 10, 15 and 30 minutes", () => {
        expect(new AutosaveSettings(storage()).intervalMinutes).toBe(5);
        expect([...AUTOSAVE_INTERVALS]).toEqual([0, 1, 2, 5, 10, 15, 30]);
        expect(autosaveIntervalLabel(0)).toEqual(["autosave.interval.off"]);
        expect(autosaveIntervalLabel(15)).toEqual(["autosave.interval.minutes{0}", 15]);
    });

    test("signed out, the interval persists in localStorage across reloads", () => {
        const kept = storage();
        new AutosaveSettings(kept).intervalMinutes = 15;

        const reloaded = new AutosaveSettings(kept);

        expect(reloaded.intervalMinutes).toBe(15);
        expect(kept.value(AutosaveSettings.STORAGE_KEY)).toEqual({ intervalMinutes: 15 });
    });

    test("the key is spicy3d.settings.autosave", () => {
        const settings = new AutosaveSettings();
        const before = settings.localIntervalMinutes;
        try {
            settings.intervalMinutes = 2;
            expect(JSON.parse(localStorage.getItem("spicy3d.settings.autosave") ?? "null")).toEqual({
                intervalMinutes: 2,
            });
        } finally {
            settings.intervalMinutes = before;
        }
    });

    test("an invalid value is ignored, stored or set", () => {
        const kept = storage();
        kept.setValue(AutosaveSettings.STORAGE_KEY, { intervalMinutes: 7 });
        const settings = new AutosaveSettings(kept);
        expect(settings.intervalMinutes).toBe(5);

        settings.intervalMinutes = 3 as AutosaveInterval;
        expect(settings.intervalMinutes).toBe(5);
    });

    test("signed in: the store gets the changes and the local value is left alone", () => {
        const kept = storage();
        const settings = new AutosaveSettings(kept);
        settings.intervalMinutes = 10;
        const store = { save: rs.fn((_interval: AutosaveInterval) => {}) };

        settings.attach(store, "user-1");
        expect(settings.intervalMinutes).toBe(10);

        settings.intervalMinutes = 1;

        expect(store.save).toHaveBeenCalledWith(1);
        expect(settings.localIntervalMinutes).toBe(10);
        expect(settings.accountCache).toEqual({ userId: "user-1", intervalMinutes: 1, pending: true });
    });

    test("the server's value applies and is cached for an offline start; signing out brings back the local one", () => {
        const kept = storage();
        const settings = new AutosaveSettings(kept);
        settings.intervalMinutes = 10;
        const detach = settings.attach({ save: () => {} }, "user-1");

        settings.applyStoreValue(30);
        expect(settings.intervalMinutes).toBe(30);
        // Offline start: the cloud module isn't even loaded, the cached account value applies.
        expect(new AutosaveSettings(kept).intervalMinutes).toBe(30);

        detach();
        expect(settings.intervalMinutes).toBe(10);
        expect(settings.accountCache).toBeUndefined();
        expect(new AutosaveSettings(kept).intervalMinutes).toBe(10);
    });

    test("another user signing in starts from the local value, not the previous user's", () => {
        const kept = storage();
        const settings = new AutosaveSettings(kept);
        settings.attach({ save: () => {} }, "user-1");
        settings.applyStoreValue(30);

        settings.attach({ save: () => {} }, "user-2");

        expect(settings.intervalMinutes).toBe(5);
        expect(settings.accountCache).toEqual({ userId: "user-2", intervalMinutes: 5, pending: false });
    });

    test("a change during an offline start is cached as pending for that user", () => {
        const kept = storage();
        const first = new AutosaveSettings(kept);
        first.attach({ save: () => {} }, "user-1");
        first.applyStoreValue(30);

        const offline = new AutosaveSettings(kept);
        offline.intervalMinutes = 2;

        expect(offline.accountCache).toEqual({ userId: "user-1", intervalMinutes: 2, pending: true });
        expect(offline.localIntervalMinutes).toBe(5);
    });

    test("forgetAccount drops a cached account value even when nothing is attached", () => {
        const kept = storage();
        const first = new AutosaveSettings(kept);
        first.intervalMinutes = 1;
        first.attach({ save: () => {} }, "user-1");
        first.applyStoreValue(30);
        const later = new AutosaveSettings(kept);
        expect(later.intervalMinutes).toBe(30);

        later.forgetAccount();

        expect(later.intervalMinutes).toBe(1);
        expect(later.accountCache).toBeUndefined();
        expect(kept.value(AutosaveSettings.ACCOUNT_STORAGE_KEY)).toBeUndefined();
    });

    test("without a store, a store value is ignored", () => {
        const settings = new AutosaveSettings(storage());
        settings.applyStoreValue(30);
        expect(settings.intervalMinutes).toBe(5);
    });
});

describe("AutosaveHolds", () => {
    test("held until every hold is released, then the listeners are told once", () => {
        const released = rs.fn(() => {});
        const unsubscribe = AutosaveHolds.onReleased(released);
        try {
            const sketch = AutosaveHolds.hold("sketch");
            const drag = AutosaveHolds.hold("drag");
            expect(AutosaveHolds.isHeld).toBe(true);

            sketch();
            sketch();
            expect(AutosaveHolds.isHeld).toBe(true);
            expect(released).not.toHaveBeenCalled();

            drag();
            expect(AutosaveHolds.isHeld).toBe(false);
            expect(released).toHaveBeenCalledTimes(1);
        } finally {
            unsubscribe();
        }
    });
});

describe("AutosaveStatus", () => {
    test("records the last autosave per document and tells the listeners", () => {
        const status = new AutosaveStatus();
        const document = {} as IDocument;
        const changed = rs.fn((_document: IDocument) => {});
        status.onChanged(changed);

        status.recordAutosave(document, 42);
        expect(status.lastAutosavedAt(document)).toBe(42);

        status.clear(document);
        status.clear(document);
        expect(status.lastAutosavedAt(document)).toBeUndefined();
        expect(changed.mock.calls).toEqual([[document], [document]]);
    });
});
