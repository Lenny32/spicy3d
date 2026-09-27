// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { bridgeUrlFor, loadMcpSettings } from "@spicy3d/ai";
import { AppBuilder } from "@spicy3d/builder";
import { type IApplication, Logger, redactUrl } from "@spicy3d/core";
import { Loading } from "./loading";
import { dropSecretParams, parseStartupParams, takeAccountLink } from "./startupParams";

// Before anything reads the URL: an account email link opens its dialog once the cloud is up.
const accountLink = takeAccountLink(window.location, window.history);
const startup = parseStartupParams(window.location.search);
dropSecretParams(window.location, window.history);

const loading = new Loading();
document.body.appendChild(loading);

async function handleApplicaionBuilt(app: IApplication) {
    document.body.removeChild(loading);

    const { plugins, fileUrl, mcpUrl } = startup;
    const mcpSettings = loadMcpSettings();
    if (mcpUrl || mcpSettings.autoConnect) {
        // Loaded on demand: the MCP SDK is a sizeable chunk only bridge sessions need.
        import("@spicy3d/ai/src/mcp")
            .then((mcp) => mcp.connectMcpBridge(mcpUrl ?? bridgeUrlFor(mcpSettings)))
            .catch((err) => Logger.error(`[mcp] failed to start: ${err}`));
    }
    for (const plugin of plugins) {
        Logger.info(`loading plugin from: ${redactUrl(plugin)}`);
        await app.pluginManager.loadFromUrl(plugin);
    }
    if (fileUrl) {
        Logger.info(`loading file from: ${redactUrl(fileUrl)}`);
        await app.loadFileFromUrl(fileUrl);
    }
}

// prettier-ignore
new AppBuilder()
    .useDeploymentConfig()
    .useIndexedDB()
    .useWasmOcc()
    .useParametric()
    .useThree()
    .useUI()
    .useCloud({ accountLink })
    .build()
    .then(handleApplicaionBuilt)
    .catch((err) => {
        alert(err.message);
    });
