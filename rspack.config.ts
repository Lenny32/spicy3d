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

// `SPICY3D_API_URL=http://localhost:5080 npm run dev`: the dev server proxies the SpicySrv paths to
// that server, so the app and the API share one origin (the dev server's) like behind SpicySrv's
// Caddy: the session cookie, the CSRF Origin check and email links all work. Start the server with
// `Spicy__PublicUrl=http://localhost:8080` (README.md, Development with a server). Unset: no proxy,
// `/api/config` is the placeholder in public/ and the app stays local-only.
const apiUrl = process.env["SPICY3D_API_URL"]?.trim();
/** SpicySrv's paths (its deploy/Caddyfile): `/api/*`, `/ws/*` and `/mcp`, `/mcp/*`. */
const isServerPath = (pathname: string) =>
    // Exactly `/ws` stays the dev server's own live-reload socket; the server's are `/ws/<name>`.
    /^\/api(\/|$)/.test(pathname) || /^\/ws\/./.test(pathname) || /^\/mcp(\/|$)/.test(pathname);

export default defineConfig({
    devtool: isProduction ? false : "source-map",
    entry: {
        main: "./packages/web/src/index.ts",
    },
    experiments: {
        css: true,
    },
    devServer: {
        // Account email links point at app routes (`/verify-email?…`, `/reset-password?…`,
        // `/confirm-email-change?…`); like docker/default.conf.template, they serve the app.
        historyApiFallback: {
            rewrites: [
                { from: /^\/(verify-email|reset-password|confirm-email-change)\/?$/, to: "/index.html" },
            ],
        },
        ...(apiUrl && {
            proxy: [
                {
                    pathFilter: isServerPath,
                    target: apiUrl,
                    // WebSockets too: /ws/events (sync), /ws/mcp-page (remote MCP).
                    ws: true,
                    // Host and Origin pass unchanged (the dev server's), as behind SpicySrv's Caddy: the
                    // server compares Origin with Spicy__PublicUrl, and a Host rewritten to the target
                    // (changeOrigin) would trip its host filtering for e.g. http://127.0.0.1:5080.
                },
            ],
        }),
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
                        // With a proxied server, the dev server's own output would answer
                        // /api/config before the proxy does: leave the placeholder out.
                        ignore: ["**/**/index.html", ...(apiUrl ? ["**/api/**"] : [])],
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
