// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { FolderNode, type IDocumentRepository, type ISelection } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { buildDocumentTools } from "../src/tools/documentTools";
import { buildPropertyTools } from "../src/tools/propertyTools";
import { buildReadTools } from "../src/tools/readTools";

/**
 * A TestDocument whose name behaves like the app's Document: the root node's name is the
 * document's (ModelManager copies a root rename to the document, the setter copies back).
 */
function namedDocument(name: string, readOnly = false): TestDocument {
    const doc = new TestDocument({ selection: { getSelectedNodes: () => [] } as unknown as ISelection });
    let current = name;
    Object.defineProperty(doc, "name", {
        get: () => current,
        set: (value: string) => {
            if (current === value) return;
            current = value;
            doc.modelManager.rootNode.name = value;
        },
    });
    // Setting up is not an edit: nothing for the tests' undo counts.
    doc.history.disabled = true;
    doc.modelManager.rootNode.name = name;
    doc.history.disabled = false;
    doc.repository = { kind: "local", isReadOnly: () => readOnly } as unknown as IDocumentRepository;
    return doc;
}

function tool(name: string) {
    const found = [...buildDocumentTools(), ...buildPropertyTools(), ...buildReadTools()].find(
        (t) => t.name === name,
    );
    expect(found).toBeDefined();
    return found!;
}

async function call(name: string, args: Record<string, unknown>) {
    return JSON.parse((await tool(name).handler(args)) as string);
}

let doc: TestDocument;

function open(document: TestDocument) {
    doc = document;
    const app = createMockApplication();
    (app as any).activeView = { document: doc };
    rs.stubGlobal("app", app);
}

afterEach(() => {
    rs.unstubAllGlobals();
});

describe("rename_document", () => {
    test("renames the document and its root component as one undo step", async () => {
        open(namedDocument("Untitled 1"));

        const result = await call("rename_document", { name: "  Mouse side  " });

        expect(result).toMatchObject({ renamed: true, previous: "Untitled 1", name: "Mouse side" });
        expect(doc.name).toBe("Mouse side");
        expect(doc.modelManager.rootNode.name).toBe("Mouse side");
        expect(doc.history.undoCount()).toBe(1);

        await doc.history.undo();
        expect(doc.name).toBe("Untitled 1");
        expect(doc.modelManager.rootNode.name).toBe("Untitled 1");
    });

    test.each([
        [{}, "non-empty"],
        [{ name: "   " }, "non-empty"],
        [{ name: 42 }, "non-empty"],
        [{ name: "a\nb" }, "control characters"],
        [{ name: "x".repeat(201) }, "at most 200"],
    ])("refuses %j", async (args, message) => {
        open(namedDocument("Part"));

        const result = await call("rename_document", args);

        expect(result.error).toContain(message);
        expect(doc.name).toBe("Part");
        expect(doc.history.undoCount()).toBe(0);
    });

    test("refuses a read-only document", async () => {
        open(namedDocument("Part", true));

        const result = await call("rename_document", { name: "Other" });

        expect(result.error).toContain("read-only");
        expect(doc.name).toBe("Part");
    });

    test("answers the no-document error without an active document", async () => {
        const app = createMockApplication();
        app.activeView = undefined;
        rs.stubGlobal("app", app);

        const result = await call("rename_document", { name: "Other" });

        expect(typeof result.error).toBe("string");
    });
});

describe("the document root through the node tools", () => {
    test("get_document_state names the root every top-level node's parentId points at", async () => {
        open(namedDocument("Part"));
        const folder = new FolderNode({ document: doc, name: "Group" });
        doc.modelManager.rootNode.add(folder);

        const state = await call("get_document_state", {});

        expect(state.rootId).toBe(doc.modelManager.rootNode.id);
        expect(state.nodes).toEqual([
            { id: folder.id, type: "FolderNode", name: "Group", parentId: state.rootId },
        ]);
    });

    test("get_node_properties reads the root, its name being the document's", async () => {
        open(namedDocument("Part"));
        const rootId = doc.modelManager.rootNode.id;

        const result = await call("get_node_properties", { ids: [rootId] });

        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0]).toMatchObject({ id: rootId, name: "Part" });
        expect(result.nodes[0].note).toContain("document root");
        expect(result.nodes[0].properties).toContainEqual(
            expect.objectContaining({ name: "name", value: "Part" }),
        );
    });

    test("set_node_properties renames the document through the root's name", async () => {
        open(namedDocument("Untitled 1"));
        const rootId = doc.modelManager.rootNode.id;

        const result = await call("set_node_properties", { id: rootId, properties: { name: "Mouse side" } });

        expect(result.document).toEqual({ name: "Mouse side" });
        expect(result.updated).toEqual([expect.objectContaining({ name: "name", value: "Mouse side" })]);
        expect(doc.name).toBe("Mouse side");
        expect(doc.history.undoCount()).toBe(1);
    });

    test.each([
        [{ visible: false }, "only its name"],
        [{ name: "" }, "non-empty"],
        [{}, "no properties given"],
    ])("set_node_properties on the root refuses %j", async (properties, message) => {
        open(namedDocument("Part"));

        const result = await call("set_node_properties", { id: doc.modelManager.rootNode.id, properties });

        expect(result.error).toContain(message);
        expect(doc.name).toBe("Part");
        expect(doc.history.undoCount()).toBe(0);
    });

    test("set_node_properties on a read-only document's root is refused", async () => {
        open(namedDocument("Part", true));

        const result = await call("set_node_properties", {
            id: doc.modelManager.rootNode.id,
            properties: { name: "Other" },
        });

        expect(result.error).toContain("read-only");
        expect(doc.name).toBe("Part");
    });
});
