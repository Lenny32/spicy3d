// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { PubSub } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { OpenDocument } from "../../../src/commands/application/openDocument";

describe("OpenDocument", () => {
    test("should have command metadata", () => {
        const data = (OpenDocument as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("doc.open");
        expect(data.icon).toBe("icon-open");
    });

    test("should have isApplicationCommand flag", () => {
        const data = (OpenDocument as any).prototype.data;
        expect(data.isApplicationCommand).toBe(true);
    });

    test("should publish showPermanent event", async () => {
        let publishedChannel = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ..._args: any[]) => {
            publishedChannel = channel;
        }) as any;

        const app = createMockApplication();
        const cmd = new OpenDocument();

        try {
            await cmd.execute(app);

            expect(publishedChannel).toBe("showPermanent");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("should implement ICommand (has execute method)", () => {
        const cmd = new OpenDocument();
        expect(typeof cmd.execute).toBe("function");
    });

    test("should publish showPermanent with a callback when executed", async () => {
        let callback: unknown;
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ...args: any[]) => {
            if (channel === "showPermanent") {
                callback = args[0];
            }
        }) as any;

        try {
            const app = createMockApplication();
            app.activeView = { document: createMockDocument() } as any;

            const cmd = new OpenDocument();
            await cmd.execute(app);

            expect(typeof callback).toBe("function");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });
});
