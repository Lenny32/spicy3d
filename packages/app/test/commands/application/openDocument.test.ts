// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { encodeDocumentFile, PubSub, type Serialized } from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
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

    test("should implement ICommand (has execute method)", () => {
        const cmd = new OpenDocument();
        expect(typeof cmd.execute).toBe("function");
    });

    describe("with the File System Access API", () => {
        afterEach(() => {
            delete (window as any).showOpenFilePicker;
        });

        function stubPicker(result: () => Promise<FileSystemFileHandle[]>) {
            (window as any).showOpenFilePicker = rs.fn(result);
        }

        test("opens the picked .spicy file in a progress toast", async () => {
            const data = { formatVersion: 1, id: "picked", name: "Picked" } as unknown as Serialized;
            const file = new File([await encodeDocumentFile(data)], "picked.spicy");
            stubPicker(async () => [{ getFile: async () => file } as unknown as FileSystemFileHandle]);
            const app = createMockApplication();
            const loaded: Serialized[] = [];
            app.loadDocument = async (json: Serialized) => {
                loaded.push(json);
                return undefined;
            };
            const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});

            try {
                await new OpenDocument().execute(app);
                const call = pub.mock.calls.find(([event]) => event === "showPermanent");
                expect(call).not.toBeUndefined();
                await (call![1] as () => Promise<void>)();

                expect(loaded).toEqual([data]);
            } finally {
                pub.mockRestore();
            }
        });

        test("does nothing when the picker is dismissed", async () => {
            stubPicker(async () => {
                throw new DOMException("dismissed", "AbortError");
            });
            const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});

            try {
                await new OpenDocument().execute(createMockApplication());

                expect(pub).not.toHaveBeenCalled();
            } finally {
                pub.mockRestore();
            }
        });
    });
});
