// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export { createMcpPanel, McpPanel } from "./mcp/panel";
export {
    type RemoteAgent,
    type RemoteMcpLink,
    type RemoteMcpSnapshot,
    remoteClientConfigs,
    remoteMcpState,
    setRemoteMcpLink,
} from "./mcp/remote";
export { bridgeUrlFor, loadMcpSettings } from "./mcp/settings";
export { type McpConnectionStatus, type McpStateSnapshot, mcpState } from "./mcp/state";
export {
    type AgentCloudInfo,
    type AgentSaveOutcome,
    type IAgentCloudLink,
    setAgentCloudLink,
} from "./tools/cloudLink";
