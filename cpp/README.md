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

### Committed binary

`packages/wasm/lib/spicy-wasm.{wasm,js,d.ts}` is built from the current sources (Release preset,
Emscripten 5.0.7, OCCT V8_0_1, 2026-09-30): `guard.hpp`, `-fwasm-exceptions` and every binding,
including `Shape.checkSelfIntersection`. After changing C++, rebuild with
`cmake --build --preset release --target spicy-wasm` (in `cpp/`) and copy the three files from
`build/target/release/` into `packages/wasm/lib/`. The TypeScript side still feature-detects the
newer bindings, and the tests of those fallbacks stub the binding absent instead of relying on an
older binary.
