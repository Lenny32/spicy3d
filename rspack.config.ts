import { resolve } from "node:path";
import { defineConfig } from "@rspack/cli";
import rspack from "@rspack/core";
import { TsCheckerRspackPlugin } from "ts-checker-rspack-plugin";
import packages from "./package.json" with { type: "json" };

const isProduction = process.env.NODE_ENV === "production";
const configDir = import.meta.dirname;
// Where the MCP panel links the standalone bridge executables. Forks and self-hosters that publish
// their own releases set SPICY3D_BRIDGE_DOWNLOAD_URL (a folder URL ending in "/") at build time.
const mcpBridgeDownloadUrl =
    process.env["SPICY3D_BRIDGE_DOWNLOAD_URL"] ??
    `https://github.com/Lenny32/spicy3d/releases/download/${packages.version}/`;

export default defineConfig({
    devtool: isProduction ? false : "source-map",
    entry: {
        main: "./packages/web/src/index.ts",
    },
    experiments: {
        css: true,
    },
    // The CLI turns lazy compilation on for dev by default; its empty trigger responses
    // log "XML Parsing Error: no root element found" in Firefox.
    lazyCompilation: false,
    module: {
        parser: {
            "css/auto": {
                namedExports: false,
                // Theme variables and properties set from JS are shared across modules.
                dashedIdents: false,
            },
        },
        rules: [
            {
                test: /\.css$/,
                type: "css/auto",
            },
            {
                test: /\.wasm$/,
                type: "asset",
            },
            {
                // The PlaneGCS emscripten glue resolves its own files at runtime
                // (`new URL("./", import.meta.url)`); keep rspack from bundling that.
                // Its node-only branch imports node builtins the browser never reaches.
                test: /planegcs[\\/]dist[\\/]planegcs_dist[\\/]planegcs\.js$/,
                parser: { url: false },
                resolve: { fallback: { module: false, fs: false, path: false, url: false } },
            },
            {
                test: /\.cur$/,
                type: "asset",
            },
            {
                test: /\.jpg$/,
                type: "asset",
            },
            {
                test: /\.(j|t)s$/,
                loader: "builtin:swc-loader",
                options: {
                    jsc: {
                        parser: {
                            syntax: "typescript",
                            decorators: true,
                        },
                        target: "esnext",
                    },
                    collectTypeScriptInfo: {
                        exportedEnum: isProduction,
                    },
                },
            },
        ],
    },
    resolve: {
        extensions: [".ts", ".js", ".json", ".wasm"],
    },
    plugins: [
        new TsCheckerRspackPlugin(),
        new rspack.CircularDependencyRspackPlugin({
            failOnError: true,
            exclude: /node_modules/,
        }),
        new rspack.CopyRspackPlugin({
            patterns: [
                {
                    from: resolve(configDir, "public"),
                    globOptions: {
                        ignore: ["**/**/index.html"],
                    },
                },
            ],
        }),
        new rspack.DefinePlugin({
            __APP_VERSION__: JSON.stringify(packages.version),
            __IS_PRODUCTION__: JSON.stringify(process.env.NODE_ENV === "production"),
            __MCP_BRIDGE_DOWNLOAD_URL__: JSON.stringify(mcpBridgeDownloadUrl),
        }),
        new rspack.HtmlRspackPlugin({
            template: resolve(configDir, "public/index.html"),
            inject: "body",
        }),
    ],
    optimization: {
        minimizer: [
            new rspack.SwcJsMinimizerRspackPlugin({
                minimizerOptions: {
                    mangle: {
                        keep_classnames: true,
                        keep_fnames: true,
                    },
                },
            }),
            new rspack.LightningCssMinimizerRspackPlugin(),
        ],
    },
    output: {
        clean: true,
    },
});
