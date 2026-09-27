// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectStorage } from "@spicy3d/core";

// Nothing in this module may import the MCP SDK: the panel and the startup check load it eagerly,
// and the SDK is a sizeable chunk that only a live bridge session needs.

export const DEFAULT_BRIDGE_PORT = 7777;
/** Where every deployment serves its own bridge package (see scripts/pack-mcp-bridge.mjs). */
export const BRIDGE_TARBALL_PATH = `mcp/spicy3d-mcp-bridge-${__APP_VERSION__}.tgz`;

/** An earlier default, before the bridge was served by the site: treated as "use the default". */
const LEGACY_DEFAULT_COMMAND = "npx -y @spicy3d/mcp-bridge";

/**
 * How the agent starts the bridge by default: npx fetches the package this very site serves, so
 * nobody needs the source, an npm account or a publication — and a fork's site serves its own.
 */
export function defaultBridgeCommand(appUrl: string, windows = isWindowsClient()): string {
    const npx = `npx -y --package=${new URL(BRIDGE_TARBALL_PATH, appUrl)} spicy3d-mcp-bridge`;
    // MCP clients on native Windows spawn without a shell, and npx is a .cmd script there.
    return windows ? `cmd /c ${npx}` : npx;
}

/** The agent runs on the machine this browser runs on, so the browser's OS is the agent's. */
export function isWindowsClient(): boolean {
    return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/** How the agent starts the bridge: a downloaded executable (no Node.js), or npx. */
export type BridgeRunner = "executable" | "node";

export interface BridgePlatform {
    id: string;
    label: string;
    file: string;
}

/** The release executables, as built by scripts/build-mcp-bridge-binaries.mjs. */
export const BRIDGE_PLATFORMS: BridgePlatform[] = [
    { id: "windows-x64", label: "Windows (x64)", file: "spicy3d-mcp-bridge-windows-x64.exe" },
    { id: "macos-arm64", label: "macOS (Apple silicon)", file: "spicy3d-mcp-bridge-macos-arm64" },
    { id: "macos-x64", label: "macOS (Intel)", file: "spicy3d-mcp-bridge-macos-x64" },
    { id: "linux-x64", label: "Linux (x64)", file: "spicy3d-mcp-bridge-linux-x64" },
    { id: "linux-arm64", label: "Linux (arm64)", file: "spicy3d-mcp-bridge-linux-arm64" },
];

export function bridgeDownloadUrl(platform: BridgePlatform): string {
    return `${__MCP_BRIDGE_DOWNLOAD_URL__}${platform.file}`;
}

/**
 * The platforms matching this browser's OS, best guess first. The CPU cannot be read reliably
 * (macOS browsers report "Intel" on Apple silicon too), so an OS keeps all its variants.
 */
export function platformsForThisBrowser(): BridgePlatform[] {
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const os = /Windows/i.test(ua)
        ? "windows"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macos"
          : /Linux/i.test(ua) && !/Android/i.test(ua)
            ? "linux"
            : "";
    return BRIDGE_PLATFORMS.filter((p) => p.id.startsWith(`${os}-`));
}

/** Stands in for the executable's location in the snippets until the user types the real one. */
export function executablePlaceholder(windows = isWindowsClient()): string {
    return windows ? "C:\\path\\to\\spicy3d-mcp-bridge-windows-x64.exe" : "/path/to/spicy3d-mcp-bridge";
}

export interface McpSettings {
    port: number;
    /** Off only on the user's explicit choice: without a token any local program can drive the tab. */
    requireToken: boolean;
    token: string;
    runner: BridgeRunner;
    /** Full path of the downloaded executable, for the "executable" runner. */
    executablePath: string;
    /**
     * The "node" runner's command; empty means `defaultBridgeCommand` for this page. Set it to use
     * a published npm package or a local `node …/cli.mjs`. Only fills in the snippets.
     */
    bridgeCommand: string;
    autoConnect: boolean;
}

const STORAGE_KEY = "mcp.settings";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 128 random bits as hex: long enough that guessing it over a local socket is hopeless. */
export function generateToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function defaultSettings(): McpSettings {
    return {
        port: DEFAULT_BRIDGE_PORT,
        requireToken: true,
        token: generateToken(),
        runner: "executable",
        executablePath: "",
        bridgeCommand: "",
        autoConnect: false,
    };
}

/**
 * The saved settings, or fresh defaults (with a new token) the first time. The token is kept in
 * the browser's storage on purpose: it is a local pairing secret the page must present on every
 * reconnect, not a credential for any remote service.
 */
export function loadMcpSettings(): McpSettings {
    const saved = ObjectStorage.default.value<Partial<McpSettings>>(STORAGE_KEY);
    const defaults = defaultSettings();
    const settings: McpSettings = {
        port: saved?.port ?? defaults.port,
        requireToken: saved?.requireToken ?? defaults.requireToken,
        token: saved?.token ?? defaults.token,
        // Settings from before the executables existed only had a command: keep a customized one.
        runner:
            saved?.runner ??
            (saved?.bridgeCommand && saved.bridgeCommand !== LEGACY_DEFAULT_COMMAND
                ? "node"
                : defaults.runner),
        executablePath: saved?.executablePath ?? "",
        bridgeCommand: saved?.bridgeCommand === LEGACY_DEFAULT_COMMAND ? "" : (saved?.bridgeCommand ?? ""),
        autoConnect: saved?.autoConnect ?? defaults.autoConnect,
    };
    if (settings.requireToken && !settings.token) settings.token = generateToken();
    if (!saved) saveMcpSettings(settings);
    return settings;
}

export function saveMcpSettings(settings: McpSettings): void {
    ObjectStorage.default.setValue(STORAGE_KEY, settings);
}

export function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The WebSocket address of the bridge these settings describe. */
export function bridgeUrlFor(settings: McpSettings): string {
    const base = `ws://127.0.0.1:${settings.port}/`;
    return settings.requireToken ? `${base}?token=${encodeURIComponent(settings.token)}` : base;
}

/**
 * The bridge URL from `?mcp=` or the settings, or undefined when it is not a plain WebSocket on
 * this machine. Anything else is refused: a crafted link pointing `?mcp=` at a remote host would
 * hand that host the user's open document and full control of the editor.
 */
export function parseBridgeUrl(raw: string): URL | undefined {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    return url;
}

/**
 * The bridge's command-line arguments for this page: its address (which the bridge also accepts as
 * the only allowed origin), the port, and whether a token is required.
 */
export function bridgeArgs(settings: McpSettings, appUrl: string): string[] {
    const args = ["--app-url", appUrl];
    if (settings.port !== DEFAULT_BRIDGE_PORT) args.push("--port", String(settings.port));
    if (!settings.requireToken) args.push("--no-token");
    return args;
}

/**
 * The token travels as an environment variable rather than an argument, so it does not show up
 * in the process list other users of the machine can read.
 */
export function bridgeEnv(settings: McpSettings): Record<string, string> {
    return settings.requireToken ? { SPICY3D_BRIDGE_TOKEN: settings.token } : {};
}

/** Split a command line on spaces, keeping "double-quoted parts" together. */
export function splitCommand(command: string): string[] {
    return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Quote an argument for the terminal the user pastes the command into, when it needs quoting.
 *
 * POSIX shells get single quotes, inside which nothing is special; an embedded `'` closes the
 * quote, adds a double-quoted `'`, and reopens. Windows (PowerShell or cmd) gets double quotes,
 * with an embedded `"` doubled. Backslashes are literal there, except a run of them that ends at a
 * quote: the Windows argument parser halves it (reading `\"` as an escaped quote), so such a run,
 * before an embedded quote or before the closing one, is doubled.
 */
export function shellArg(value: string, windows = isWindowsClient()): string {
    if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
    if (!windows) return `'${value.replaceAll("'", `'"'"'`)}'`;
    let escaped = "";
    let slashes = 0;
    for (const char of value) {
        if (char === "\\") {
            slashes++;
            continue;
        }
        const run = "\\".repeat(char === '"' ? slashes * 2 : slashes);
        escaped += run + (char === '"' ? '""' : char);
        slashes = 0;
    }
    return `"${escaped}${"\\".repeat(slashes * 2)}"`;
}

export function resolveBridgeCommand(
    settings: McpSettings,
    appUrl: string,
    windows = isWindowsClient(),
): string {
    if (settings.runner === "executable") {
        // Quoted so a path with spaces stays one argument through splitCommand.
        return `"${settings.executablePath || executablePlaceholder(windows)}"`;
    }
    return settings.bridgeCommand || defaultBridgeCommand(appUrl, windows);
}

/** False while the snippets still carry the placeholder instead of the executable's real path. */
export function isCommandComplete(settings: McpSettings): boolean {
    return settings.runner !== "executable" || settings.executablePath.trim() !== "";
}

export function claudeCodeCommand(settings: McpSettings, appUrl: string): string {
    const env = Object.entries(bridgeEnv(settings)).map(([k, v]) => `-e ${shellArg(`${k}=${v}`)}`);
    const command = [
        ...splitCommand(resolveBridgeCommand(settings, appUrl)),
        ...bridgeArgs(settings, appUrl),
    ];
    return ["claude mcp add spicy3d", ...env, "--", ...command.map((arg) => shellArg(arg))].join(" ");
}

export function mcpJsonConfig(settings: McpSettings, appUrl: string): string {
    const [command, ...args] = splitCommand(resolveBridgeCommand(settings, appUrl));
    const env = bridgeEnv(settings);
    const server = {
        command,
        args: [...args, ...bridgeArgs(settings, appUrl)],
        ...(Object.keys(env).length > 0 && { env }),
    };
    return JSON.stringify({ mcpServers: { spicy3d: server } }, null, 2);
}

/** Whether this page is served from this machine; a hosted page meets extra browser checks. */
export function isLoopbackPage(): boolean {
    return LOOPBACK_HOSTS.has(location.hostname);
}

/** This page's address as the bridge should know it: origin plus path, no query or hash. */
export function currentAppUrl(): string {
    return `${location.origin}${location.pathname}`;
}
