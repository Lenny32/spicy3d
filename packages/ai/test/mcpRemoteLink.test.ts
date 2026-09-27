// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { remoteMcpState, setRemoteMcpLink } from "../src/mcp/remote";
import type { RemoteMcpLink } from "../src/mcp/remoteState";
import { defaultSettings, saveMcpSettings } from "../src/mcp/settings";

const PAIRING_KEY = "spicy3d.mcp.pairing";

function link(userName: string): RemoteMcpLink {
    return {
        endpoint: "https://spicy.example.com/mcp",
        pageSocket: "wss://spicy.example.com/ws/mcp-page",
        userName,
        deviceName: () => "Laptop",
        checkSession: async () => true,
        createToken: () => {},
    };
}

function remember() {
    sessionStorage.setItem(
        PAIRING_KEY,
        JSON.stringify({ instance: "tab-1", decisions: [["session-1", "allow"]], blockedTokens: [] }),
    );
}

/** CLOUD-17: pairing decisions never outlive the link (the signed-in user) they were made under. */
describe("setRemoteMcpLink and pairing decisions", () => {
    beforeEach(() => {
        // Remote access off: no page socket, the SDK half is never loaded.
        saveMcpSettings({ ...defaultSettings(), remoteEnabled: false });
    });

    afterEach(() => {
        remoteMcpState.update({ link: undefined, status: "unavailable", agents: [] });
        sessionStorage.clear();
        localStorage.clear();
    });

    test("a first link keeps what this tab already decided", () => {
        remember();
        setRemoteMcpLink(link("Ada"));
        expect(sessionStorage.getItem(PAIRING_KEY)).not.toBeNull();
    });

    test("switching straight to another user's link forgets them", () => {
        setRemoteMcpLink(link("Ada"));
        remember();

        setRemoteMcpLink(link("Grace"));

        expect(remoteMcpState.current.link?.userName).toBe("Grace");
        expect(sessionStorage.getItem(PAIRING_KEY)).toBeNull();
    });

    test("losing the link forgets them", () => {
        setRemoteMcpLink(link("Ada"));
        remember();

        setRemoteMcpLink(undefined);

        expect(sessionStorage.getItem(PAIRING_KEY)).toBeNull();
    });
});
