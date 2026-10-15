// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    I18n,
    type I18nKeys,
    PubSub,
    type Result,
    type TelemetryConfig,
    TelemetrySettings,
    type TelemetryTestFailure,
    telemetryBaseUrl,
    testTelemetryConnection,
} from "@spicy3d/core";
import { button, div, input, label, p, span } from "@spicy3d/element";
import style from "./telemetrySettings.module.css";

export type TelemetryTester = (
    config: Pick<TelemetryConfig, "url" | "key">,
) => Promise<Result<number, TelemetryTestFailure>>;

const defaultTester: TelemetryTester = (config) => testTelemetryConnection(config, __APP_VERSION__);

/** What a connection test showed, as text. */
export function telemetryTestMessage(result: Result<number, TelemetryTestFailure>): string {
    if (result.isOk) return I18n.translate("telemetry.test.ok{0}", result.value);
    const failure = result.error!;
    if (failure.status !== undefined) return I18n.translate("telemetry.test.status{0}", failure.status);
    if (failure.message === "invalid-url") return I18n.translate("telemetry.test.invalidUrl");
    return I18n.translate("telemetry.test.error{0}", failure.message);
}

/**
 * The fields of Settings → Telemetry: the switch, the OTLP base URL, the optional key and Test
 * connection (which tests what is typed, saved or not). `value` is what Save stores.
 */
export class TelemetrySettingsForm extends HTMLElement {
    readonly enabled: HTMLInputElement;
    readonly url: HTMLInputElement;
    readonly key: HTMLInputElement;
    readonly testButton: HTMLButtonElement;
    readonly result: HTMLElement;

    constructor(
        config: TelemetryConfig,
        private readonly tester: TelemetryTester = defaultTester,
    ) {
        super();
        this.className = style.form;
        this.enabled = input({ type: "checkbox", checked: config.enabled });
        this.url = input({
            type: "url",
            value: config.url,
            placeholder: "https://collector.example.com/otlp",
            spellcheck: false,
        });
        this.url.autocomplete = "off";
        this.key = input({ type: "password", value: config.key, spellcheck: false });
        this.key.autocomplete = "off";
        this.testButton = button({
            textContent: I18n.translate("telemetry.test"),
            onclick: () => void this.test(),
        });
        this.testButton.type = "button";
        this.result = span({ className: style.result });
        this.result.setAttribute("role", "status");
        this.append(
            p({ className: style.about, textContent: I18n.translate("telemetry.about") }),
            label({ className: style.switch }, this.enabled, span(I18n.translate("telemetry.enabled"))),
            this.field("telemetry.url", this.url, "telemetry.urlHint"),
            this.field("telemetry.key", this.key, "telemetry.keyHint"),
            div({ className: style.test }, this.testButton, this.result),
        );
    }

    get value(): TelemetryConfig {
        return { enabled: this.enabled.checked, url: this.url.value.trim(), key: this.key.value.trim() };
    }

    /** Sends one test log record to what is typed and shows the outcome. */
    async test(): Promise<void> {
        const config = this.value;
        this.result.dataset["state"] = "pending";
        this.result.textContent = I18n.translate("telemetry.testing");
        this.testButton.disabled = true;
        try {
            const result = await this.tester(config);
            this.result.dataset["state"] = result.isOk ? "ok" : "failed";
            this.result.textContent = telemetryTestMessage(result);
        } finally {
            this.testButton.disabled = false;
        }
    }

    private field(title: I18nKeys, control: HTMLInputElement, hint: I18nKeys) {
        control.setAttribute("aria-label", I18n.translate(title));
        return label(
            { className: style.field },
            span(I18n.translate(title)),
            control,
            span({ className: style.hint, textContent: I18n.translate(hint) }),
        );
    }
}

customElements.define("spicy-telemetry-settings", TelemetrySettingsForm);

/** Opens Settings → Telemetry; Save stores the fields (applied at once, see `TelemetryController`). */
export function showTelemetrySettings(
    settings: TelemetrySettings = TelemetrySettings.current,
    tester?: TelemetryTester,
): TelemetrySettingsForm {
    const form = new TelemetrySettingsForm(settings.config, tester);
    // Enabled needs a URL; a URL must be http(s). The dialog runs `onclick` even when it stays open.
    const isValid = () => {
        const { enabled, url } = form.value;
        return url === "" ? !enabled : telemetryBaseUrl(url) !== undefined;
    };
    PubSub.default.pub("showDialog", "telemetry.title", form, [
        {
            content: "common.save",
            shouldClose: () => {
                if (isValid()) return true;
                form.result.dataset["state"] = "failed";
                form.result.textContent = I18n.translate("telemetry.test.invalidUrl");
                return false;
            },
            onclick: () => {
                if (isValid()) settings.config = form.value;
            },
        },
        { content: "common.cancel" },
    ]);
    return form;
}

/** The home page's Telemetry row: On/Off, opening the settings. */
export class TelemetrySettingsButton extends HTMLElement {
    readonly button: HTMLButtonElement;

    constructor(private readonly settings: TelemetrySettings = TelemetrySettings.current) {
        super();
        this.button = button({ onclick: () => void showTelemetrySettings(this.settings) });
        this.button.type = "button";
        this.button.setAttribute("aria-label", I18n.translate("telemetry.setting"));
        this.append(this.button);
        this.update();
    }

    connectedCallback(): void {
        this.settings.onPropertyChanged(this.update);
        this.update();
    }

    disconnectedCallback(): void {
        this.settings.removePropertyChanged(this.update);
    }

    private readonly update = () => {
        const config = this.settings.config;
        const on = config.enabled && telemetryBaseUrl(config.url) !== undefined;
        this.button.textContent = I18n.translate(on ? "common.on" : "telemetry.off");
    };
}

customElements.define("spicy-telemetry-settings-button", TelemetrySettingsButton);
