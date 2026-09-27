# CLOUD-01: Rename to Spicy3D & Restart Versioning

## Summary

Rename the application from Chili3D to **Spicy3D** in every layer — UI, npm packages, MCP surface, storage keys, WASM, C++, CI, repository — and restart versioning at `0.0.1` with document format `1`. It is treated as a new application: no compatibility with Chili3D files or local data.

## Scope

### Identifiers (from a scan of the repo — ~1100 files mention "chili")

| Current | New | Notes |
|---------|-----|-------|
| `@chili3d/*` (core, core/test-utils, element, wasm, parametric, ai, mcp-bridge, ui, three, app, i18n, builder, storage, web) | `@spicy3d/*` | `package.json` names, all imports, `tsconfig` paths, rstest/rspack aliases |
| `Constants.DBName = "chili3d-db"` (`packages/core/src/constants.ts:5`) | `"spicy3d-db"` | Clean start — old local documents are not migrated |
| localStorage keys `chili3d.app.ai.config`, `chili3d.app.mcp.settings`, others with `chili3d` prefix | `spicy3d.*` | Grep all `localStorage`/`sessionStorage` keys |
| MCP server name `chili3d` (`MCP_SERVER_NAME`), tool `chili3d_connect`, URIs `chili3d://document`, `chili3d://guide/usage`, `chili3d://skill/*` | `spicy3d`, `spicy3d_connect`, `spicy3d://…` | Also update `buildMcpInstructions()`, skills text and tool descriptions that say "Chili3D" |
| Bridge package/binaries `chili3d-mcp-bridge`, `chili3d-mcp-bridge-{windows,linux,macos}-{x64,arm64}`, tarball `chili3d-mcp-bridge-<v>.tgz` | `spicy3d-mcp-bridge…` | `scripts/build-mcp-bridge-binaries.mjs`, `scripts/pack-mcp-bridge.mjs`, `.github/workflows/package-mcp-bridge.yml` |
| Env vars `CHILI3D_BRIDGE_TOKEN`, `CHILI3D_BRIDGE_PORT`, `CHILI3D_BRIDGE_NO_TOKEN`, `CHILI3D_BRIDGE_DOWNLOAD_URL`, `CHILI3D_APP_URL`, `CHILI3D_ALLOWED_ORIGINS` | `SPICY3D_*` | No aliases for the old names (clean start) |
| `chili-wasm.{wasm,js,d.ts}`, CMake target, `chili3d-macros` | `spicy-wasm…`, `spicy3d-macros` | `cpp/CMakeLists.txt`, `packages/wasm/lib/`, loaders; C++ namespaces if any |
| DOM ids/custom-element names (`chili3d-main-window`, …) | `spicy3d-…` | Custom element tags must stay unique; check CSS selectors |
| UI strings, page `<title>`, loading screen, About, i18n (`packages/i18n`) | "Spicy3D" | |
| Logo, favicon (`public/favicon.svg`), icon font if it contains the logo | new assets | Need a Spicy3D logo |
| GitHub links `github.com/lenny32/chili3d` (`home.ts:158`, `ribbon.ts:185`) and release download base | new repo URL | See repository rename below |
| `CLAUDE.md`, `README*`, docs, ticket references | "Spicy3D" | |
| File extension for downloaded documents (if any, e.g. `.cd`) | `.spicy` (decide) | Also the MIME type / `accept` on file inputs |

### Versioning

- `package.json` `version` → `0.0.1` (root and all workspace packages, kept in lockstep).
- `documentVersion` (`package.json`, injected as `__DOCUMENT_VERSION__` in `rspack.config.ts:98`) is replaced by the integer document format of CLOUD-02, starting at `1`.
- Release notes/changelog restart; tags start at `v0.0.1`.

### License & attribution (AGPL-3.0 obligations)

Spicy3D is a fork of Chili3D (AGPL-3.0). The rename must **keep** the original copyright notices:

- `LICENSE` stays AGPL-3.0; add a `NOTICE`/README section: "Spicy3D is derived from Chili3D by Xiange Chen and contributors, licensed under AGPL-3.0."
- File header becomes:
  ```ts
  // Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
  // See LICENSE file in the project root for full license information.
  ```
  Update the header rule in `CLAUDE.md` and any Biome/lint check that enforces it. C++ files (LGPL-3.0) keep their license, same attribution line.
- About dialog: "Based on Chili3D" with link, and a link to the Spicy3D source (AGPL §13: users interacting over a network must be offered the source of the modified version).

### Repository

- Rename GitHub repo (`Lenny32/chili3d` → `Lenny32/spicy3d`, decide); GitHub redirects old URLs, but update `origin` remotes, workflows, badges.
- Update `deploy.yml`, `main.yml`, `quality.yml`, `package-mcp-bridge.yml`.

## Approach

1. Scripted rename (`scripts/rename-spicy3d.mjs`, deleted afterwards) with an explicit mapping table — no blind global replace (license text and attribution must survive).
2. `npm install` to regenerate the lockfile with new workspace names.
3. Rebuild WASM (`npm run build:wasm`) and check the new artifact names load.
4. `npm run check`, `npm run test`, `npm run build`, manual smoke test (create/save/open, MCP bridge connect).
5. Final grep: `rg -i chili` must only return attribution lines and the LICENSE.

## Acceptance criteria

- [ ] `rg -i chili` returns only the intentional attribution / license lines.
- [ ] App shows Spicy3D everywhere (title, loading screen, About, home, ribbon).
- [ ] MCP bridge binaries named `spicy3d-mcp-bridge-*`, server name `spicy3d`, tools `spicy3d_*`, resources `spicy3d://*`; an MCP client can connect with a regenerated config.
- [ ] IndexedDB database is `spicy3d-db`; storage keys use `spicy3d.` prefix.
- [ ] Version is `0.0.1` across the workspace; document format is `1`.
- [ ] All tests, lint, build and WASM build pass; CI workflows green.
- [ ] Chili3D attribution present in LICENSE/NOTICE, README, About and file headers.

## Dependencies and complexity

Dependencies: none — do this **first**, before any cloud code is written with old names. Complexity: medium-high (wide but mechanical). One PR, no functional changes mixed in.
