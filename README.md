# Spicy3D

A 3D CAD application that runs in the browser. OpenCascade (OCCT) is compiled to WebAssembly for the modeling kernel and Three.js does the rendering, so there is nothing to install.

![Screenshot](./screenshots/screenshot.png)

## About this fork

Spicy3D is derived from Chili3D by Xiange Chen and contributors, licensed under AGPL-3.0. It started as a fork of [xiangechen/chili3d](https://github.com/xiangechen/chili3d). It is no longer kept in sync with upstream: we are taking it in our own direction, and changes are not sent back. Expect the two to drift further apart over time.

If you want the original project, its website ([chili3d.com](https://chili3d.com)), its releases or its author, go upstream. Please don't report issues from this fork there.

What we have added so far:

- A 2D sketch solver based on PlaneGCS, used by the parametric sketch module
- An MCP server that runs inside the page, plus a small bridge program (`packages/mcp-bridge`) so Claude Code, Claude Desktop, Cursor and other MCP clients can drive the open document. See the [bridge README](packages/mcp-bridge/README.md).
- A ribbon laid out like Fusion 360's, with context-aware shortcuts
- An adaptive background grid in the viewport
- CI: lint, typecheck, CodeQL, Semgrep and a dependency audit on pull requests to `develop` and `main`; the test suite runs on pull requests to `main`

## Features

Most of this comes from upstream.

- Primitives: box, cylinder, cone, sphere, pyramid, torus and more
- Sketching: lines, arcs, circles, ellipses, rectangles, polygons, Bézier curves
- Parametric bodies built from an ordered feature list, re-evaluated when anything upstream changes
- Booleans, extrude, revolve, sweep, loft, offset, thick solid, linear and circular arrays
- Chamfer, fillet, trim, break, split, sew, simplify, feature removal, explode
- Move, rotate, mirror
- Snapping to points, edges, faces and the workplane, with axis tracking
- Length, angle, area and volume measurement
- STEP, IGES, BREP and STL import/export
- Undo/redo, documents stored in IndexedDB
- Plugins loaded at runtime with `?plugin=<url>` (examples in `plugins/`: hello world in JS and TS, macros, a node-based visual programming editor)
- UI in English

## Getting started

You need Node.js and npm.

```bash
git clone https://github.com/Lenny32/spicy3d.git
cd spicy3d
npm install
npm run dev     # http://localhost:8080
```

Other scripts:

```bash
npm run build   # production build
npm run test    # tests (Rstest + Happy-DOM); testc for coverage
npm run check   # Biome lint with auto-fix, run it before committing
npm run format  # Biome + clang-format
```

The WebAssembly module is prebuilt and committed. To rebuild it from `cpp/`, run `npm run setup:wasm` once, then `npm run build:wasm`.

With Docker, `docker compose up -d` builds the app and serves it on port 8080.

## Layout

npm workspace under `packages/`:

| Package | What's in it |
|---|---|
| `core` | Interfaces, math, document model, reactive data, `Result`, undo, commands, serialization, plugins |
| `parametric` | Feature-list bodies and the sketch module |
| `wasm` | OCCT shape factory through Emscripten |
| `three` | Viewport, camera, visuals, highlighting, gizmo |
| `element`, `ui` | Custom elements and the app chrome (ribbon, panels, tree, dialogs) |
| `app` | `Application`, body nodes, commands, hotkeys |
| `ai` | In-app assistant tools and the MCP server |
| `mcp-bridge` | stdio ⇄ WebSocket relay for MCP clients |
| `builder` | `AppBuilder`, which wires everything together at startup |
| `i18n`, `storage`, `web` | Translations, IndexedDB, entry point |

Stack: TypeScript, Three.js, OCCT 8 via Emscripten, Rspack, Biome, Rstest.

## Contributing

Issues and pull requests are welcome on this repository. Branch from `develop` and target `develop`. Run `npm run check` and `npm run test` before opening one.

## License

AGPL-3.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The C++ code in `cpp/` is LGPL-3.0 ([cpp/LICENSE-spicy-wasm.txt](cpp/LICENSE-spicy-wasm.txt)).

The code inherited from upstream stays under the copyright of its authors. Commercial licensing of that code is handled by the upstream author, not by this fork.

## Disclaimer

The software is provided as is, without any warranty. You use it at your own risk, including the risk of data loss.
