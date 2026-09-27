# Deploying Spicy3D (LAN now, public later)

One build of the web app runs everywhere: static hosting without a server (local documents only), a
LAN-only SpicySrv without internet access, and a public HTTPS host. Nothing about the server is baked
into the build (CLOUD-16):

- **The server is the page's own origin.** The app looks for `GET <app folder>/api/config`; a
  Spicy3D answer turns the cloud on, anything else (the `public/api/config` placeholder, a 404) keeps
  it local-only. SpicySrv's reverse proxy serves the app and the API on one origin
  (`SPICY_PUBLIC_URL`).
- **Per-deployment settings live in `deployment.json`**, next to `index.html`, read at every start
  (`public/deployment.json` = `{}` = the defaults). Replace the file, no rebuild.
- **No request to another origin** unless the user asks for one (an LLM endpoint picked in the
  assistant, a download link): `npm run check:urls` fails on a new external URL in the sources or
  the build, and `npm run smoke` runs the build in Chromium with every other origin blocked.

## `deployment.json`

```json
{
    "mcpBridge": { "downloadUrl": "downloads/mcp-bridge/bin/" },
    "ai": {
        "presets": [
            {
                "id": "company",
                "label": "Company LLM",
                "provider": "completions",
                "baseURL": "https://llm.example.lan/v1",
                "defaultModel": "qwen3"
            }
        ],
        "defaultPreset": "company",
        "hideBuiltInPresets": true
    }
}
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `mcpBridge.downloadUrl` | the release of this version on GitHub (build-time `SPICY3D_BRIDGE_DOWNLOAD_URL`) | Folder the MCP panel links the bridge executables from (`spicy3d-mcp-bridge-<os>-<cpu>[.exe]`); relative = the app's folder. |
| `ai.presets` | none | Endpoints offered first in the assistant's settings: `id`, `label`, `provider` (`anthropic`, `completions`, `responses`), `baseURL`, `defaultModel`. Invalid entries are ignored. |
| `ai.defaultPreset` | the first preset | The preset a first-time user starts from. |
| `ai.hideBuiltInPresets` | `false` | Hide the public Anthropic/OpenAI presets (only with at least one valid preset of your own). |

A missing or invalid file changes nothing (a warning in the console). Once the assistant cannot
reach its endpoint it says so and points at the settings.

## The web image (`spicy3d-web`)

`Dockerfile` builds the app and serves it with `nginxinc/nginx-unprivileged`, as SpicySrv's
compose expects its `web` service: HTTP on **port 8080**, a **non-root** user, nothing written
outside `/tmp` (runs with a read-only root file system and no capabilities).

```sh
docker build -t spicy3d-web:0.0.1 .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL spicy3d-web:0.0.1   # alone: local-only
```

The GitHub workflow **Web image** (manual) builds `spicy3d-web:<version>`, smoke-tests it running like
that, and keeps it as a run artifact (`spicy3d-web-<version>.tar.gz` for `docker load`, plus the plain
`dist/` tarball); with `publish = ghcr` it also pushes `ghcr.io/<owner>/spicy3d-web:<version>`. The tag
is the server's `SPICY_VERSION`.

`docker/nginx.conf`:

- the app routes of account email links (`/verify-email`, `/reset-password`, `/confirm-email-change`)
  serve `index.html`; everything else is a file or 404;
- `Cache-Control: no-cache` on everything (the bundle's names carry no content hash, and a new
  release must reach browsers at once);
- **its own Content-Security-Policy**. SpicySrv's Caddy sets `SPICY_WEB_CSP` only when the image sends
  none, and that default (`script-src 'self' 'wasm-unsafe-eval'`) stops the app at startup: the OCCT
  module's embind glue needs `'unsafe-eval'` (`new Function`) until it is built with
  `-sDYNAMIC_EXECUTION=0`; inline styles need `style-src 'unsafe-inline'`; the assistant's LLM
  endpoints need `connect-src https:`, the local MCP bridge `ws://127.0.0.1:*`. The smoke test
  serves the build with the policy read from this file, so it fails when the app outgrows it.
  `SPICY_WEB_CSP` on the server therefore has no effect with this image.

To change `deployment.json` or add the bridge executables, mount them (SpicySrv
`deploy/docker-compose.override.yml`):

```yaml
services:
  web:
    volumes:
      - ./web/deployment.json:/usr/share/nginx/html/deployment.json:ro
      - ./web/mcp-bridge:/usr/share/nginx/html/downloads/mcp-bridge/bin:ro   # the release's spicy3d-mcp-bridge-* files
```

## LAN without internet access

1. Serve over **HTTPS**, also on the LAN (SpicySrv `SPICY_TLS=internal` with its CA trusted on each
   client, or a company certificate). Browsers treat `http://<lan-ip>` or `http://<lan-name>` as an
   insecure context: no `crypto.subtle`, Web Locks, clipboard or File System Access, and the server's
   `__Host-`/Secure session cookie is dropped, so every request after signing in would be 401 (the
   server refuses a non-loopback `http://` `SPICY_PUBLIC_URL` for that reason). Opened that way, the
   app shows a banner saying HTTPS is required and keeps working locally.
2. Move the images with `docker save` / `docker load` (SpicySrv `deploy/README.md`).
3. MCP bridge: put the release's executables next to the app and point `mcpBridge.downloadUrl` at
   them (above). The Node.js alternative works too: the page's `npx` command fetches the bridge
   tarball the app serves at `downloads/mcp-bridge/spicy3d-mcp-bridge-<version>.tgz`, which bundles
   its dependencies, so npx needs no npm registry (it needs Node.js 20+ on the machine;
   `--allow-remote=all` is required by npm 12 for a package from a URL).
4. Assistant: offer the on-prem endpoint and hide the public ones (`ai` above).

Check a deployment from a machine with Chromium (certificate errors of an internal CA are ignored):

```sh
npx playwright install chromium-headless-shell
npm run smoke -- --url https://spicy.lan/ --expect-server
```

## Public later

The same image and `deployment.json` work on a public HTTPS host: set the server's
`SPICY_PUBLIC_URL` and TLS (Let's Encrypt), nothing to rebuild. Without a `deployment.json` of your
own the MCP panel links the GitHub release and the assistant offers the public LLM APIs.

## Paths the app and SpicySrv share

SpicySrv's proxy sends `/api/*`, `/ws/*`, `/mcp` and `/mcp/*` to the API and everything else to this
image, so the app must not serve anything under those paths: the npx tarball moved from `mcp/` to
`downloads/mcp-bridge/` for that reason. The dev server proxies the same paths when
`SPICY3D_API_URL` is set (README, Development with a server).
