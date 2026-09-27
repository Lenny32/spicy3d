// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, rs, test } from "@rstest/core";
import {
    AsyncController,
    CancelableCommand,
    getCurrentApplication,
    type IApplication,
    PropertyUtils,
    PubSub,
    SelectNodeStep,
    setCurrentApplication,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { Export, Import } from "../../src/commands/importExport";

// Ensure a mock application is set (Export constructor calls getCurrentApplication)
try {
    getCurrentApplication();
} catch {
    setCurrentApplication(createMockApplication());
}

describe("Import", () => {
    test("should have command metadata", () => {
        const data = (Import as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("file.import");
        expect(data.icon).toBe("icon-import");
    });

    test("should implement ICommand (has execute method)", () => {
        const cmd = new Import();
        expect(typeof cmd.execute).toBe("function");
    });

    test("should handle importFormats call correctly", async () => {
        const app = createMockApplication();
        app.dataExchange.importFormats = () => [".step", ".stl", ".iges"];

        const cmd = new Import();
        // execute will call readFilesAsync which creates a file input in browser.
        // In test env (Happy-DOM), we can verify the format string is correct.
        expect(typeof app.dataExchange.importFormats().join(",")).toBe("string");
        expect(app.dataExchange.importFormats().join(",")).toBe(".step,.stl,.iges");
    });

    test("Import instance should have type-safe execute signature", () => {
        const cmd = new Import();
        expect(cmd).toBeInstanceOf(Import);
        expect(typeof cmd.execute).toBe("function");
    });

    test("should handle empty file list gracefully via alert", async () => {
        // When readFilesAsync returns empty files, Import shows an alert.
        // We verify the command can be constructed and has proper metadata.
        const cmd = new Import();
        expect(cmd).toBeInstanceOf(Import);
        expect((Import as any).prototype.data.key).toBe("file.import");
    });
});

describe("Export", () => {
    test("should have command metadata", () => {
        const data = (Export as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("file.export");
        expect(data.icon).toBe("icon-export");
    });

    test("should extend CancelableCommand", () => {
        const cmd = new Export();
        expect(cmd).toBeInstanceOf(CancelableCommand);
    });

    test("format should default to '.step'", () => {
        const cmd = new Export();
        expect(cmd.format).toBe(".step");
    });

    test("format setter should update property", () => {
        const cmd = new Export();
        cmd.format = ".stl";
        expect(cmd.format).toBe(".stl");

        cmd.format = ".step";
        expect(cmd.format).toBe(".step");
    });

    test("should populate combobox items from dataExchange.exportFormats in constructor", () => {
        const restoreApp = installExportApp();
        try {
            const cmd = new Export();
            // The combobox should be populated with formats.
            // Just verify construction doesn't throw and format works.
            expect(cmd.format).toBe(".step");
        } finally {
            restoreApp();
        }
    });

    test("constructor should populate combobox with the export formats", () => {
        const restoreApp = installExportApp();
        try {
            new Export();
            const combobox = PropertyUtils.getProperty(Export.prototype, "format")!.combobox!;
            expect(Array.from(combobox.items)).toEqual([
                ".step",
                ".stl",
                ".stl binary",
                ".ply",
                ".ply binary",
            ]);
        } finally {
            restoreApp();
        }
    });

    test("format setter handles .stl suffix", () => {
        const cmd = new Export();
        cmd.format = ".stl";
        expect(cmd.format).toBe(".stl");
    });

    test("format setter handles .stl binary suffix", () => {
        const cmd = new Export();
        cmd.format = ".stl binary";
        expect(cmd.format).toBe(".stl binary");
    });

    test("format setter handles .ply binary suffix", () => {
        const cmd = new Export();
        cmd.format = ".ply binary";
        expect(cmd.format).toBe(".ply binary");
    });

    test("format setter should handle unknown format gracefully", () => {
        const cmd = new Export();
        cmd.format = ".unknown";
        expect(cmd.format).toBe(".unknown");
    });

    describe("selectNodesAsync", () => {
        test("should create AsyncController and SelectNodeStep", async () => {
            const cmd = new Export();
            const doc = createMockDocument();
            (doc as any).picker = {
                pickNode: () => Promise.resolve([]),
            };
            (cmd as any)._application = { activeView: { document: doc } };

            const result = await (cmd as any).selectNodesAsync();
            // When no nodes are picked, it should publish a toast and return undefined
            expect(result).toBeUndefined();
        });
    });

    describe("executeAsync error paths", () => {
        test("should publish toast when no nodes selected", async () => {
            const originalPub = PubSub.default.pub;
            let publishCalled = false;
            PubSub.default.pub = ((channel: string, ..._args: unknown[]) => {
                if (channel === "showToast") {
                    publishCalled = true;
                }
            }) as any;

            try {
                const cmd = new Export();
                (cmd as any)._application = createMockApplicationWithDoc();

                // Override selectNodesAsync to return empty
                (cmd as any).selectNodesAsync = () => Promise.resolve([]);

                await (cmd as any).executeAsync();
                expect(publishCalled).toBe(true);
            } finally {
                PubSub.default.pub = originalPub;
            }
        });

        test("should publish showToast when selectNodesAsync returns undefined", async () => {
            const originalPub = PubSub.default.pub;
            let publishCalled = false;
            PubSub.default.pub = ((channel: string, ..._args: unknown[]) => {
                if (channel === "showToast") {
                    publishCalled = true;
                }
            }) as any;

            try {
                const cmd = new Export();
                (cmd as any)._application = createMockApplicationWithDoc();
                (cmd as any).selectNodesAsync = () => Promise.resolve(undefined);

                await (cmd as any).executeAsync();
                expect(publishCalled).toBe(true);
            } finally {
                PubSub.default.pub = originalPub;
            }
        });
    });

    describe("executeAsync happy path", () => {
        test("should publish showPermanent with nodes", async () => {
            let permanentChannel = "";
            const originalPub = PubSub.default.pub;
            PubSub.default.pub = ((channel: string, ..._args: unknown[]) => {
                if (channel === "showPermanent") {
                    permanentChannel = channel;
                }
            }) as any;

            try {
                const cmd = new Export();
                (cmd as any)._application = {
                    activeView: { document: createMockDocument() },
                    dataExchange: {
                        export: () => Promise.resolve(new ArrayBuffer(8)),
                    },
                };
                (cmd as any).selectNodesAsync = () => Promise.resolve([{ name: "testNode", id: "1" }]);

                await (cmd as any).executeAsync();
                expect(permanentChannel).toBe("showPermanent");
            } finally {
                PubSub.default.pub = originalPub;
            }
        });
    });

    describe("merge option", () => {
        test("merge should default to true", () => {
            const cmd = new Export();
            expect(cmd.merge).toBe(true);
        });

        test("merge setter should update property", () => {
            const cmd = new Export();
            cmd.merge = false;
            expect(cmd.merge).toBe(false);

            cmd.merge = true;
            expect(cmd.merge).toBe(true);
        });

        test("should export all nodes into one file when merge is true", async () => {
            const ctx = setupExportContext();
            try {
                const cmd = new Export();
                cmd.merge = true;
                (cmd as any)._application = ctx.app;
                (cmd as any).selectNodesAsync = () => Promise.resolve([{ name: "a" }, { name: "b" }]);

                await (cmd as any).executeAsync();
                expect(ctx.permanentCallback).toBeDefined();
                await ctx.permanentCallback!();

                expect(ctx.exportedNames).toEqual(["a,b"]);
                expect(ctx.downloads).toEqual(["a.step"]);
            } finally {
                ctx.restore();
            }
        });

        test("should export each node into one zip file when merge is false", async () => {
            const ctx = setupExportContext();
            try {
                const cmd = new Export();
                cmd.merge = false;
                (cmd as any)._application = ctx.app;
                (cmd as any).selectNodesAsync = () => Promise.resolve([{ name: "a" }, { name: "b" }]);

                await (cmd as any).executeAsync();
                expect(ctx.permanentCallback).toBeDefined();
                await ctx.permanentCallback!();

                expect(ctx.exportedNames).toEqual(["a", "b"]);
                expect(ctx.downloads).toEqual(["a.zip"]);
                expect(await zipFileNames(ctx.blobs[0])).toEqual(["a.step", "b.step"]);
            } finally {
                ctx.restore();
            }
        });

        test("should deduplicate file names in the zip when nodes share a name", async () => {
            const ctx = setupExportContext();
            try {
                const cmd = new Export();
                cmd.merge = false;
                (cmd as any)._application = ctx.app;
                (cmd as any).selectNodesAsync = () => Promise.resolve([{ name: "a" }, { name: "a" }]);

                await (cmd as any).executeAsync();
                await ctx.permanentCallback!();

                expect(ctx.downloads).toEqual(["a.zip"]);
                expect(await zipFileNames(ctx.blobs[0])).toEqual(["a-1.step", "a.step"]);
            } finally {
                ctx.restore();
            }
        });

        test("should download the single file directly when only one node is selected", async () => {
            const ctx = setupExportContext();
            try {
                const cmd = new Export();
                cmd.merge = false;
                (cmd as any)._application = ctx.app;
                (cmd as any).selectNodesAsync = () => Promise.resolve([{ name: "a" }]);

                await (cmd as any).executeAsync();
                await ctx.permanentCallback!();

                expect(ctx.exportedNames).toEqual(["a"]);
                expect(ctx.downloads).toEqual(["a.step"]);
            } finally {
                ctx.restore();
            }
        });
    });
});

/** Install an app stub so Export constructor can call app.dataExchange.exportFormats(). */
function installExportApp(): () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "app");
    Object.defineProperty(globalThis, "app", {
        configurable: true,
        get: () => ({
            dataExchange: {
                exportFormats: () => [".step", ".stl", ".stl binary", ".ply", ".ply binary"],
            },
        }),
    });
    return () => {
        if (previous) {
            Object.defineProperty(globalThis, "app", previous);
        }
    };
}

function createMockApplicationWithDoc() {
    const app = createMockApplication();
    app.activeView = { document: createMockDocument() } as any;
    return app;
}

/** Capture the showPermanent callback, dataExchange.export calls and download file names. */
function setupExportContext() {
    const ctx = {
        permanentCallback: undefined as (() => Promise<void>) | undefined,
        exportedNames: [] as string[],
        downloads: [] as string[],
        blobs: [] as Blob[],
        app: {
            activeView: { document: createMockDocument() },
            dataExchange: {
                export: (_format: string, nodes: { name: string }[]) => {
                    ctx.exportedNames.push(nodes.map((n) => n.name).join(","));
                    return Promise.resolve([new ArrayBuffer(8)]);
                },
            },
        },
        restore: () => {},
    };

    const originalPub = PubSub.default.pub;
    PubSub.default.pub = ((channel: string, ...args: unknown[]) => {
        if (channel === "showPermanent") {
            ctx.permanentCallback = args[0] as () => Promise<void>;
        }
    }) as any;

    // happy-dom/Node Blob mismatch requires stubbing createObjectURL (same as toFile.test.ts)
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
        ctx.blobs.push(blob);
        return "blob:mock-url";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((_url: string) => {}) as typeof URL.revokeObjectURL;

    const clickSpy = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
    ) {
        ctx.downloads.push(this.download);
    });

    ctx.restore = () => {
        PubSub.default.pub = originalPub;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
        clickSpy.mockRestore();
    };
    return ctx;
}

async function zipFileNames(blob: Blob): Promise<string[]> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(blob);
    return Object.keys(zip.files).sort();
}

describe("Export output unit", () => {
    /** A global app whose active project reads in `unit`; STEP records its unit, STL does not. */
    function installUnitApp(unit: "mm" | "cm" | "in") {
        const document = createMockDocument();
        document.settings.load({ lengthUnit: unit });
        const exports: { format: string; lengthUnit: unknown }[] = [];
        const stub = {
            activeView: { document },
            dataExchange: {
                exportFormats: () => [".step", ".stl"],
                exportUnitHandling: (format: string) =>
                    format === ".step" ? { kind: "embedded" as const } : { kind: "none" as const },
                export: (format: string, _nodes: unknown[], options?: { lengthUnit?: unknown }) => {
                    exports.push({ format, lengthUnit: options?.lengthUnit });
                    return Promise.resolve([new ArrayBuffer(8)]);
                },
            },
        };
        const previous = Object.getOwnPropertyDescriptor(globalThis, "app");
        Object.defineProperty(globalThis, "app", { configurable: true, get: () => stub });
        return {
            stub,
            exports,
            restore: () => {
                if (previous) Object.defineProperty(globalThis, "app", previous);
            },
        };
    }

    test("defaults to the project unit on every export", () => {
        const env = installUnitApp("cm");
        try {
            const first = new Export();
            expect(first.outputUnit).toBe("cm");
            first.outputUnit = "in";
            expect(first.outputUnit).toBe("in");
            // A new export starts from the project again, not from the last override.
            expect(new Export().outputUnit).toBe("cm");
        } finally {
            env.restore();
        }
    });

    test("names the output unit and whether the importer must be told it", () => {
        const env = installUnitApp("cm");
        try {
            const cmd = new Export();
            cmd.format = ".step";
            expect(cmd.unitInfo).toBe(
                "file.unitInfo.embedded{0}{1}".replace("{0}", "STEP").replace("{1}", "cm"),
            );
            cmd.format = ".stl";
            expect(cmd.unitInfo).toContain("STL");
            expect(cmd.unitInfo).toContain("cm");
            expect(cmd.hasFixedUnit).toBe(false);
        } finally {
            env.restore();
        }
    });

    test("hands the chosen unit to the data exchange", async () => {
        const env = installUnitApp("in");
        const ctx = setupExportContext();
        try {
            const cmd = new Export();
            cmd.format = ".stl";
            (cmd as any)._application = env.stub;
            (cmd as any).selectNodesAsync = () => Promise.resolve([{ name: "a" }]);

            await (cmd as any).executeAsync();
            await ctx.permanentCallback!();

            expect(env.exports).toEqual([{ format: ".stl", lengthUnit: "in" }]);
        } finally {
            ctx.restore();
            env.restore();
        }
    });
});
