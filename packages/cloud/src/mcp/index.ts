// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type RemoteMcpLink, setRemoteMcpLink } from "@spicy3d/ai";
import type { CloudConnection } from "../cloud";
import { showCreateToken } from "../ui/accountSettings";
import { accountUiContext } from "../ui/index";

/**
 * A new token for an MCP client: reading the model and editing it, plus the cloud library the
 * server's own tools list (spicy3d_list_documents, spicy3d_document_history — CLOUD-15).
 */
export const MCP_SCOPES = ["mcp:read", "mcp:write", "documents:read"];

/**
 * Remote MCP (CLOUD-14): while someone is signed in to a server with the relay
 * (`/api/config.features.mcp`), hands the MCP module the link it connects this tab with; signing
 * out, an expired session or another user takes it away (the tab leaves the relay). Returns the
 * stop function.
 */
export function startCloudMcp(connection: CloudConnection): () => void {
    const { config, account } = connection;
    const mcp = config.mcp;
    if (!config.features.mcp || !mcp) return () => {};
    const ctx = accountUiContext(connection);

    let link: RemoteMcpLink | undefined;
    let linkedUser: string | undefined;
    const sync = () => {
        const user = account.status === "signedIn" ? account.user : undefined;
        if (!user) {
            link = undefined;
            linkedUser = undefined;
        } else if (user.id !== linkedUser) {
            linkedUser = user.id;
            link = {
                endpoint: mcp.endpoint,
                pageSocket: mcp.pageSocket,
                userName: user.displayName || user.email,
                deviceName: () => account.deviceSettings.effectiveDeviceName,
                checkSession: async () => {
                    await account.refresh();
                    return account.status === "signedIn" && account.user?.id === user.id;
                },
                createToken: () => void showCreateToken(ctx, () => {}, { scopes: MCP_SCOPES }),
            };
        }
        setRemoteMcpLink(link);
    };
    const onChanged = (property: string | number | symbol) => {
        if (property === "status" || property === "user") sync();
    };
    account.onPropertyChanged(onChanged);
    sync();
    return () => {
        account.removePropertyChanged(onChanged);
        setRemoteMcpLink(undefined);
    };
}
