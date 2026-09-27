import { resolve } from "node:path";
import { DefinePlugin } from "@rspack/core";
import { defineConfig } from "@rstest/core";
import packages from "./package.json" with { type: "json" };

const configDir = import.meta.dirname;

export default defineConfig({
    // Agent worktrees (`.claude/worktrees/`) are other checkouts of the repository.
    exclude: ["**/cpp/**", "**/.claude/**"],
    coverage: {
        exclude: ["**/wasm/lib/**", "**/test-utils/**"],
    },
    globals: true,
    setupFiles: [resolve(configDir, "packages/core/test-utils/setup.ts")],
    testEnvironment: "happy-dom",
    tools: {
        rspack: {
            plugins: [
                new DefinePlugin({
                    __APP_VERSION__: JSON.stringify(packages.version),
                    __IS_PRODUCTION__: JSON.stringify(process.env.NODE_ENV === "production"),
                }),
            ],
            module: {
                rules: [
                    // Mirror rspack.config.ts: load .wasm as an asset URL instead of a
                    // native webassembly module (which would instantiate at import time).
                    { test: /\.wasm$/, type: "asset" },
                    // The PlaneGCS emscripten glue resolves its own files at runtime
                    // (`new URL("./", import.meta.url)`); keep rspack from bundling that.
                    { test: /planegcs[\\/]dist[\\/]planegcs_dist[\\/]planegcs\.js$/, parser: { url: false } },
                ],
            },
        },
    },
    resolve: {
        alias: {
            "./viewGizmo": resolve(configDir, "packages/three/test/viewGizmo.ts"),
        },
    },
    source: {
        decorators: {
            version: "legacy",
        },
    },
});
