// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    buildSvgShape,
    EditableShapeNode,
    type IFace,
    type INode,
    type IShape,
    PubSub,
    parseSvg,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { DefaultDataExchange } from "../src/defaultDataExchange";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);
let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    factory = new ShapeFactory();
});
afterEach(() => {
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

/** 100 × 100 mm page, one user unit = 1 mm. */
function svg(body: string) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">${body}</svg>`;
}

function build(body: string, options?: Parameters<typeof buildSvgShape>[2]) {
    const drawing = parseSvg(svg(body));
    expect(drawing.isOk).toBe(true);
    return buildSvgShape(factory, drawing.unchecked()!, options);
}

function faces(shape: IShape): IFace[] {
    return shape.findSubShapes(ShapeTypes.face) as IFace[];
}

function totalArea(shape: IShape): number {
    return faces(shape).reduce((sum, face) => sum + face.area(), 0);
}

describe("buildSvgShape", () => {
    test("a square with a square hole is one face that extrudes to the expected volume", () => {
        const result = build('<path d="M10 10 H60 V60 H10 Z M20 20 V30 H30 V20 Z"/>');
        expect(result.isOk).toBe(true);
        const { shape, faceCount, wireCount, failed } = result.unchecked()!;
        expect([faceCount, wireCount, failed]).toEqual([1, 0, 0]);
        expect(shape.shapeType).toBe(ShapeTypes.face);
        expect((shape as IFace).area()).toBeCloseTo(50 * 50 - 10 * 10, 6);
        const solid = factory.prism(shape, new XYZ(0, 0, 5));
        expect(solid.isOk).toBe(true);
        expect(solid.unchecked()!.volume()).toBeCloseTo((50 * 50 - 10 * 10) * 5, 4);
    });

    test("even-odd nesting: an island inside a hole is its own face", () => {
        const result = build(
            '<path d="M0 0 H90 V90 H0 Z M10 10 H80 V80 H10 Z M20 20 H70 V70 H20 Z M30 30 H60 V60 H30 Z"/>',
        );
        const { shape, faceCount } = result.unchecked()!;
        expect(faceCount).toBe(2);
        expect(totalArea(shape)).toBeCloseTo(90 * 90 - 70 * 70 + (50 * 50 - 30 * 30), 6);
    });

    test("separate elements stay separate faces even when one lies inside another", () => {
        const result = build(
            '<rect x="0" y="0" width="40" height="40"/><rect x="10" y="10" width="10" height="10"/>',
        );
        const { shape, faceCount } = result.unchecked()!;
        expect(faceCount).toBe(2);
        expect(totalArea(shape)).toBeCloseTo(40 * 40 + 10 * 10, 6);
    });

    test("curves: a circle becomes a face of the circle's area", () => {
        const { shape } = build('<circle cx="50" cy="50" r="20"/>').unchecked()!;
        // Four cubic quarter arcs approximate the circle within 0.03 %.
        expect((shape as IFace).area()).toBeCloseTo(Math.PI * 400, 0);
    });

    test("scale multiplies the size about the origin", () => {
        const { shape } = build('<rect x="10" y="10" width="10" height="20"/>', { scale: 2.5 }).unchecked()!;
        expect((shape as IFace).area()).toBeCloseTo(10 * 20 * 2.5 * 2.5, 6);
        const box = shape.boundingBox()!;
        expect(box.min.x).toBeCloseTo(25, 6);
        expect(box.max.x).toBeCloseTo(50, 6);
        expect(box.max.z - box.min.z).toBeCloseTo(0, 9);
    });

    test("open outlines are wires; faces: false keeps closed outlines as wires too", () => {
        const mixed = build('<path d="M0 0 L10 0 L10 10"/><rect width="5" height="5"/>').unchecked()!;
        expect([mixed.faceCount, mixed.wireCount]).toEqual([1, 1]);
        const wires = build('<rect width="5" height="5"/><circle cx="20" cy="20" r="2"/>', {
            faces: false,
        }).unchecked()!;
        expect([wires.faceCount, wires.wireCount]).toEqual([0, 2]);
        expect(faces(wires.shape)).toHaveLength(0);
    });

    test("an empty drawing and a non-positive scale are refused", () => {
        expect(build("<text>nothing</text>").isOk).toBe(false);
        expect(build('<rect width="5" height="5"/>', { scale: 0 }).isOk).toBe(false);
    });
});

describe("DefaultDataExchange SVG import", () => {
    test(".svg is an import format", () => {
        expect(new DefaultDataExchange().importFormats()).toContain(".svg");
    });

    test("importSvg adds an editable shape node holding the scaled drawing", async () => {
        rs.stubGlobal("shapeFactory", factory);
        const addNode = rs.fn((_node: INode) => {});
        const document = createMockDocument({ modelManager: { addNode } });
        const file = new File([svg('<rect x="0" y="0" width="20" height="10"/>')], "Logo.svg");
        const result = await new DefaultDataExchange().importSvg(document, file, { scale: 2 });
        expect(result.isOk).toBe(true);
        const node = result.unchecked()!;
        expect(node).toBeInstanceOf(EditableShapeNode);
        expect(node.name).toBe("Logo.svg");
        expect(addNode).toHaveBeenCalledWith(node);
        expect((node.shape.unchecked() as IFace).area()).toBeCloseTo(40 * 20, 6);
    });

    test("the generic import routes .svg files and reports skipped text", async () => {
        rs.stubGlobal("shapeFactory", factory);
        const toasts: unknown[][] = [];
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(((...args: unknown[]) => {
            toasts.push(args);
        }) as typeof PubSub.default.pub);
        const addNode = rs.fn((_node: INode) => {});
        const document = createMockDocument({ modelManager: { addNode } });
        const file = new File([svg('<rect width="5" height="5"/><text>label</text>')], "part.SVG");
        await new DefaultDataExchange().import(document, [file]);
        expect(addNode).toHaveBeenCalledTimes(1);
        expect(pub).toHaveBeenCalled();
        expect(toasts).toContainEqual(["showToast", "toast.import.svgSkipped{0}", 1]);
    });

    test("an invalid SVG and a read-only document add nothing", async () => {
        rs.stubGlobal("shapeFactory", factory);
        const addNode = rs.fn((_node: INode) => {});
        const document = createMockDocument({ modelManager: { addNode } });
        const exchange = new DefaultDataExchange();
        expect((await exchange.importSvg(document, new File(["<svg"], "bad.svg"))).isOk).toBe(false);
        document.repository.isReadOnly = () => true;
        const valid = new File([svg('<rect width="5" height="5"/>')], "ok.svg");
        expect((await exchange.importSvg(document, valid)).isOk).toBe(false);
        expect(addNode).not.toHaveBeenCalled();
    });
});
