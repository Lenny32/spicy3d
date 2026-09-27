// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DeploymentConfig, ExternalContentPolicy, originMatches } from "../src";

const PAGE = "https://spicy.lan/app/index.html";

function verdict(url: string, kind: "plugin" | "file", trusted: string[] = []) {
    return ExternalContentPolicy.evaluate(url, kind, { pageUrl: PAGE, trusted }).verdict;
}

describe("ExternalContentPolicy", () => {
    afterEach(() => {
        DeploymentConfig.reset();
    });

    test("on the page's origin: plugins under the app's plugins/ folder, files under the app's folder", () => {
        expect(verdict("https://spicy.lan/app/plugins/macro/", "plugin")).toBe("allowed");
        expect(verdict("plugins/macro/", "plugin")).toBe("allowed");
        expect(verdict("plugins/macro.spicyplugin", "plugin")).toBe("allowed");
        const decision = ExternalContentPolicy.evaluate("models/box.step", "file", { pageUrl: PAGE });
        expect(decision.verdict === "allowed" && decision.url.href).toBe(
            "https://spicy.lan/app/models/box.step",
        );
        expect(verdict("plugins/macro/", "file")).toBe("allowed");
    });

    test.each([
        ["https://spicy.lan/app/models/x.spicyplugin", "plugin"],
        ["https://spicy.lan/app/plugins/", "plugin"],
        ["https://spicy.lan/other/plugins/x/", "plugin"],
        ["https://spicy.lan/plugins/x/", "plugin"],
        ["https://spicy.lan/other/box.step", "file"],
        // The server's paths: an uploaded blob must never load as a plugin or open unasked.
        ["https://spicy.lan/api/blobs/ab12?x=.spicyplugin", "plugin"],
        ["https://spicy.lan/API/blobs/ab12", "file"],
        ["https://spicy.lan/app/api/blobs/ab12", "file"],
        ["https://spicy.lan/app/plugins/../../api/blobs/ab12", "plugin"],
        ["https://spicy.lan/ws/events", "file"],
        ["https://spicy.lan/mcp", "file"],
    ] as const)("on the page's origin, %s (%s) asks", (url, kind) => {
        expect(verdict(url, kind)).toBe("ask");
    });

    test("an app served from the origin's root: its plugins/ folder, not the server's paths", () => {
        const root = (url: string, kind: "plugin" | "file") =>
            ExternalContentPolicy.evaluate(url, kind, { pageUrl: "https://spicy.lan/" }).verdict;
        expect(root("/plugins/macro/", "plugin")).toBe("allowed");
        expect(root("/models/a.step", "file")).toBe("allowed");
        expect(root("/api/blobs/ab12", "file")).toBe("ask");
        expect(root("/api/blobs/ab12", "plugin")).toBe("ask");
    });

    test("another scheme or port of the same host is another origin", () => {
        expect(verdict("http://spicy.lan/plugins/x/", "plugin")).toBe("ask");
        expect(verdict("https://spicy.lan:8443/plugins/x/", "plugin")).toBe("ask");
    });

    test.each([
        "javascript:alert(1)",
        "data:text/javascript,alert(1)",
        "blob:https://spicy.lan/1234",
        "file:///etc/passwd",
        "ftp://host/x",
        "https://user:pw@spicy.lan/x",
        "http://[bad",
    ])("%s is refused", (url) => {
        expect(verdict(url, "plugin")).toBe("refused");
        expect(verdict(url, "file")).toBe("refused");
    });

    test("the deployment's allowlist is per kind; invalid entries are ignored", () => {
        DeploymentConfig.set({
            security: {
                pluginOrigins: ["https://plugins.example.lan/", "not an origin", 42, "https://*.cdn.example"],
                fileOrigins: ["https://models.example.lan"],
            },
        });
        expect(ExternalContentPolicy.allowedOrigins("plugin")).toEqual([
            "https://plugins.example.lan",
            "https://*.cdn.example",
        ]);
        expect(verdict("https://plugins.example.lan/a/", "plugin")).toBe("allowed");
        expect(verdict("https://plugins.example.lan/a.step", "file")).toBe("ask");
        expect(verdict("https://models.example.lan/a.step", "file")).toBe("allowed");
        expect(verdict("https://x.cdn.example/p/", "plugin")).toBe("allowed");
        // A wildcard needs two labels after "*.".
        DeploymentConfig.set({ security: { pluginOrigins: ["https://*.com", "https://*.lan:8443"] } });
        expect(ExternalContentPolicy.allowedOrigins("plugin")).toEqual([]);
        expect(verdict("https://cdn.example/p/", "plugin")).toBe("ask");
    });

    test("a missing or malformed security section allows nothing extra", () => {
        DeploymentConfig.set({ security: { pluginOrigins: "https://a.example" } });
        expect(ExternalContentPolicy.allowedOrigins("plugin")).toEqual([]);
        DeploymentConfig.set({ security: 3 });
        expect(ExternalContentPolicy.allowedOrigins("file")).toEqual([]);
    });

    describe("origins the user trusted", () => {
        test("apply to plugins while no session can exist", () => {
            expect(verdict("https://cdn.example.com/p/", "plugin", ["https://cdn.example.com"])).toBe(
                "allowed",
            );
            // Hosts saved by older versions: https only.
            expect(verdict("https://old.example.com/p/", "plugin", ["old.example.com"])).toBe("allowed");
            expect(verdict("http://old.example.com/p/", "plugin", ["old.example.com"])).toBe("ask");
        });

        test("never apply to files", () => {
            expect(verdict("https://cdn.example.com/a.step", "file", ["https://cdn.example.com"])).toBe(
                "ask",
            );
        });

        test("are ignored while a session may exist, and apply again once the probe is removed", () => {
            const remove = ExternalContentPolicy.setSessionProbe(() => true);
            try {
                expect(ExternalContentPolicy.hasSession).toBe(true);
                expect(verdict("https://cdn.example.com/p/", "plugin", ["https://cdn.example.com"])).toBe(
                    "ask",
                );
            } finally {
                remove();
            }
            expect(ExternalContentPolicy.hasSession).toBe(false);
            expect(verdict("https://cdn.example.com/p/", "plugin", ["https://cdn.example.com"])).toBe(
                "allowed",
            );
        });

        test("a probe that throws counts as a session", () => {
            const remove = ExternalContentPolicy.setSessionProbe(() => {
                throw new Error("not ready");
            });
            try {
                expect(ExternalContentPolicy.hasSession).toBe(true);
            } finally {
                remove();
            }
        });

        test("removing a replaced probe keeps the newer one", () => {
            const removeFirst = ExternalContentPolicy.setSessionProbe(() => true);
            const removeSecond = ExternalContentPolicy.setSessionProbe(() => true);
            removeFirst();
            expect(ExternalContentPolicy.hasSession).toBe(true);
            removeSecond();
            expect(ExternalContentPolicy.hasSession).toBe(false);
        });
    });
});

describe("originMatches", () => {
    test.each([
        ["https://a.example", "https://a.example/x", true],
        ["https://a.example", "https://b.a.example/x", false],
        ["https://*.a.example", "https://b.a.example/x", true],
        ["https://*.a.example", "https://c.b.a.example/x", true],
        ["https://*.a.example", "https://a.example/x", false],
        ["https://*.a.example", "http://b.a.example/x", false],
        ["https://*.a.example", "https://b.a.example:8443/x", false],
        ["https://*.a.example:8443", "https://b.a.example:8443/x", true],
        ["https://*.a.example", "https://evil-a.example/x", false],
        ["https://*.com", "https://evil.com/x", false],
        ["https://*.lan:8443", "https://evil.lan:8443/x", false],
    ])("%s vs %s → %s", (entry, url, expected) => {
        expect(originMatches(entry, new URL(url))).toBe(expected);
    });
});
