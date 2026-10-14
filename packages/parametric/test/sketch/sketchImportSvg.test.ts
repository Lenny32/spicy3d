// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { CancelableCommand, type ICameraController, Plane, Result, SvgImportRoute, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { SketchImportSvgCommand } from "../../src/sketch/commands/sketchImportSvg";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

const originalCreateElement = document.createElement;

/** The next file input "selects" `files` when clicked. */
function selectOnClick(files: File[]) {
    const create = originalCreateElement.bind(document) as (tag: string) => HTMLElement;
    document.createElement = ((tag: string) => {
        const element = create(tag);
        if (tag === "input") {
            const input = element as HTMLInputElement;
            input.click = () => {
                Object.defineProperty(input, "files", { value: files, configurable: true });
                input.onchange?.(new Event("change"));
            };
        }
        return element;
    }) as typeof document.createElement;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
    <rect x="0" y="0" width="40" height="20"/></svg>`;

/** A face-like plane: 30 mm along X, facing +X. */
const FACE = new Plane({ origin: new XYZ({ x: 30, y: 0, z: 0 }), normal: XYZ.unitX, xvec: XYZ.unitY });

function setup(plane: Plane = Plane.XY) {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: () => {} } as never });
    doc.visual = createMockVisualWithDocument(doc, {
        context: { displayMesh: rs.fn(() => 1), removeMesh: rs.fn(() => {}) },
    });
    const view = createMockView({
        document: doc,
        cameraController: {
            cameraPosition: new XYZ({ x: 0, y: 0, z: 500 }),
            cameraTarget: XYZ.zero,
            cameraUp: XYZ.unitY,
            cameraType: "perspective",
            lookAt: () => {},
            fitContent: () => {},
        } as unknown as ICameraController,
    });
    app.activeView = view;
    const shape = () => Result.ok({ isEqual: () => false });
    rs.stubGlobal("shapeFactory", {
        line: shape,
        bezier: shape,
        bspline: shape,
        wire: shape,
        combine: shape,
    });
    const node = new SketchNode({ document: doc, plane, data: { entities: [], constraints: [] } });
    doc.modelManager.addNode(node);
    const editor = SketchEditor.enter(node);
    const handler = doc.visual.eventHandler as SketchEventHandler;
    const event = (x: number, y: number) =>
        ({ offsetX: x + 400, offsetY: 300 - y, button: 0 }) as PointerEvent;
    return {
        doc,
        node,
        editor,
        move: (x: number, y: number) => handler.pointerMove(view, event(x, y)),
        click: async (x: number, y: number) => {
            handler.pointerDown(view, event(x, y));
            await Promise.resolve();
        },
    };
}

/** Starts the import and waits until the drawing follows the cursor. */
async function start(editor: SketchEditor, command = new SketchImportSvgCommand()) {
    selectOnClick([new File([SVG], "logo.svg", { type: "image/svg+xml" })]);
    const run = command.execute(editor.document.application);
    for (let i = 0; i < 50 && !editor.isPicking; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.isPicking).toBe(true);
    return { command, run };
}

function extent(params: number[][]) {
    const xs = params.flatMap((p) => [p[0], p[2]]);
    const ys = params.flatMap((p) => [p[1], p[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(
        (v) => Math.round(v * 1e6) / 1e6,
    );
}

afterEach(() => {
    document.createElement = originalCreateElement;
    SketchEditor.exit();
    const cache = (CancelableCommand as unknown as { _propertiesCache: Map<string, unknown> })
        ._propertiesCache;
    cache.delete("scale");
    cache.delete("rotation");
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
});

test("the drawing lands in the open sketch, centred on the click", async () => {
    const { editor, node, doc, move, click } = setup();
    const { command, run } = await start(editor);
    expect(command.width).toBe(40);
    expect(command.height).toBe(20);
    move(200, 20);
    expect(node.data.entities).toEqual([]);
    await click(200, 20);
    await run;
    expect(node.data.entities).toHaveLength(4);
    expect(extent(node.data.entities.map((e) => e.params))).toEqual([180, 10, 220, 30]);
    expect(node.data.constraints).toHaveLength(4);
    // no separate shape: the sketch is still the document's only node
    expect(doc.modelManager.findNodes()).toEqual([node]);
    // one undo step removes the whole drawing
    doc.history.undo();
    expect(node.data.entities).toEqual([]);
    expect(node.data.constraints).toEqual([]);
});

test("on a face plane, Apply places it at the sketch origin in that sketch's frame", async () => {
    const { editor, node, doc } = setup(FACE);
    const { command, run } = await start(editor);
    command.width = 80;
    command.rotation = 90;
    command.apply();
    await run;
    expect(node.plane).toBe(FACE);
    // 80 × 40 after scaling, then turned a quarter: 40 wide, 80 high about the origin
    expect(extent(node.data.entities.map((e) => e.params))).toEqual([-20, -40, 20, 40]);
    expect(doc.modelManager.findNodes()).toEqual([node]);
});

test("scale and angle typed while placing turn the preview at once and are remembered", async () => {
    const { editor } = setup();
    const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
    const { command, run } = await start(editor);
    const calls = preview.mock.calls.length;
    command.rotation = 45;
    expect(preview.mock.calls.length).toBeGreaterThan(calls);
    expect(preview.mock.calls.at(-1)?.[0]).toHaveLength(4);
    command.scale = 3;
    command.apply();
    await run;
    const next = await start(editor);
    expect(next.command.rotation).toBe(45);
    expect(next.command.scale).toBe(3);
    await next.command.cancel();
    await next.run;
});

test("File > Import SVG is routed to the sketch only while one is open", () => {
    expect(SvgImportRoute.redirect?.()).toBeUndefined();
    setup();
    expect(SvgImportRoute.redirect?.()).toBe("sketch.importSvg");
});
