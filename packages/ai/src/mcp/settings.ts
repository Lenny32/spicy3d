// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectStorage } from "@spicy3d/core";

// Nothing in this module may import the MCP SDK: the panel loads it eagerly, and the SDK is a
// sizeable chunk that only a live relay session needs.

export interface McpSettings {
    /**
     * Remote MCP (CLOUD-14): while signed in to a server with the relay, this tab is reachable by
     * the user's own MCP clients through it (each new session still asks for confirmation).
     */
    remoteEnabled: boolean;
}

const STORAGE_KEY = "mcp.settings";

export function defaultSettings(): McpSettings {
    return { remoteEnabled: true };
}

/**
 * The saved settings, or the defaults. Settings saved by the removed local bridge also held its
 * pairing token: they are rewritten without it.
 */
export function loadMcpSettings(): McpSettings {
    const saved = ObjectStorage.default.value<Record<string, unknown>>(STORAGE_KEY);
    const remoteEnabled = saved?.["remoteEnabled"];
    const settings: McpSettings = {
        remoteEnabled: typeof remoteEnabled === "boolean" ? remoteEnabled : defaultSettings().remoteEnabled,
    };
    if (saved && Object.keys(saved).some((key) => key !== "remoteEnabled")) saveMcpSettings(settings);
    return settings;
}

export function saveMcpSettings(settings: McpSettings): void {
    ObjectStorage.default.setValue(STORAGE_KEY, settings);
}
