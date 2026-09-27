// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, test } from "@rstest/core";

rs.mock("../src/statusbar/mcpStatus.module.css", () => ({
    indicator: "mcp-indicator",
    dot: "mcp-dot",
}));

// Only the SDK-free state store is needed; the panel half of @spicy3d/ai stays out.
const aiState = rs.hoisted(() => {
    const { RemoteMcpState, remoteStatusKey } = require("@spicy3d/ai/src/mcp/remoteState");
    return { remoteMcpState: new RemoteMcpState(), remoteStatusKey };
});
rs.mock("@spicy3d/ai", () => aiState);

import { I18n, PubSub } from "@spicy3d/core";
import { McpStatusIndicator } from "../src/statusbar/mcpStatus";

describe("McpStatusIndicator", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        aiState.remoteMcpState.update({ status: "unavailable", signIn: undefined });
    });

    test.each([
        ["idle", "idle", "mcp.remote.status.idle"],
        ["connecting", "connecting", "mcp.remote.status.connecting"],
        ["connected", "connected", "mcp.remote.status.connected"],
        ["offline", "offline", "mcp.remote.status.offline"],
        ["unavailable", "idle", "mcp.remote.status.noServer"],
    ] as const)("reflects the %s state", (status, shown, key) => {
        const indicator = new McpStatusIndicator();
        document.body.append(indicator);
        aiState.remoteMcpState.update({ status });
        expect(indicator.dataset["status"]).toBe(shown);
        expect(indicator.title).toBe(I18n.translate(key));
    });

    test("signed out of a server with MCP, the tooltip says to sign in", () => {
        const indicator = new McpStatusIndicator();
        document.body.append(indicator);
        aiState.remoteMcpState.update({ status: "unavailable", signIn: () => {} });
        expect(indicator.title).toBe(I18n.translate("mcp.remote.status.unavailable"));
    });

    test("stops tracking state once removed", () => {
        const indicator = new McpStatusIndicator();
        document.body.append(indicator);
        indicator.remove();
        aiState.remoteMcpState.update({ status: "connected" });
        expect(indicator.dataset["status"]).toBe("idle");
    });
    test("click toggles the MCP panel", () => {
        const original = PubSub.default.pub;
        const pub = rs.fn((..._args: unknown[]) => {});
        PubSub.default.pub = pub as unknown as typeof PubSub.default.pub;
        try {
            const indicator = new McpStatusIndicator();
            indicator.click();
            expect(pub).toHaveBeenCalledWith("toggleChatPanel");
        } finally {
            PubSub.default.pub = original;
        }
    });
});
