// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IndexedMesh, LENGTH_UNITS_LIST } from "@spicy3d/core";
import {
    THREE_MF_CORE_NAMESPACE,
    THREE_MF_MODEL_PATH,
    THREE_MF_UNITS,
    threeMfColor,
    threeMfModelXml,
    write3mf,
} from "../src/threeMf";

/** One triangle; enough for the package and object structure. */
const TRIANGLE: IndexedMesh = {
    vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangles: new Uint32Array([0, 1, 2]),
};

function parse(xml: string): Document {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
    return parsed;
}

function elements(parsed: Document, name: string): Element[] {
    return Array.from(parsed.getElementsByTagName(name));
}

async function unzip(bytes: Uint8Array) {
    const { default: JSZip } = await import("jszip");
    return JSZip.loadAsync(bytes);
}

describe("write3mf", () => {
    test("writes the OPC parts: content types, the StartPart relationship and the model part", async () => {
        const zip = await unzip(await write3mf({ unit: "mm", objects: [{ name: "a", mesh: TRIANGLE }] }));

        expect(
            Object.keys(zip.files)
                .filter((name) => !zip.files[name].dir)
                .sort(),
        ).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
        const types = parse(await zip.file("[Content_Types].xml")!.async("string"));
        const defaults = elements(types, "Default").map((element) => [
            element.getAttribute("Extension"),
            element.getAttribute("ContentType"),
        ]);
        expect(defaults).toEqual([
            ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
            ["model", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"],
        ]);
        const rels = parse(await zip.file("_rels/.rels")!.async("string"));
        const [relationship] = elements(rels, "Relationship");
        expect(relationship.getAttribute("Target")).toBe(`/${THREE_MF_MODEL_PATH}`);
        expect(relationship.getAttribute("Type")).toBe(
            "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel",
        );
        const model = parse(await zip.file(THREE_MF_MODEL_PATH)!.async("string"));
        expect(model.documentElement.localName).toBe("model");
    });
});

describe("threeMfModelXml", () => {
    test.each(
        LENGTH_UNITS_LIST.map((unit) => ({ unit, expected: THREE_MF_UNITS[unit] })),
    )("declares the core namespace and unit $expected for $unit", ({ unit, expected }) => {
        const model = parse(threeMfModelXml({ unit, objects: [{ name: "a", mesh: TRIANGLE }] }));

        expect(model.documentElement.namespaceURI).toBe(THREE_MF_CORE_NAMESPACE);
        expect(model.documentElement.getAttribute("unit")).toBe(expected);
        expect(model.documentElement.getAttribute("xml:lang")).toBe("en-US");
    });

    test("maps each length unit to its 3MF name", () => {
        expect(THREE_MF_UNITS).toEqual({ mm: "millimeter", cm: "centimeter", m: "meter", in: "inch" });
    });

    test("writes one named object and one build item per object, with its indexed mesh", () => {
        const square: IndexedMesh = {
            vertices: new Float64Array([0, 0, 0, 2.5, 0, 0, 2.5, 2.5, 0, 0, 2.5, -0]),
            triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
        };
        const model = parse(
            threeMfModelXml({
                unit: "mm",
                objects: [
                    { name: "Box", mesh: square },
                    { name: "Cylinder", mesh: TRIANGLE },
                ],
            }),
        );

        const objects = elements(model, "object");
        expect(objects.map((object) => object.getAttribute("name"))).toEqual(["Box", "Cylinder"]);
        expect(objects.map((object) => object.getAttribute("type"))).toEqual(["model", "model"]);
        const ids = objects.map((object) => object.getAttribute("id"));
        expect(new Set(ids).size).toBe(2);
        expect(elements(model, "item").map((item) => item.getAttribute("objectid"))).toEqual(ids);
        const vertices = Array.from(objects[0].getElementsByTagName("vertex")).map((vertex) =>
            ["x", "y", "z"].map((axis) => vertex.getAttribute(axis)),
        );
        expect(vertices).toEqual([
            ["0", "0", "0"],
            ["2.5", "0", "0"],
            ["2.5", "2.5", "0"],
            ["0", "2.5", "0"],
        ]);
        const triangles = Array.from(objects[0].getElementsByTagName("triangle")).map((triangle) =>
            ["v1", "v2", "v3"].map((v) => triangle.getAttribute(v)),
        );
        expect(triangles).toEqual([
            ["0", "1", "2"],
            ["0", "2", "3"],
        ]);
    });

    test("points each object at its base material, one base per material in order of use", () => {
        const red = { name: "Red", color: "#FF0000" };
        const blue = { name: "Blue", color: "#0000FF" };
        const model = parse(
            threeMfModelXml({
                unit: "mm",
                objects: [
                    { name: "a", mesh: TRIANGLE, material: red },
                    { name: "b", mesh: TRIANGLE, material: blue },
                    { name: "c", mesh: TRIANGLE, material: red },
                    { name: "d", mesh: TRIANGLE },
                ],
            }),
        );

        const [group] = elements(model, "basematerials");
        const bases = elements(model, "base").map((base) => [
            base.getAttribute("name"),
            base.getAttribute("displaycolor"),
        ]);
        expect(bases).toEqual([
            ["Red", "#FF0000"],
            ["Blue", "#0000FF"],
        ]);
        const objects = elements(model, "object");
        expect(objects.map((object) => object.getAttribute("pid"))).toEqual([
            group.getAttribute("id"),
            group.getAttribute("id"),
            group.getAttribute("id"),
            null,
        ]);
        expect(objects.map((object) => object.getAttribute("pindex"))).toEqual(["0", "1", "0", null]);
        // Resource ids are unique across kinds.
        const ids = [group, ...objects].map((element) => element.getAttribute("id"));
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("writes no basematerials group when no object has a material", () => {
        const model = parse(threeMfModelXml({ unit: "mm", objects: [{ name: "a", mesh: TRIANGLE }] }));

        expect(elements(model, "basematerials")).toHaveLength(0);
        expect(elements(model, "object")[0].getAttribute("pid")).toBeNull();
    });

    test("escapes names and metadata", () => {
        const name = `Bracket <"left"> & 'right'`;
        const model = parse(
            threeMfModelXml({
                unit: "mm",
                title: "A & B <draft>",
                creationDate: "2026-10-15",
                objects: [{ name, mesh: TRIANGLE, material: { name: "PLA & co", color: "#123456" } }],
            }),
        );

        expect(elements(model, "object")[0].getAttribute("name")).toBe(name);
        expect(elements(model, "base")[0].getAttribute("name")).toBe("PLA & co");
        const metadata = Object.fromEntries(
            elements(model, "metadata").map((entry) => [entry.getAttribute("name"), entry.textContent]),
        );
        expect(metadata).toEqual({
            Title: "A & B <draft>",
            Application: "Spicy3D",
            CreationDate: "2026-10-15",
        });
    });

    test("writes coordinates with 9 significant digits and no -0", () => {
        const mesh: IndexedMesh = {
            vertices: new Float64Array([0.1 + 0.2, -0, 1 / 3, 1, 0, 0, 0, 1, 0]),
            triangles: new Uint32Array([0, 1, 2]),
        };
        const model = parse(threeMfModelXml({ unit: "mm", objects: [{ name: "a", mesh }] }));

        const [first] = elements(model, "vertex");
        expect(["x", "y", "z"].map((axis) => first.getAttribute(axis))).toEqual(["0.3", "0", "0.333333333"]);
    });
});

describe("threeMfColor", () => {
    test.each([
        { color: 0xff8000, expected: "#FF8000" },
        { color: 0x000001, expected: "#000001" },
        { color: "#abc", expected: "#AABBCC" },
        { color: "#11223344", expected: "#112233" },
        { color: "a1b2c3", expected: "#A1B2C3" },
        { color: "red", expected: undefined },
        { color: -1, expected: undefined },
        { color: 1.5, expected: undefined },
        { color: undefined, expected: undefined },
    ])("maps $color to $expected", ({ color, expected }) => {
        expect(threeMfColor(color)).toBe(expected);
    });
});
