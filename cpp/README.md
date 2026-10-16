# spicy3d's WebAssembly Module

## Clone and install all dependencies

When compiling for the first time, or if the build directory has been deleted or dependencies have been updated, please execute this command

```bash
npm run setup:wasm
```

If you see **Setup complete**, it means it was successful. Otherwise, please check the logs and try again.

## Compile

To build the current project, please execute

```bash
npm run build:wasm
```

After the compilation is completed, the target will be copied to the **packages/wasm/lib** directory.

### Kernel regression tests

The standalone OCCT tests call the loft thickening recovery helper directly, so a successful
normal offset cannot hide a regression in the retry. After setting up the WASM toolchain, run
these commands from `cpp/`:

```bash
cmake --preset release -DSPICY_KERNEL_TESTS=ON
cmake --build build/target/release --target loft-thicken-test
ctest --test-dir build/target/release --output-on-failure
```

### C++ exceptions

OCCT reports failures by throwing `Standard_Failure` subclasses. The Release build uses native
WebAssembly exception handling (`-fwasm-exceptions`, for the OCCT sources, the bindings and the link
alike — see `CMakeLists.txt`), so these throws can be caught: every binding entry goes through
`guardedEntry` (`src/guard.hpp`), which turns a raise into the error channel of its return type — an
error result (`isOk: false`, `error: "<Class.function>: <message>"`), `undefined` for optional
results, or a thrown JS `Error` for plain values. Without it (the former
`-sDISABLE_EXCEPTION_CATCHING=1`) every raise aborted the whole module (`RuntimeError: Aborted(...)`).

Native exception handling was chosen over Emscripten's JS-based handling
(`-sDISABLE_EXCEPTION_CATCHING=0` / `EXCEPTION_CATCHING_ALLOWED`): it costs next to nothing while
nothing is thrown and needs no list of catching functions; every current browser supports it. The
Debug build keeps the JS-based handling. The preventive guards in the query code (`IsNull`,
`IsGeometric`, `IsDone` prechecks) stay: they give clearer messages than the raise they avoid, and
they remain the safety net for a module built without the guard.

### Release artifact

`packages/wasm/lib/spicy-wasm.{wasm,js}` are not committed (#191): `packages/wasm/wasm.lock.json`
pins the GitHub release `wasm-<inputs>` holding them and their sha256, where `<inputs>` is the hash
of everything they are built from (every file of `cpp/` but `build/` and `*.md`, and the Emscripten / OCCT
pins in `scripts/setup_wasm_deps.mjs`; `node scripts/wasm-artifact.mjs inputs`). `spicy-wasm.d.ts`
stays committed, pinned by the lock too. `npm install` (and `dev`, `build`, `test`) runs
`scripts/fetch-wasm.mjs`, which puts the pinned files in place and checks their hash: no network
when they are there, a download (shared cache `~/.cache/spicy3d-wasm`, or `SPICY3D_WASM_DIR` for a
machine without internet access) otherwise, and an error, never another kernel, when that fails.

After changing C++, `npm run build:wasm` installs your build into `packages/wasm/lib/`; the fetch
script leaves it there (`npm run fetch:wasm -- --force` goes back to the pinned one). Push the
sources only: on the pull request the WASM workflow (`.github/workflows/wasm.yml`) sees new inputs,
builds the kernel (Release preset, `cpp/build` cached per branch), publishes the release, commits
the lock and the new `.d.ts` to the branch and runs the checks again. It never builds on `develop`
or `main`, where a stale lock fails the check. `npm run wasm:check` tells whether the lock matches
the sources.

The pinned kernel is built from the current sources (Release preset, Emscripten 5.0.7, OCCT
V8_0_1, 2026-10-16): `guard.hpp`, `-fwasm-exceptions` and every binding, including
`ShapeFactory.bspline`, `Shape.checkSelfIntersection` and the free-form crease envelope of
`ShapeFactory.makeThickSolidTolerant` (`thickEnvelope.hpp`). The TypeScript side still
feature-detects the newer bindings, and the tests of those fallbacks stub the binding absent
instead of relying on an older binary.
