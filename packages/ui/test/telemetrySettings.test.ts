// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    type DialogButton,
    I18n,
    ObjectStorage,
    PubSub,
    Result,
    type TelemetryConfig,
    TelemetrySettings,
    type TelemetryTestFailure,
} from "@spicy3d/core";
import {
    showTelemetrySettings,
    TelemetrySettingsButton,
    TelemetrySettingsForm,
    type TelemetryTester,
} from "../src/home/telemetrySettings";

function settings(config?: TelemetryConfig) {
    const created = new TelemetrySettings(new ObjectStorage("spicy3d-test", `telemetry-${Math.random()}`));
    if (config) created.config = config;
    return created;
}

function tester(result: Result<number, TelemetryTestFailure>) {
    return rs.fn<TelemetryTester>(async (_config) => result);
}

let published: [string, unknown[]][];

beforeEach(() => {
    published = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation((event: string, ...args: unknown[]) => {
        published.push([event, args]);
    });
});

afterEach(() => {
    rs.restoreAllMocks();
});

function dialogButtons(): DialogButton[] {
    const dialog = published.filter(([event]) => event === "showDialog").at(-1);
    expect(dialog).toBeDefined();
    expect(dialog![1][0]).toBe("telemetry.title");
    return dialog![1][2] as DialogButton[];
}

describe("TelemetrySettingsForm", () => {
    test("shows the configuration; the key is a password field", () => {
        const form = new TelemetrySettingsForm({ enabled: true, url: "https://c.example.com", key: "k" });

        expect(form.enabled.checked).toBe(true);
        expect(form.url.value).toBe("https://c.example.com");
        expect(form.key.value).toBe("k");
        expect(form.key.type).toBe("password");
        expect(form.value).toEqual({ enabled: true, url: "https://c.example.com", key: "k" });
    });

    test.each([
        [Result.ok(204), "ok", I18n.translate("telemetry.test.ok{0}", 204)],
        [
            Result.err({ status: 403, message: "Forbidden" }),
            "failed",
            I18n.translate("telemetry.test.status{0}", 403),
        ],
        [
            Result.err({ message: "Failed to fetch" }),
            "failed",
            I18n.translate("telemetry.test.error{0}", "Failed to fetch"),
        ],
        [Result.err({ message: "invalid-url" }), "failed", I18n.translate("telemetry.test.invalidUrl")],
    ])("Test connection tests what is typed and shows the outcome (%#)", async (result, state, text) => {
        const test = tester(result as Result<number, TelemetryTestFailure>);
        const form = new TelemetrySettingsForm({ enabled: false, url: "", key: "" }, test);
        form.url.value = " https://typed.example.com/otlp ";
        form.key.value = "secret";

        form.testButton.click();
        await test.mock.results[0]?.value;
        await Promise.resolve();

        expect(test).toHaveBeenCalledWith({
            enabled: false,
            url: "https://typed.example.com/otlp",
            key: "secret",
        });
        expect(form.result.dataset["state"]).toBe(state);
        expect(form.result.textContent).toBe(text);
        expect(form.testButton.disabled).toBe(false);
    });
});

describe("showTelemetrySettings", () => {
    test("Save stores the fields", () => {
        const stored = settings();
        const form = showTelemetrySettings(stored);
        form.enabled.checked = true;
        form.url.value = "https://c.example.com/otlp/abc";

        const [save] = dialogButtons();
        expect(save.content).toBe("common.save");
        expect(save.shouldClose!()).toBe(true);
        save.onclick!();

        expect(stored.config).toEqual({ enabled: true, url: "https://c.example.com/otlp/abc", key: "" });
    });

    test.each([
        ["on without a URL", true, ""],
        ["an invalid URL", false, "c.example.com"],
    ])("Save refuses %s and keeps the dialog open", (_name, enabled, url) => {
        const stored = settings();
        const form = showTelemetrySettings(stored);
        form.enabled.checked = enabled;
        form.url.value = url;

        const [save] = dialogButtons();
        expect(save.shouldClose!()).toBe(false);
        save.onclick!();

        expect(stored.config).toEqual({ enabled: false, url: "", key: "" });
        expect(form.result.textContent).toBe(I18n.translate("telemetry.test.invalidUrl"));
    });

    test("Cancel changes nothing", () => {
        const stored = settings();
        const form = showTelemetrySettings(stored);
        form.enabled.checked = true;
        form.url.value = "https://c.example.com";

        const [, cancel] = dialogButtons();
        expect(cancel.content).toBe("common.cancel");
        expect(cancel.onclick).toBeUndefined();
        expect(stored.config.enabled).toBe(false);
    });
});

describe("TelemetrySettingsButton", () => {
    test("Off by default, On once switched on with a URL, and opens the settings", () => {
        const stored = settings();
        const button = new TelemetrySettingsButton(stored);
        document.body.append(button);
        try {
            expect(button.button.textContent).toBe(I18n.translate("telemetry.off"));

            stored.config = { enabled: true, url: "https://c.example.com", key: "" };
            expect(button.button.textContent).toBe(I18n.translate("common.on"));

            button.button.click();
            expect(dialogButtons()).toHaveLength(2);
        } finally {
            button.remove();
        }
    });
});
