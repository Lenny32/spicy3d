// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, test } from "@rstest/core";
import type { IDocument, IView } from "@spicy3d/core";
import { PubSub } from "@spicy3d/core";
import { createMockApplication, createMockDocument, createMockView } from "@spicy3d/core/test-utils";
import { importFiles } from "../src/utils";

function createDocView(doc: IDocument): IView {
    return createMockView({
        document: doc,
        cameraController: { fitContent: () => {} },
    } as unknown as Partial<IView>);
}

describe("importFiles", () => {
    let newDocumentCalls: string[];

    beforeEach(() => {
        newDocumentCalls = [];
    });

    afterEach(() => {
        PubSub.default.removeAll("showPermanent");
    });

    describe("document resolution", () => {
        test("should use existing activeView document (does not call newDocument)", async () => {
            const doc = createMockDocument({ id: "existing", name: "existing" });
            const view = createDocView(doc);

            const app = createMockApplication({
                dataExchange: { import: async () => {} },
            });
            app.activeView = view;
            app.newDocument = async () => {
                newDocumentCalls.push("unexpected");
                return {} as IDocument;
            };

            await importFiles(app, [new File([], "test.step")]);

            expect(newDocumentCalls.length).toBe(0);
        });

        test("should create new Untitled document when no activeView", async () => {
            const app = createMockApplication({
                dataExchange: {
                    import: async (_document: IDocument, _files: File[] | FileList) => {},
                },
            });
            app.activeView = undefined;
            app.newDocument = async (name: string) => {
                newDocumentCalls.push(name);
                const newDoc = createMockDocument({ id: "new-doc", name, application: app });
                app.activeView = createDocView(newDoc);
                return newDoc;
            };

            await importFiles(app, [new File([], "test.igs")]);

            expect(newDocumentCalls).toEqual(["Untitled"]);
        });

        test("should create new document when activeView is undefined", async () => {
            const app = createMockApplication({
                dataExchange: { import: async () => {} },
            });
            app.activeView = undefined;
            app.newDocument = async (name: string) => {
                newDocumentCalls.push(name);
                const newDoc = createMockDocument({ id: "fallback-doc", name, application: app });
                app.activeView = createDocView(newDoc);
                return newDoc;
            };

            await importFiles(app, [new File([], "model.stl")]);

            expect(newDocumentCalls).toEqual(["Untitled"]);
        });
    });

    describe("PubSub event", () => {
        test("should publish showPermanent with correct message key", async () => {
            const doc = createMockDocument({ id: "test-doc", name: "test-doc" });
            const view = createDocView(doc);

            let capturedCallback: unknown;
            let capturedMessage: unknown;

            const originalPub = PubSub.default.pub.bind(PubSub.default);
            PubSub.default.pub = ((event: string, ...args: unknown[]) => {
                if (event === "showPermanent") {
                    capturedCallback = args[0];
                    capturedMessage = args[1];
                }
            }) as typeof PubSub.default.pub;

            try {
                const app = createMockApplication({
                    dataExchange: { import: async () => {} },
                });
                app.activeView = view;
                app.newDocument = async () => ({}) as IDocument;

                await importFiles(app, [new File([], "test.stl")]);

                expect(capturedMessage).toBe("toast.excuting{0}");
                expect(typeof capturedCallback).toBe("function");
            } finally {
                PubSub.default.pub = originalPub;
            }
        });
    });

    describe("dataExchange integration", () => {
        test("should call dataExchange.import when the published callback is executed", async () => {
            let capturedCallback: (() => Promise<void>) | undefined;
            const originalPub = PubSub.default.pub.bind(PubSub.default);
            PubSub.default.pub = ((event: string, ...args: unknown[]) => {
                if (event === "showPermanent") {
                    capturedCallback = args[0] as () => Promise<void>;
                }
            }) as typeof PubSub.default.pub;

            try {
                let fitContentCalled = false;
                let importCalled = false;
                let importFilesArg: File[] | FileList | undefined;

                const app = createMockApplication({
                    dataExchange: {
                        import: async (_document: IDocument, files: File[] | FileList) => {
                            importCalled = true;
                            importFilesArg = files;
                        },
                    },
                });
                app.newDocument = async () => ({}) as IDocument;

                const doc = createMockDocument({ id: "import-doc", name: "import-doc", application: app });
                const view = createMockView({
                    document: doc,
                    cameraController: {
                        fitContent: () => {
                            fitContentCalled = true;
                        },
                    },
                } as unknown as Partial<IView>);
                app.activeView = view;

                const files = [new File([], "model.brep")];
                await importFiles(app, files);

                expect(capturedCallback).not.toBeUndefined();
                await capturedCallback!();

                expect(importCalled).toBe(true);
                expect(importFilesArg).toBe(files);
                expect(fitContentCalled).toBe(true);
            } finally {
                PubSub.default.pub = originalPub;
            }
        });
    });
});
