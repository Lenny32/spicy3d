// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DeploymentConfig, Logger, ObjectStorage } from "@spicy3d/core";

export interface LLMConfig {
    provider: "anthropic" | "completions" | "responses";
    baseURL?: string;
    apiKey: string;
    model: string;
}

export interface ProviderPreset {
    id: string;
    label: string;
    provider: LLMConfig["provider"];
    baseURL?: string;
    defaultModel: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        id: "anthropic",
        label: "Anthropic API",
        provider: "anthropic",
        baseURL: "https://api.anthropic.com",
        defaultModel: DEFAULT_ANTHROPIC_MODEL,
    },
    {
        id: "openai",
        label: "Completions API",
        provider: "completions",
        baseURL: "https://api.openai.com/v1",
        defaultModel: DEFAULT_OPENAI_MODEL,
    },
    {
        id: "responses",
        label: "Responses API",
        provider: "responses",
        baseURL: "https://api.openai.com/v1",
        defaultModel: DEFAULT_OPENAI_MODEL,
    },
];

const PROVIDERS: readonly string[] = ["anthropic", "completions", "responses"];

function isPreset(value: unknown): value is ProviderPreset {
    if (typeof value !== "object" || value === null) return false;
    const p = value as Record<string, unknown>;
    return (
        typeof p["id"] === "string" &&
        p["id"] !== "" &&
        typeof p["label"] === "string" &&
        typeof p["provider"] === "string" &&
        PROVIDERS.includes(p["provider"]) &&
        (p["baseURL"] === undefined || typeof p["baseURL"] === "string") &&
        typeof p["defaultModel"] === "string"
    );
}

/**
 * The endpoints offered in the chat settings: the deployment's own first (`deployment.json`,
 * section `ai`, `presets` — e.g. an on-prem OpenAI-compatible server), then the public APIs unless
 * `hideBuiltInPresets` (a LAN without internet access, where they can only fail).
 */
export function providerPresets(): ProviderPreset[] {
    const section = DeploymentConfig.section("ai");
    const listed: unknown[] = Array.isArray(section?.["presets"]) ? section["presets"] : [];
    const custom = listed.filter(isPreset).map(({ id, label, provider, baseURL, defaultModel }) => ({
        id,
        label,
        provider,
        baseURL,
        defaultModel,
    }));
    if (custom.length < listed.length)
        Logger.warn("[ai] deployment.json: invalid ai.presets entries ignored");
    const builtIn = section?.["hideBuiltInPresets"] === true && custom.length > 0 ? [] : PROVIDER_PRESETS;
    const ids = new Set(custom.map((p) => p.id));
    return [...custom, ...builtIn.filter((p) => !ids.has(p.id))];
}

/** The preset a first-time user starts from: the deployment's `defaultPreset`, else the first. */
export function defaultPreset(): ProviderPreset {
    const presets = providerPresets();
    const wanted = DeploymentConfig.section("ai")?.["defaultPreset"];
    return presets.find((p) => p.id === wanted) ?? presets[0];
}

/** The preset a saved configuration was made from: same provider and endpoint, else same provider. */
export function presetFor(config: Pick<LLMConfig, "provider" | "baseURL">): ProviderPreset | undefined {
    const presets = providerPresets().filter((p) => p.provider === config.provider);
    const trim = (url?: string) => url?.replace(/\/+$/, "");
    return presets.find((p) => trim(p.baseURL) === trim(config.baseURL)) ?? presets[0];
}

/**
 * Whether a request never got an answer: no network, DNS, a blocked or refused connection (the
 * provider SDKs' `APIConnectionError` / `APIConnectionTimeoutError`, or fetch's `TypeError`). On a
 * LAN without internet access the public APIs always end up here.
 */
export function isUnreachableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error instanceof TypeError) return true;
    // By class name, so this module doesn't load the SDKs (the build keeps class names).
    for (let proto = Object.getPrototypeOf(error); proto; proto = Object.getPrototypeOf(proto)) {
        if (proto.constructor?.name === "APIConnectionError") return true;
    }
    return false;
}

const STORAGE_KEY = "ai.config";

/**
 * The API key never touches persistent storage: it lives in this module for the
 * current session, and long-term keeping is delegated to the browser's password
 * manager (the settings panel is a real login-style form).
 */
let sessionApiKey = "";

/** Older versions persisted the key in plain text; migrate it out on first read. */
type StoredConfig = Omit<LLMConfig, "apiKey"> & { apiKey?: string };

export function loadConfig(): LLMConfig | undefined {
    const saved = ObjectStorage.default.value<StoredConfig>(STORAGE_KEY);
    if (!saved) return undefined;
    if (saved.apiKey) {
        sessionApiKey = saved.apiKey;
        persist(saved);
    }
    return {
        provider: saved.provider,
        baseURL: saved.baseURL,
        model: saved.model,
        apiKey: sessionApiKey,
    };
}

export function saveConfig(config: LLMConfig): void {
    sessionApiKey = config.apiKey;
    persist(config);
}

function persist(config: StoredConfig): void {
    const { apiKey: _apiKey, ...rest } = config;
    ObjectStorage.default.setValue(STORAGE_KEY, rest);
}
