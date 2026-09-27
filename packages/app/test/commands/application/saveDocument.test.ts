// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, rs, test } from "@rstest/core";
import {
    type DocumentRepositoryError,
    type IDocument,
    PubSub,
    Result,
    type SaveConflict,
    type SaveOutcome,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { SaveDocument } from "../../../src/commands/application/saveDocument";

describe("SaveDocument", () => {
    test("should have command metadata", () => {
        const data = (SaveDocument as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("doc.save");
        expect(data.icon).toBe("icon-save");
    });

    test("should have isApplicationCommand flag", () => {
        const data = (SaveDocument as any).prototype.data;
        expect(data.isApplicationCommand).toBe(true);
    });

    test("should do nothing when no active document", async () => {
        let published = false;
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string) => {
            if (channel === "showPermanent") {
                published = true;
            }
        }) as any;

        try {
            const app = createMockApplication();
            app.activeView = undefined;

            const cmd = new SaveDocument();
            await cmd.execute(app);

            // No permanent action is triggered without an active document
            expect(published).toBe(false);
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("should not publish showPermanent when activeView has no document", async () => {
        let published = false;
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string) => {
            if (channel === "showPermanent") {
                published = true;
            }
        }) as any;

        try {
            const app = createMockApplication();
            (app as any).activeView = { document: undefined };

            const cmd = new SaveDocument();
            await cmd.execute(app);

            expect(published).toBe(false);
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("should publish showPermanent event when document exists", async () => {
        let publishedChannel = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ..._args: any[]) => {
            publishedChannel = channel;
        }) as any;

        try {
            const doc = createMockDocument();
            doc.save = async () => Result.ok({ status: "saved", updatedAt: 0 });
            const app = createMockApplication();
            app.activeView = { document: doc } as any;

            const cmd = new SaveDocument();
            await cmd.execute(app);

            expect(publishedChannel).toBe("showPermanent");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("should implement ICommand (has execute method)", () => {
        const cmd = new SaveDocument();
        expect(typeof cmd.execute).toBe("function");
    });

    test("should pass executing template to showPermanent", async () => {
        let templateArg = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ...args: any[]) => {
            if (channel === "showPermanent") {
                templateArg = args[1] as string;
            }
        }) as any;

        try {
            const doc = createMockDocument();
            doc.save = async () => Result.ok({ status: "saved", updatedAt: 0 });
            const app = createMockApplication();
            app.activeView = { document: doc } as any;

            const cmd = new SaveDocument();
            await cmd.execute(app);

            expect(templateArg).toBe("toast.excuting{0}");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });
});

describe("SaveDocument callback", () => {
    /**
     * Capture the showPermanent callback and set up document.save tracking.
     */
    function setupCallbackTest(
        outcome: Result<SaveOutcome, DocumentRepositoryError> = Result.ok({ status: "saved", updatedAt: 0 }),
    ) {
        const state: {
            callback: (() => Promise<void>) | undefined;
            saveCalled: boolean;
            toastChannel: string;
            toastMessage: string;
        } = {
            callback: undefined,
            saveCalled: false,
            toastChannel: "",
            toastMessage: "",
        };

        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ...args: any[]) => {
            if (channel === "showPermanent") {
                state.callback = args[0] as () => Promise<void>;
            }
            if (channel === "showToast") {
                state.toastChannel = channel;
                state.toastMessage = args[0] as string;
            }
        }) as any;

        const doc = createMockDocument();
        doc.save = async () => {
            state.saveCalled = true;
            return outcome;
        };

        const app = createMockApplication();
        app.activeView = { document: doc } as any;

        const restore = () => {
            PubSub.default.pub = originalPub;
        };

        return { state, app, restore };
    }

    test("should call document.save() inside the callback", async () => {
        const { state, app, restore } = setupCallbackTest();

        try {
            const cmd = new SaveDocument();
            await cmd.execute(app);

            expect(state.callback).not.toBeUndefined();
            await state.callback!();

            expect(state.saveCalled).toBe(true);
        } finally {
            restore();
        }
    });

    test("should publish toast after saving", async () => {
        const { state, app, restore } = setupCallbackTest();

        try {
            const cmd = new SaveDocument();
            await cmd.execute(app);

            expect(state.callback).not.toBeUndefined();
            await state.callback!();

            expect(state.toastChannel).toBe("showToast");
            expect(state.toastMessage).toBe("toast.document.saved");
        } finally {
            restore();
        }
    });

    test.each<[string, Result<SaveOutcome, DocumentRepositoryError>, string]>([
        ["a repository failure", Result.err({ kind: "quota" }), "error.repository.quota"],
        ["a version conflict", Result.ok({ status: "conflict" }), "error.repository.conflict"],
    ])("should report %s instead of saved", async (_name, outcome, message) => {
        const { state, app, restore } = setupCallbackTest(outcome);

        try {
            await new SaveDocument().execute(app);
            expect(state.callback).not.toBeUndefined();
            await state.callback!();

            expect(state.toastMessage).toBe(message);
        } finally {
            restore();
        }
    });

    test("a version conflict opens the conflict handler when there is one", async () => {
        const conflict = { status: "conflict", headVersion: "h" } as const;
        const { state, app, restore } = setupCallbackTest(Result.ok(conflict));
        const handler = rs.fn(async (_doc: IDocument, _conflict: SaveConflict) => {});
        app.repositories.conflictHandler = handler;

        try {
            await new SaveDocument().execute(app);
            await state.callback!();

            expect(handler).toHaveBeenCalledWith(app.activeView!.document, conflict);
            expect(state.toastMessage).toBe("");
        } finally {
            restore();
        }
    });

    test("should publish showToast ONLY after save completes", async () => {
        const { state, app, restore } = setupCallbackTest();

        try {
            const cmd = new SaveDocument();
            await cmd.execute(app);

            // Before callback runs, toast should not have been published
            expect(state.toastChannel).toBe("");

            expect(state.callback).not.toBeUndefined();
            await state.callback!();

            // After callback runs, toast should be published
            expect(state.toastChannel).toBe("showToast");
        } finally {
            restore();
        }
    });

    test("should not publish showPermanent when activeView is undefined", async () => {
        let published = false;
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string) => {
            if (channel === "showPermanent") {
                published = true;
            }
        }) as any;

        try {
            const app = createMockApplication();
            app.activeView = undefined;

            const cmd = new SaveDocument();
            await cmd.execute(app);

            expect(published).toBe(false);
        } finally {
            PubSub.default.pub = originalPub;
        }
    });
});
