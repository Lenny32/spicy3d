// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import type { CommandData, CommandKeys, IApplication, ICommand, IDocument, IView } from "@spicy3d/core";
import { CommandStore, PubSub } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { CommandService } from "../../src/services/commandService";
import "../../src/commands/commandSearch";

// ── test command stubs ────────────────────────────────────────────────

class TestCommand implements ICommand {
    private static _waiters: Array<() => void> = [];

    /** Resolves the next time any TestCommand instance finishes execute(). */
    static nextExecuted(): Promise<void> {
        return new Promise<void>((resolve) => {
            TestCommand._waiters.push(resolve);
        });
    }

    static reset(): void {
        TestCommand._waiters = [];
    }

    executeCalls: IApplication[] = [];

    async execute(application: IApplication): Promise<void> {
        this.executeCalls.push(application);
        for (const resolve of TestCommand._waiters.splice(0)) {
            resolve();
        }
    }
}

class ThrowingCommand implements ICommand {
    async execute(_application: IApplication): Promise<void> {
        throw new Error("command failed");
    }
}

class TestCancelableCommand implements ICommand {
    cancelCalls = 0;

    private _resolveCancelled!: () => void;
    /** Resolves the first time cancel() is called on this instance. */
    readonly cancelled: Promise<void> = new Promise<void>((resolve) => {
        this._resolveCancelled = resolve;
    });

    async execute(_application: IApplication): Promise<void> {}

    async cancel(): Promise<void> {
        this.cancelCalls++;
        this._resolveCancelled();
    }
}

// ── helpers ───────────────────────────────────────────────────────────

function registerCommand(key: string, Ctor: new () => ICommand = TestCommand, isAppCommand = false) {
    CommandStore.registerCommand(Ctor, {
        key: key as CommandKeys,
        icon: "test-icon",
        isApplicationCommand: isAppCommand,
    } as Omit<CommandData, "key"> & { key: string });
}

function unregisterCommand(key: string) {
    CommandStore.unregisterCommand(key);
}

/**
 * Wait until the full async command chain (executeCommand → canExecute → executeAsync
 * → command.execute → finally) has completed for `key`.
 *
 * CommandService exposes no completion event; `lastCommand` is assigned in
 * executeAsync's finally block, so it is the only observable signal that the whole
 * chain has finished (including that `executingCommand` was cleared). Keep this
 * polling in a single place: if the service ever emits a completion event, only
 * this helper needs to change.
 */
async function waitForCommandCompleted(app: IApplication, key: string): Promise<void> {
    await rs.waitFor(() => {
        expect(app.lastCommand).toBe(key);
    });
}

// ── tests ─────────────────────────────────────────────────────────────

describe("CommandService", () => {
    let service: CommandService;
    let app: IApplication;
    let doc: IDocument;
    let view: IView;

    beforeEach(() => {
        service = new CommandService();
        doc = createMockDocument({ id: "doc-1", name: "test" });
        view = { document: doc } as unknown as IView;

        app = createMockApplication();
        app.activeView = view;

        TestCommand.reset();
    });

    afterEach(() => {
        service.stop();
        unregisterCommand("test.box");
        unregisterCommand("test.appCmd");
        unregisterCommand("test.cancelable");
        unregisterCommand("test.error");
        unregisterCommand("test.error2");
        PubSub.default.removeAll("executeCommand");
        PubSub.default.removeAll("activeViewChanged");
    });

    // ── lifecycle ──────────────────────────────────────────────────

    describe("register", () => {
        test("should wire the application so published commands execute against it", async () => {
            registerCommand("test.box");
            service.register(app);
            service.start();

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);

            // Execution only works when register() stored the app instance
            await waitForCommandCompleted(app, "test.box");
        });
    });

    describe("start", () => {
        test("should subscribe to executeCommand and activeViewChanged", async () => {
            registerCommand("test.box");
            service.register(app);
            service.start();

            // executeCommand subscription is live: the published command runs to completion
            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);
            await waitForCommandCompleted(app, "test.box");

            // activeViewChanged subscription is live: the executing cancelable command is cancelled
            const cancelableCmd = new TestCancelableCommand();
            app.executingCommand = cancelableCmd;
            PubSub.default.pub("activeViewChanged", view);
            await cancelableCmd.cancelled;
            expect(cancelableCmd.cancelCalls).toBe(1);
        });
    });

    describe("stop", () => {
        test("should unsubscribe so published commands are no longer executed", async () => {
            registerCommand("test.box");
            service.register(app);
            service.start();
            service.stop();

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);

            // No handler is subscribed anymore, so nothing can be triggered
            await Promise.resolve();

            expect(app.executingCommand).toBeUndefined();
            expect(app.lastCommand).toBeUndefined();
        });
    });

    // ── executeCommand flow ────────────────────────────────────────

    describe("executeCommand", () => {
        beforeEach(() => {
            service.register(app);
        });

        test("should execute registered command and set lastCommand", async () => {
            registerCommand("test.box");
            service.start();

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);

            await waitForCommandCompleted(app, "test.box");
        });

        test("should clear executingCommand after execution", async () => {
            registerCommand("test.box");
            service.start();

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);

            // waitForCommandCompleted returns after the finally block ran, so
            // executingCommand must already be cleared.
            await waitForCommandCompleted(app, "test.box");
            expect(app.executingCommand).toBeUndefined();
        });

        test("should use lastCommand when commandName is special.last", async () => {
            registerCommand("test.box");
            app.lastCommand = "test.box" as CommandKeys;
            service.start();

            const executed = TestCommand.nextExecuted();
            PubSub.default.pub("executeCommand", "special.last" as CommandKeys);

            // The registered command really ran, and lastCommand stays the same
            await executed;
            await waitForCommandCompleted(app, "test.box");
        });

        test("should preserve repeat-last after opening command search", async () => {
            registerCommand("test.box");
            service.start();
            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);
            await waitForCommandCompleted(app, "test.box");

            const opened = rs.fn(() => {});
            PubSub.default.sub("openCommandSearch", opened);
            try {
                PubSub.default.pub("executeCommand", "edit.commandSearch");
                await rs.waitFor(() => {
                    expect(opened).toHaveBeenCalledTimes(1);
                    expect(app.executingCommand).toBeUndefined();
                });
                expect(app.lastCommand).toBe("test.box");

                const executed = TestCommand.nextExecuted();
                PubSub.default.pub("executeCommand", "special.last");
                await executed;
                await rs.waitFor(() => expect(app.executingCommand).toBeUndefined());
                expect(opened).toHaveBeenCalledTimes(1);
                expect(app.lastCommand).toBe("test.box");
            } finally {
                PubSub.default.remove("openCommandSearch", opened);
            }
        });

        test("should skip execution when commandName is falsy", async () => {
            registerCommand("test.box");
            service.start();

            PubSub.default.pub("executeCommand", undefined as unknown as CommandKeys);

            // Give the (skipped) async chain a chance to run before asserting nothing happened
            await Promise.resolve();

            expect(app.executingCommand).toBeUndefined();
            expect(app.lastCommand).toBeUndefined();
        });
    });

    // ── canExecute guard ───────────────────────────────────────────

    describe("canExecute guard", () => {
        beforeEach(() => {
            service.register(app);
            service.start();
        });

        test("should reject non-application command when no activeView", async () => {
            registerCommand("test.box");
            app.activeView = undefined;

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);

            // canExecute rejects the command synchronously; a microtask flush is enough
            await Promise.resolve();

            expect(app.lastCommand).toBeUndefined();
        });

        test("should allow application command when no activeView", async () => {
            registerCommand("test.appCmd", TestCommand, true);
            app.activeView = undefined;

            PubSub.default.pub("executeCommand", "test.appCmd" as CommandKeys);
            await waitForCommandCompleted(app, "test.appCmd");
        });

        test("should cancel existing cancelable command before executing new one", async () => {
            registerCommand("test.box");
            registerCommand("test.cancelable", TestCancelableCommand);

            const cancelableCmd = new TestCancelableCommand();
            app.executingCommand = cancelableCmd;

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);
            await cancelableCmd.cancelled;
            expect(cancelableCmd.cancelCalls).toBe(1);
        });

        test("should not reject when no command is running", async () => {
            registerCommand("test.box");

            PubSub.default.pub("executeCommand", "test.box" as CommandKeys);
            await waitForCommandCompleted(app, "test.box");
        });
    });

    // ── error handling ─────────────────────────────────────────────

    describe("error handling", () => {
        beforeEach(() => {
            service.register(app);
            service.start();
        });

        test("should clear executingCommand after command throws", async () => {
            registerCommand("test.error", ThrowingCommand);

            PubSub.default.pub("executeCommand", "test.error" as CommandKeys);

            // waitForCommandCompleted returns after the finally block ran even when
            // execute throws, so executingCommand must already be cleared.
            await waitForCommandCompleted(app, "test.error");
            expect(app.executingCommand).toBeUndefined();
        });

        test("should still set lastCommand even when command throws", async () => {
            registerCommand("test.error2", ThrowingCommand);

            PubSub.default.pub("executeCommand", "test.error2" as CommandKeys);

            await waitForCommandCompleted(app, "test.error2");
            // executeAsync's finally block assigns lastCommand even when execute throws
            expect(app.lastCommand).toBe("test.error2");
        });
    });

    // ── activeViewChanged ──────────────────────────────────────────

    describe("activeViewChanged", () => {
        beforeEach(() => {
            service.register(app);
            service.start();
        });

        test("should cancel executing cancelable command when active view changes", async () => {
            const cancelableCmd = new TestCancelableCommand();
            app.executingCommand = cancelableCmd;

            PubSub.default.pub("activeViewChanged", { id: "new" } as unknown as IView);

            await cancelableCmd.cancelled;
            expect(cancelableCmd.cancelCalls).toBe(1);
        });

        test("should not throw when executingCommand is not cancelable", () => {
            app.executingCommand = new TestCommand();

            expect(() => {
                PubSub.default.pub("activeViewChanged", { id: "new" } as unknown as IView);
            }).not.toThrow();
        });

        test("should not throw when no command is executing", () => {
            app.executingCommand = undefined;

            expect(() => {
                PubSub.default.pub("activeViewChanged", { id: "new" } as unknown as IView);
            }).not.toThrow();
        });
    });
});
