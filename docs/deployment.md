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
    },
    "security": {
        "pluginOrigins": ["https://plugins.example.lan"],
        "fileOrigins": ["https://models.example.lan"]
    }
}
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `ai.presets` | none | Endpoints offered first in the assistant's settings: `id`, `label`, `provider` (`anthropic`, `completions`, `responses`), `baseURL`, `defaultModel`. Invalid entries are ignored. |
| `ai.defaultPreset` | the first preset | The preset a first-time user starts from. |
| `ai.hideBuiltInPresets` | `false` | Hide the public Anthropic/OpenAI presets (only with at least one valid preset of your own). |
| `security.pluginOrigins` | none | Origins (`https://host[:port]`, `https://*.example.com`) whose plugins load without the trust prompt, signed in or not. The app's own origin always does. Also add them to `SPICY3D_PLUGIN_ORIGINS` (below). |
| `security.fileOrigins` | none | Origins `?url=` / `?model=` may open files from without asking. Any other origin asks every time. Also add them to `SPICY3D_CONNECT_ORIGINS`. |

A missing or invalid file changes nothing (a warning in the console). Once the assistant cannot
reach its endpoint it says so and points at the settings.

## The web image (`spicy3d-web`)

`Dockerfile` serves the app with `nginxinc/nginx-unprivileged`, as SpicySrv's compose expects its
`web` service: HTTP on **port 8080**, a **non-root** user, nothing written outside `/tmp` (runs with a
read-only root file system and no capabilities). Two targets share that hardened runtime stage:

- the default (`docker build .`, `docker compose build`) builds the app from source;
- `prebuilt` packages an already built `dist/` (`--build-context dist=<folder>`): the deploy workflow
  uses it to ship the exact files it tested and deployed to GitHub Pages.

```sh
docker build -t spicy3d-web:0.0.1 .
npm run build && docker build --target prebuilt --build-context dist=./dist -t spicy3d-web:0.0.1 .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL spicy3d-web:0.0.1   # alone: local-only
docker compose pull && docker compose up    # compose.yml: the published image, same options
```

The GitHub workflow **Deploy** (push to `main`, or manual with an optional image version, default
`package.json`'s) builds and tests the app once, deploys that `dist/` to Pages and packages it with
the `prebuilt` target. Job *Test Docker image* runs the image like SpicySrv's compose (read-only,
no capabilities), checks it is not root, the account-link routes, the CSP header and that an invalid
`SPICY3D_PLUGIN_ORIGINS` stops the container, runs `npm run smoke -- --url` against it, and keeps it
as a run artifact (`spicy3d-web-<version>.tar.gz` for `docker load` on a server without registry
access, plus the plain `dist/` tarball and `SHA256SUMS`). Then, from `main` or a tag only, job
*Publish Docker image* (the only one allowed to write packages) pushes the same target for
`linux/amd64` and `linux/arm64` to `ghcr.io/<owner>/<repo>` (`ghcr.io/lenny32/spicy3d`) as `latest`
and `<version>`. The version is the server's `SPICY_VERSION`; SpicySrv's compose runs it as
`spicy3d-web:<version>` (`docker tag ghcr.io/lenny32/spicy3d:<version> spicy3d-web:<version>`, or
`docker load` the artifact). The base images are pinned by digest (multi-arch indexes) and kept
current by Dependabot.

`docker/default.conf.template` (rendered at start into the `/tmp` tmpfs, so the root file system
stays read-only):

- the app routes of account email links (`/verify-email`, `/reset-password`, `/confirm-email-change`)
  serve `index.html`; everything else is a file or 404;
- `Cache-Control: no-cache` on everything (the bundle's names carry no content hash, and a new
  release must reach browsers at once);
- **its own Content-Security-Policy**. SpicySrv's Caddy sets `SPICY_WEB_CSP` only when the image sends
  none, and that default (`script-src 'self' 'wasm-unsafe-eval'`) stops the app at startup: the OCCT
  module's embind glue needs `'unsafe-eval'` (`new Function`) until it is built with
  `-sDYNAMIC_EXECUTION=0`; inline styles need `style-src 'unsafe-inline'`. There is no `https:` wildcard in `connect-src` (CLOUD-17):
  other hosts the page must reach are listed in `SPICY3D_CONNECT_ORIGINS`. The smoke test serves
  the build with the policy read from this file, so it fails when the app outgrows it.
  `SPICY_WEB_CSP` on the server therefore has no effect with this image. Why each relaxation stays,
  and what removes it: [`docs/security.md`](security.md).
- **plugins** are code the user chose to run: `script-src blob:` lets `.spicyplugin` archives run
  (their modules are loaded from blob: URLs). A plugin's import map is not injected as an inline
  `<script type="importmap">` (that would need `'unsafe-inline'`, and a nonce or hash is impossible for
  a static server and arbitrary plugins): the app links the modules itself, rewriting each import of a
  mapped specifier to the blob: URL of that module (`packages/app/src/pluginModules.ts`). Limits: an
  import map with `scopes`, or mapped modules importing each other in a cycle, fall back to the inline
  map and are blocked by this policy; a *served* plugin (a folder URL) with an import map runs from a
  blob: URL, so its `import.meta.url` is not its file's. Served plugins without an import map, like
  the default ones, load as before.
- `SPICY3D_PLUGIN_ORIGINS` (container environment, default empty): space-separated origins plugins may
  be loaded from besides the app's own (`?plugin=`, the plugin manager, trusted domains), e.g.
  `SPICY3D_PLUGIN_ORIGINS="https://plugins.example.lan https://*.example.com"`. They are added to
  `script-src`, `connect-src` (manifest, CSS) and `img-src` (icons). Anything that is not an origin
  (`scheme://host[:port]`) stops the container at start (`docker/19-spicy3d-plugin-origins.sh`).
- `SPICY3D_CONNECT_ORIGINS` (container environment, default empty): space-separated `https://` /
  `wss://` origins the page may connect to besides its own: the assistant's LLM endpoints
  (`https://api.anthropic.com https://api.openai.com` for the public presets, or the on-prem one
  from `ai.presets`) and hosts `?url=` opens files from. Checked like `SPICY3D_PLUGIN_ORIGINS`.
- `absolute_redirect off`: a redirect (a folder without its trailing slash) keeps the address the
  browser used, not nginx's own port behind the proxy.

To change `deployment.json`, mount it (SpicySrv
`deploy/docker-compose.override.yml`):

```yaml
services:
  web:
    environment:
      SPICY3D_PLUGIN_ORIGINS: https://plugins.example.lan   # optional, see above
      SPICY3D_CONNECT_ORIGINS: https://llm.example.lan      # optional: the assistant's endpoint
    volumes:
      - ./web/deployment.json:/usr/share/nginx/html/deployment.json:ro
```

## LAN without internet access

1. Serve over **HTTPS**, also on the LAN (SpicySrv `SPICY_TLS=internal` with its CA trusted on each
   client, or a company certificate). Browsers treat `http://<lan-ip>` or `http://<lan-name>` as an
   insecure context: no `crypto.subtle`, Web Locks, clipboard or File System Access, and the server's
   `__Host-`/Secure session cookie is dropped, so every request after signing in would be 401 (the
   server refuses a non-loopback `http://` `SPICY_PUBLIC_URL` for that reason). Opened that way, the
   app shows a banner saying HTTPS is required and keeps working locally.
2. Move the images with `docker save` / `docker load` (SpicySrv `deploy/README.md`).
3. MCP: nothing to install on the clients' side — they connect to the server's `/mcp` with a
   personal access token (the MCP panel shows the configs once signed in).
4. Assistant: offer the on-prem endpoint and hide the public ones (`ai` above), and allow the page to
   reach it (`SPICY3D_CONNECT_ORIGINS`).

Check a deployment from a machine with Chromium (certificate errors of an internal CA are ignored):

```sh
npx playwright install chromium-headless-shell
npm run smoke -- --url https://spicy.lan/ --expect-server
```

## Public later

The same image and `deployment.json` work on a public HTTPS host: set the server's
`SPICY_PUBLIC_URL` and TLS (Let's Encrypt), nothing to rebuild. Without a `deployment.json` of your
own the assistant offers the public LLM APIs.

## Paths the app and SpicySrv share

SpicySrv's proxy sends `/api/*`, `/ws/*`, `/mcp` and `/mcp/*` to the API and everything else to this
image, so the app must not serve anything under those paths. The dev server proxies the same paths when
`SPICY3D_API_URL` is set (README, Development with a server).
