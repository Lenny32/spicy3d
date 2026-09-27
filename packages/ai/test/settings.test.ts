// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DeploymentConfig, ObjectStorage } from "@spicy3d/core";
import { mockLocalStorage } from "@spicy3d/core/test-utils";
import {
    defaultPreset,
    isUnreachableError,
    loadConfig,
    PROVIDER_PRESETS,
    presetFor,
    providerPresets,
    saveConfig,
} from "../src/settings";

describe("ai settings", () => {
    beforeEach(() => {
        mockLocalStorage();
    });

    test("keeps the api key in session memory and out of persistent storage", () => {
        saveConfig({ provider: "anthropic", apiKey: "sk-secret", model: "m" });

        const raw = localStorage.getItem("spicy3d.app.ai.config");
        expect(raw).not.toBeNull();
        expect(raw).not.toContain("sk-secret");
        expect(JSON.parse(raw as string).apiKey).toBeUndefined();

        const loaded = loadConfig();
        expect(loaded?.apiKey).toBe("sk-secret");
        expect(loaded?.provider).toBe("anthropic");
        expect(loaded?.model).toBe("m");
    });

    test("migrates a plaintext key persisted by older versions into session memory", () => {
        ObjectStorage.default.setValue("ai.config", {
            provider: "openai-compatible",
            baseURL: "https://example.com/v1",
            apiKey: "old-key",
            model: "gpt",
        });

        const loaded = loadConfig();
        expect(loaded?.apiKey).toBe("old-key");
        expect(loaded?.baseURL).toBe("https://example.com/v1");

        const raw = localStorage.getItem("spicy3d.app.ai.config");
        expect(raw).not.toBeNull();
        expect(raw).not.toContain("old-key");
    });

    test("returns undefined when nothing is stored", () => {
        expect(loadConfig()).toBeUndefined();
    });
});

describe("provider presets from deployment.json", () => {
    const lan = {
        id: "lan",
        label: "Company LLM",
        provider: "completions",
        baseURL: "https://llm.lan/v1",
        defaultModel: "qwen3",
    };

    afterEach(() => DeploymentConfig.reset());

    test("without a deployment section the public APIs are offered, Anthropic first", () => {
        expect(providerPresets()).toEqual(PROVIDER_PRESETS);
        expect(defaultPreset().id).toBe("anthropic");
    });

    test("the deployment's presets come first, then the public APIs", () => {
        DeploymentConfig.set({ ai: { presets: [lan] } });

        expect(providerPresets().map((p) => p.id)).toEqual(["lan", "anthropic", "openai", "responses"]);
        expect(defaultPreset().id).toBe("lan");
    });

    test("hideBuiltInPresets leaves only the deployment's; defaultPreset picks one", () => {
        DeploymentConfig.set({
            ai: { presets: [lan, { ...lan, id: "lan2" }], hideBuiltInPresets: true, defaultPreset: "lan2" },
        });

        expect(providerPresets().map((p) => p.id)).toEqual(["lan", "lan2"]);
        expect(defaultPreset().id).toBe("lan2");
    });

    test("invalid entries are dropped, and hiding the public APIs needs a valid preset", () => {
        DeploymentConfig.set({
            ai: { presets: [{ ...lan, provider: "gemini" }, { id: "x" }, "lan"], hideBuiltInPresets: true },
        });

        expect(providerPresets()).toEqual(PROVIDER_PRESETS);
    });

    test("a saved config maps back to its preset by endpoint, then by provider", () => {
        DeploymentConfig.set({ ai: { presets: [lan] } });

        expect(presetFor({ provider: "completions", baseURL: "https://api.openai.com/v1/" })?.id).toBe(
            "openai",
        );
        expect(presetFor({ provider: "completions", baseURL: "https://llm.lan/v1" })?.id).toBe("lan");
        expect(presetFor({ provider: "completions", baseURL: "https://other/v1" })?.id).toBe("lan");
    });
});

describe("isUnreachableError", () => {
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {}

    test.each([
        [new TypeError("Failed to fetch"), true],
        [new APIConnectionError("Connection error."), true],
        [new APIConnectionTimeoutError("Request timed out."), true],
        [new Error("401 Unauthorized"), false],
        ["Connection error.", false],
    ])("%p → %p", (error, expected) => {
        expect(isUnreachableError(error)).toBe(expected);
    });
});
