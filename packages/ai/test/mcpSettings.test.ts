// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BRIDGE_PLATFORMS,
    bridgeArgs,
    bridgeDownloadUrl,
    bridgeEnv,
    bridgeUrlFor,
    claudeCodeCommand,
    DEFAULT_BRIDGE_PORT,
    generateToken,
    isCommandComplete,
    loadMcpSettings,
    type McpSettings,
    mcpJsonConfig,
    saveMcpSettings,
    shellArg,
    splitCommand,
} from "../src/mcp/settings";

const APP = "https://cad.example.com/";

/** Runs `fn` as if the browser (and so the agent's terminal) were on Windows. */
function asWindows<T>(fn: () => T): T {
    const spy = rs
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    try {
        return fn();
    } finally {
        spy.mockRestore();
    }
}

function settings(patch: Partial<McpSettings> = {}): McpSettings {
    return {
        port: DEFAULT_BRIDGE_PORT,
        requireToken: true,
        token: "abc123",
        runner: "node",
        executablePath: "",
        bridgeCommand: "npx -y @spicy3d/mcp-bridge",
        autoConnect: false,
        ...patch,
    };
}

describe("mcp settings", () => {
    afterEach(() => localStorage.clear());

    test("generates a 128-bit hex token, different every time", () => {
        const a = generateToken();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(generateToken()).not.toBe(a);
    });

    test("first load saves defaults with a token, later loads return the same", () => {
        const first = loadMcpSettings();

        expect(first).toMatchObject({ port: 7777, requireToken: true, autoConnect: false });
        expect(first.token).toMatch(/^[0-9a-f]{32}$/);
        expect(loadMcpSettings()).toEqual(first);
    });

    test("keeps a saved no-token choice", () => {
        saveMcpSettings(settings({ requireToken: false, token: "" }));

        expect(loadMcpSettings()).toMatchObject({ requireToken: false, token: "" });
    });

    test("puts the token in the bridge URL only when one is required", () => {
        expect(bridgeUrlFor(settings())).toBe("ws://127.0.0.1:7777/?token=abc123");
        expect(bridgeUrlFor(settings({ requireToken: false, port: 9000 }))).toBe("ws://127.0.0.1:9000/");
    });

    test("passes the page address, port and token mode as arguments", () => {
        expect(bridgeArgs(settings(), APP)).toEqual(["--app-url", APP]);
        expect(bridgeArgs(settings({ requireToken: false, port: 9000 }), APP)).toEqual([
            "--app-url",
            APP,
            "--port",
            "9000",
            "--no-token",
        ]);
    });

    test("passes the token as an environment variable, and nothing without one", () => {
        expect(bridgeEnv(settings())).toEqual({ SPICY3D_BRIDGE_TOKEN: "abc123" });
        expect(bridgeEnv(settings({ requireToken: false }))).toEqual({});
    });

    test.each([
        ["plain-arg_1.0", "plain-arg_1.0"],
        ["/Users/me/My Tools/bridge", "'/Users/me/My Tools/bridge'"],
        ["$HOME/`x`", "'$HOME/`x`'"],
        ["it's", `'it'"'"'s'`],
    ])("quotes %s for POSIX shells as %s", (value, quoted) => {
        expect(shellArg(value, false)).toBe(quoted);
    });

    test.each([
        ["C:\\My Tools\\bridge.exe", '"C:\\My Tools\\bridge.exe"'],
        ["C:\\My Tools\\", '"C:\\My Tools\\\\"'],
        ['say "hi"', '"say ""hi"""'],
        ['a\\"b c', '"a\\\\""b c"'],
    ])("quotes %s for Windows as %s", (value, quoted) => {
        expect(shellArg(value, true)).toBe(quoted);
    });

    test("splits a command line, keeping quoted parts together", () => {
        expect(splitCommand('node "C:\\My Tools\\cli.mjs" --x')).toEqual([
            "node",
            "C:\\My Tools\\cli.mjs",
            "--x",
        ]);
    });

    test("builds a claude mcp add command that fetches the bridge from npm", () => {
        expect(claudeCodeCommand(settings(), APP)).toBe(
            "claude mcp add spicy3d -e SPICY3D_BRIDGE_TOKEN=abc123 -- npx -y @spicy3d/mcp-bridge --app-url https://cad.example.com/",
        );
        const local = settings({ bridgeCommand: 'node "C:\\My Tools\\cli.mjs"' });
        expect(asWindows(() => claudeCodeCommand(local, APP))).toContain(
            '-- node "C:\\My Tools\\cli.mjs" --app-url',
        );
    });

    test("builds a JSON config clients can paste as is", () => {
        expect(JSON.parse(mcpJsonConfig(settings(), APP))).toEqual({
            mcpServers: {
                spicy3d: {
                    command: "npx",
                    args: ["-y", "@spicy3d/mcp-bridge", "--app-url", APP],
                    env: { SPICY3D_BRIDGE_TOKEN: "abc123" },
                },
            },
        });
        expect(JSON.parse(mcpJsonConfig(settings({ requireToken: false }), APP)).mcpServers.spicy3d).toEqual({
            command: "npx",
            args: ["-y", "@spicy3d/mcp-bridge", "--app-url", APP, "--no-token"],
        });
    });

    test("an old saved bridgePath is dropped in favour of the npm command", () => {
        localStorage.setItem(
            "spicy3d.app.mcp.settings",
            JSON.stringify({ port: 7777, requireToken: true, token: "t", bridgePath: "/x/cli.mjs" }),
        );

        expect(loadMcpSettings()).toEqual({
            port: 7777,
            requireToken: true,
            token: "t",
            runner: "executable",
            executablePath: "",
            bridgeCommand: "",
            autoConnect: false,
        });
    });

    test("by default npx fetches the bridge this site serves, versioned for npx's cache", () => {
        const command = claudeCodeCommand(settings({ bridgeCommand: "" }), "https://cad.example.com/app/");

        expect(command).toBe(
            `claude mcp add spicy3d -e SPICY3D_BRIDGE_TOKEN=abc123 -- npx -y --package=https://cad.example.com/app/mcp/spicy3d-mcp-bridge-${__APP_VERSION__}.tgz spicy3d-mcp-bridge --app-url https://cad.example.com/app/`,
        );
    });

    test("wraps the default npx in cmd /c on Windows, and only the default", () => {
        const windowsUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
        rs.spyOn(navigator, "userAgent", "get").mockReturnValue(windowsUA);
        try {
            expect(
                JSON.parse(mcpJsonConfig(settings({ bridgeCommand: "" }), APP)).mcpServers.spicy3d.command,
            ).toBe("cmd");
            expect(claudeCodeCommand(settings({ bridgeCommand: "" }), APP)).toContain(
                "-- cmd /c npx -y --package=",
            );
            expect(claudeCodeCommand(settings({ bridgeCommand: "node cli.mjs" }), APP)).toContain(
                "-- node cli.mjs",
            );
        } finally {
            rs.restoreAllMocks();
        }
    });

    test("a customized command from before the executables keeps the Node.js runner", () => {
        localStorage.setItem(
            "spicy3d.app.mcp.settings",
            JSON.stringify({ port: 7777, requireToken: true, token: "t", bridgeCommand: "node /x/cli.mjs" }),
        );

        expect(loadMcpSettings()).toMatchObject({ runner: "node", bridgeCommand: "node /x/cli.mjs" });
    });

    test("the executable runner launches the saved path directly, spaces and all", () => {
        const exe = settings({
            runner: "executable",
            executablePath: "C:\\My Tools\\spicy3d-mcp-bridge-windows-x64.exe",
        });

        expect(isCommandComplete(exe)).toBe(true);
        expect(JSON.parse(mcpJsonConfig(exe, APP)).mcpServers.spicy3d).toEqual({
            command: "C:\\My Tools\\spicy3d-mcp-bridge-windows-x64.exe",
            args: ["--app-url", APP],
            env: { SPICY3D_BRIDGE_TOKEN: "abc123" },
        });
        expect(asWindows(() => claudeCodeCommand(exe, APP))).toBe(
            'claude mcp add spicy3d -e SPICY3D_BRIDGE_TOKEN=abc123 -- "C:\\My Tools\\spicy3d-mcp-bridge-windows-x64.exe" --app-url https://cad.example.com/',
        );
    });

    test("without a saved path the executable runner shows a placeholder and says so", () => {
        const exe = settings({ runner: "executable", executablePath: "" });

        expect(isCommandComplete(exe)).toBe(false);
        expect(claudeCodeCommand(exe, APP)).toContain("/path/to/spicy3d-mcp-bridge");
    });

    test("links each platform's executable under the build-time release URL", () => {
        const urls = BRIDGE_PLATFORMS.map(bridgeDownloadUrl);

        expect(urls).toHaveLength(5);
        for (const url of urls) expect(url.startsWith(__MCP_BRIDGE_DOWNLOAD_URL__)).toBe(true);
        expect(urls).toContain(`${__MCP_BRIDGE_DOWNLOAD_URL__}spicy3d-mcp-bridge-windows-x64.exe`);
    });

    test("the earlier npm default is read back as 'follow this site'", () => {
        saveMcpSettings(settings({ bridgeCommand: "npx -y @spicy3d/mcp-bridge" }));

        expect(loadMcpSettings().bridgeCommand).toBe("");
    });
});
