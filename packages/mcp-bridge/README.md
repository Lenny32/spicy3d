# @spicy3d/mcp-bridge

Lets any MCP client (Claude Code, Claude Desktop, Cursor, …) drive Spicy3D open in your browser, whether Spicy3D runs on your machine or on a server.

The MCP server runs **inside the Spicy3D page**, over the same tools as the in-app assistant, so your document never leaves the browser. A web page cannot accept connections, so this bridge is the small stdio program your MCP client starts: it relays JSON-RPC to the page over a WebSocket on `127.0.0.1`.

```
MCP client ──stdio──> spicy3d-mcp-bridge ──ws://127.0.0.1:7777──> Spicy3D page (any host, e.g. https://cad.example.com)
```

Nothing to clone or build. Get the bridge either way:

- **Standalone executable** (nothing else to install): download it for your platform from the [release](https://github.com/Lenny32/spicy3d/releases) matching your Spicy3D version. The MCP panel links the right files.
- **Node.js 20+**: `npx` fetches the bridge package that every Spicy3D site serves at `mcp/spicy3d-mcp-bridge-<version>.tgz`, or from npm once published.

## Setup

1. Open Spicy3D and click **MCP** in the ribbon. The panel generates a pairing token, links the executable for your OS, and, once you enter where you saved it, shows the exact command for this page:

   ```bash
   claude mcp add spicy3d -e SPICY3D_BRIDGE_TOKEN=<token> -- "C:\Tools\spicy3d-mcp-bridge-windows-x64.exe" --app-url https://cad.example.com/
   ```

   or the JSON block for Claude Desktop, Cursor and other clients:

   ```json
   {
       "mcpServers": {
           "spicy3d": {
               "command": "/Users/me/spicy3d-mcp-bridge-macos-arm64",
               "args": ["--app-url", "https://cad.example.com/"],
               "env": { "SPICY3D_BRIDGE_TOKEN": "<token>" }
           }
       }
   }
   ```

   On macOS and Linux run `chmod +x` on the file once. On macOS, if it is blocked as coming from an unidentified developer, run `xattr -d com.apple.quarantine <file>` (the executables are ad-hoc signed, not notarized).

2. Restart the client (or reload its MCP servers), then press **Connect** in the panel. Tick *Connect automatically* to skip this next time.

Until a page connects, the client sees a single tool, `spicy3d_connect`, which tells the model how to get you connected.

## Options

Flags win over environment variables.

| Flag | Environment | Default | |
|---|---|---|---|
| `-u, --app-url <url>` | `SPICY3D_APP_URL` | `http://localhost:8080/` | Address of the Spicy3D page. Only pages from this origin may connect, so a self-hosted instance or fork sets its own URL here |
| `-p, --port <n>` | `SPICY3D_BRIDGE_PORT` | `7777` | WebSocket port, bound to `127.0.0.1` only |
| `-t, --token <secret>` | `SPICY3D_BRIDGE_TOKEN` | random | Pairing token from the MCP panel. Prefer the environment variable, which stays out of the process list |
| `--no-token` | `SPICY3D_BRIDGE_NO_TOKEN=1` | off | Accept the page without a token (see Security) |
| `--allow-origin <url>` | `SPICY3D_ALLOWED_ORIGINS` (comma-separated) | — | Also accept pages from these origins |

## Browsers

Chrome, Edge and Firefox connect from both local and hosted pages. When the page comes from another machine, Chrome may ask whether the site may access apps and devices on your local network: allow it. Safari blocks a hosted `https` page from reaching `ws://127.0.0.1`, so it is not supported.

## Security

- The page only accepts bridge addresses on `ws://127.0.0.1` / `localhost` / `[::1]`, so a crafted link cannot hand your document to a remote host.
- The bridge refuses pages from origins other than `--app-url` / `--allow-origin`, which stops other websites open in your browser.
- The token stops other programs on your machine. With `--no-token` (and *Require a pairing token* unticked in the panel), any local program that can reach the port can read, change and export the open model. Use it only on a machine you trust.

## Behaviour notes

- Only one page is driven at a time: a newer page replaces the older one.
- Calls run one at a time, in order, because `run_program` refs chain across calls.
- `ask_user` is only listed for clients that support MCP elicitation; the question then appears in the client.

## Releases

`.github/workflows/package-mcp-bridge.yml` builds the five executables as Node.js single executable applications (`scripts/build-mcp-bridge-binaries.mjs`: esbuild bundle injected with postject into each platform's official, checksum-verified Node binary), test-runs each one on its real OS, and packages them with `SHA256SUMS` and the npm tarball.

- **Deploy**: the `Deploy` workflow (`.github/workflows/deploy.yml`, push to `main` or manual run) calls it to build and verify the files as a run artifact only, next to the site it deploys.
- **Manual run**: *Actions > Package MCP bridge > Run workflow* (or `gh workflow run package-mcp-bridge.yml --ref feature/x -f version=0.7.2-rc.1 -f publish=artifact-only`). Pick the branch or tag to build ("Use workflow from"), the version to stamp, and whether to only keep a run artifact, or publish a prerelease or release (created at the built commit). The button appears once the workflow is on the default branch.

The panel links `https://github.com/Lenny32/spicy3d/releases/download/<version>/`; a fork that publishes its own releases builds the site with `SPICY3D_BRIDGE_DOWNLOAD_URL=<its folder URL>/`.

## Developing

From a checkout, point the panel's *Bridge command* at your copy: `node /path/to/spicy3d/packages/mcp-bridge/src/cli.mjs`.
