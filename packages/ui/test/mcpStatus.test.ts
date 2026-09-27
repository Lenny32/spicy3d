// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, test } from "@rstest/core";

rs.mock("../src/statusbar/mcpStatus.module.css", () => ({
    indicator: "mcp-indicator",
    dot: "mcp-dot",
}));

// Only the SDK-free state store is needed; the panel half of @spicy3d/ai stays out.
const aiState = rs.hoisted(() => {
    const { McpState } = require("@spicy3d/ai/src/mcp/state");
    return { mcpState: new McpState() };
});
rs.mock("@spicy3d/ai", () => aiState);

import { I18n, PubSub } from "@spicy3d/core";
import { McpStatusIndicator } from "../src/statusbar/mcpStatus";

describe("McpStatusIndicator", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        aiState.mcpState.update({ status: "idle" });
    });

    test.each([
        ["idle", "mcp.status.idle"],
        ["connecting", "mcp.status.connecting"],
        ["connected", "mcp.status.connected"],
        ["offline", "mcp.status.offline"],
    ] as const)("reflects %s state", (status, key) => {
        const indicator = new McpStatusIndicator();
        document.body.append(indicator);
        aiState.mcpState.update({ status });
        expect(indicator.dataset["status"]).toBe(status);
        expect(indicator.title).toBe(I18n.translate(key));
    });

    test("stops tracking state once removed", () => {
        const indicator = new McpStatusIndicator();
        document.body.append(indicator);
        indicator.remove();
        aiState.mcpState.update({ status: "connected" });
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
