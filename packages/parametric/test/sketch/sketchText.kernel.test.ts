// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    DOCUMENT_FORMAT_VERSION,
    DocumentMigrations,
    decodeDocumentFile,
    encodeDocumentFile,
    type IFace,
    mergeDocuments,
    Plane,
    ShapeTypes,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { resolveProfiles, sketchProfiles } from "../../src/features/profileBuilder";
import { collectEdges } from "../../src/features/profileGeometry";
import { captureProfileRef } from "../../src/features/profileRef";
import "../../src/migrations";
import "../../src/mergeRules";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { randomSketchIds } from "../../src/sketch/sketchIds";
import { type SketchData, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { SketchSolver } from "../../src/sketch/solver";
import { addTextGeometry, type TextOutlineOptions } from "../../src/sketch/textGeometry";
import { copySketchSelection } from "../../src/sketch/utilityOperations";
import "./setup";

const previousFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(resolve(import.meta.dirname, "../../../wasm/lib/spicy-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (previousFactory) Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    else Reflect.deleteProperty(globalThis, "shapeFactory");
});

function newDocument(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    return doc;
}

function textData(value: string, extra: Partial<TextOutlineOptions> = {}): SketchData {
    const solver = new SketchSolver(Plane.XY);
    try {
        const added = solver.addText({
            value,
            x: 5,
            y: 5,
            height: 10,
            angle: 0,
            frame: { width: 80, height: 10 },
            verticalAlignment: "top",
            ...extra,
        });
        expect(added.isOk).toBe(true);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        return solver.toData();
    } finally {
        solver.dispose();
    }
}

function textSketch(doc: TestDocument, data: SketchData): SketchNode {
    const node = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(node);
    return node;
}

const wires = (face: IFace) => face.findSubShapes(ShapeTypes.wire).length;

test.each([
    ["Ao", [2, 2]],
    ["B", [3]],
    ["e", [2]],
    ["i", [1, 1]],
])("%s preserves glyph contours and holes", (value, counts) => {
    const sketch = textSketch(newDocument(), textData(value));
    const profiles = sketchProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer.map(wires)).toEqual(counts);
});

test("cap height and rotated placement have the requested dimensions", () => {
    const doc = newDocument();
    const normal = textSketch(doc, textData("H"));
    expect(normal.shape.isOk).toBe(true);
    const box = normal.shape.value.boundingBox();
    expect(box.min.y).toBeCloseTo(5, 6);
    expect(box.max.y).toBeCloseTo(15, 6);
    const rotated = textSketch(doc, textData("H", { x: 0, y: 0, angle: 90 }));
    expect(rotated.shape.isOk).toBe(true);
    const turned = rotated.shape.value.boundingBox();
    expect(turned.min.x).toBeCloseTo(-10, 6);
    expect(turned.max.x).toBeCloseTo(0, 6);
    expect(turned.max.y - turned.min.y).toBeCloseTo(box.max.x - box.min.x, 6);
});

test("newlines use deterministic cap-height spacing", () => {
    const sketch = textSketch(newDocument(), textData("H\nH"));
    const profiles = sketchProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer).toHaveLength(2);
    expect(sketch.shape.value.boundingBox().min.y).toBeCloseTo(-11, 6);
    expect(sketch.shape.value.boundingBox().max.y).toBeCloseTo(15, 6);
});

test.each(["Ao", "B", "Spicy3D", "é—€"])("%s extrudes its complete profiles with holes", (value) => {
    const doc = newDocument();
    const sketch = textSketch(doc, textData(value));
    const profiles = sketchProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    const area = profiles.value.outer.reduce((sum, face) => sum + face.area(), 0);
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "text-extrude",
                type: "extrude",
                sketchId: sketch.id,
                depth: 2,
                profiles: profiles.value.outer.map((face) => captureProfileRef(face)),
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(area * 2, 5);
});

test("text contour identities map every kernel edge without colliding with geometry", () => {
    const data = textData("ab");
    data.entities.unshift({ id: 10000, type: "circle", params: [-20, 0, 3] });
    const sketch = textSketch(newDocument(), data);
    expect(sketch.shape.isOk).toBe(true);
    const ids = shapeEntityIds(data);
    expect(ids).toHaveLength(collectEdges(sketch.shape.value).length);
    expect(new Set(ids).size).toBe(1 + data.texts![0].profileIds.length);
    expect(ids[0]).toBe(10000);
});

test("profile references and seeds survive solving, reordering and rigid transforms", () => {
    const doc = newDocument();
    const data = textData("Ao");
    const sketch = textSketch(doc, data);
    const initial = resolveProfiles(sketch);
    expect(initial.isOk).toBe(true);
    const refs = initial.value.map(({ face }) => captureProfileRef(face));
    const areas = initial.value.map(({ face }) => face.area());
    expect(refs.every((ref) => (ref.entities?.length ?? 0) > 0)).toBe(true);
    const solver = new SketchSolver(Plane.XY, data);
    try {
        const moved = solver.applyTransform(
            data.texts!.map((text) => text.id),
            {
                kind: "rotate",
                center: [5, 5],
                angle: Math.PI / 3,
            },
        );
        expect(moved.isOk).toBe(true);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const changed = solver.toData();
        changed.entities.reverse();
        sketch.setDataEmitShapeChanged(changed);
        const resolved = resolveProfiles(sketch, refs);
        expect(resolved.isOk).toBe(true);
        expect(resolved.value.map((p) => p.seed)).toEqual(initial.value.map((p) => p.seed));
        for (const [index, profile] of resolved.value.entries())
            expect(profile.face.area()).toBeCloseTo(areas[index], 5);
    } finally {
        solver.dispose();
    }
});

test("copy/paste, move and mirror retain curves, closure and holes with fresh ids", () => {
    const data = textData("Ao");
    const ids = data.texts!.map((text) => text.id);
    const clipboard = copySketchSelection(data, ids);
    expect(clipboard.isOk).toBe(true);
    const solver = new SketchSolver(Plane.XY, data, undefined, randomSketchIds);
    try {
        const pasted = solver.applyTransform([], { kind: "move", delta: [30, 0] }, clipboard.value);
        expect(pasted.isOk).toBe(true);
        expect(pasted.value).toHaveLength(ids.length);
        expect(pasted.value.every((id) => !ids.includes(id))).toBe(true);
        const mirror = solver.applyTransform(pasted.value, {
            kind: "mirror",
            axis: { id: 0, type: "line", params: [0, 0, 0, 1] },
        });
        expect(mirror.isOk).toBe(true);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const sketch = textSketch(newDocument(), solver.toData());
        const profiles = sketchProfiles(sketch);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outer.map(wires)).toEqual([2, 2, 2, 2]);
    } finally {
        solver.dispose();
    }
});

test("a spicy file reopens exact outlines and an extrusion with glyph holes", async () => {
    const doc = newDocument();
    const sketch = textSketch(doc, textData("O"));
    const profiles = sketchProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    const area = profiles.value.outer[0].area();
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "text-extrude",
                type: "extrude",
                sketchId: sketch.id,
                depth: 2,
                profiles: [captureProfileRef(profiles.value.outer[0])],
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(area * 2, 5);
    const envelope = {
        __cla$$__: "Document",
        formatVersion: DOCUMENT_FORMAT_VERSION,
        moduleVersions: DocumentMigrations.moduleVersions(),
        models: doc.modelManager.serialize(),
    };
    expect(envelope.moduleVersions["sketch"]).toBe(4);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(envelope));
    expect(decoded.isOk).toBe(true);
    const reopened = newDocument();
    await reopened.modelManager.deserialize(decoded.value["models"]);
    const restored = reopened.modelManager.findNode((node) => node.id === sketch.id) as SketchNode;
    expect(restored.data).toEqual(sketch.data);
    expect(Object.keys(restored.data).sort()).toEqual(["constraints", "entities", "texts"]);
    expect(restored.data.texts![0].value).toBe("O");
    expect(restored.data.entities.every((e) => e.type === "line" || e.type === "bspline")).toBe(true);
    const restoredProfiles = sketchProfiles(restored);
    expect(restoredProfiles.isOk).toBe(true);
    expect(restoredProfiles.value.outer.map(wires)).toEqual([2]);
    const extrude = reopened.modelManager.findNode((node) => node.id === body.id) as ParametricBodyNode;
    expect(extrude.shape.isOk).toBe(true);
    expect(extrude.shape.value.volume()).toBeCloseTo(area * 2, 5);
    expect(reopened.modelManager.serialize()).toEqual(envelope.models);
});

test("persistent profile references survive size edits and text object reordering", () => {
    const doc = newDocument(),
        data = textData("Ao");
    const solver = new SketchSolver(Plane.XY, data);
    try {
        const extra = solver.addText({
            value: "B",
            x: 100,
            y: 0,
            height: 10,
            angle: 0,
            frame: { width: 20, height: 20 },
        });
        expect(extra.isOk).toBe(true);
        const sketch = textSketch(doc, solver.toData());
        const initial = resolveProfiles(sketch);
        expect(initial.isOk).toBe(true);
        const refs = initial.value.map(({ face }) => captureProfileRef(face));
        const initialWires = initial.value.map(({ face }) => wires(face));
        expect(solver.updateText(data.texts![0].id, { height: 12, angle: 25 }).isOk).toBe(true);
        const changed = solver.toData();
        changed.texts!.reverse();
        sketch.setDataEmitShapeChanged(changed);
        const resolved = resolveProfiles(sketch, refs);
        expect(resolved.isOk).toBe(true);
        expect(resolved.value.map((profile) => profile.seed)).toEqual(
            initial.value.map((profile) => profile.seed),
        );
        expect(resolved.value.map(({ face }) => wires(face))).toEqual(initialWires);
    } finally {
        solver.dispose();
    }
});

test("exploding text creates exact solver geometry with the same holes and area", () => {
    const data = textData("Ao"),
        doc = newDocument();
    const before = sketchProfiles(textSketch(doc, data));
    expect(before.isOk).toBe(true);
    const solver = new SketchSolver(Plane.XY, data);
    try {
        const result = addTextGeometry(solver, data.texts![0]);
        expect(result.isOk).toBe(true);
        expect(solver.removeText(data.texts![0].id)).toBe(true);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const after = sketchProfiles(textSketch(doc, solver.toData()));
        expect(after.isOk).toBe(true);
        expect(after.value.outer.map(wires)).toEqual([2, 2]);
        expect(after.value.outer.reduce((sum, face) => sum + face.area(), 0)).toBeCloseTo(
            before.value.outer.reduce((sum, face) => sum + face.area(), 0),
            6,
        );
    } finally {
        solver.dispose();
    }
});

test("the saved sketch v4 fixture reopens editable text and its explicit extrusion", async () => {
    const stored = JSON.parse(
        readFileSync(
            resolve(import.meta.dirname, "../../../core/test/fixtures/documents/v2/sketch4-text.json"),
            "utf8",
        ),
    );
    const doc = newDocument();
    await doc.modelManager.deserialize(stored.models);
    const sketch = doc.modelManager.findNode((node) => node.id === "sketch-text") as SketchNode;
    expect(sketch.data.texts![0]).toMatchObject({ value: "O", profileIds: [11, 12] });
    const profiles = sketchProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer.map(wires)).toEqual([2]);
    const body = doc.modelManager.findNode((node) => node.id === "body-text") as ParametricBodyNode;
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(profiles.value.outer[0].area() * 2, 5);
});

test("concurrent content and height edits retain editable records through solving and extrusion", async () => {
    const base = JSON.parse(
        readFileSync(
            resolve(import.meta.dirname, "../../../core/test/fixtures/documents/v2/sketch4-text.json"),
            "utf8",
        ),
    );
    const change = (patch: object) => {
        const copy = structuredClone(base),
            sketch = copy.models.nodes.find((node: { id: string }) => node.id === "sketch-text");
        const data = JSON.parse(sketch.dataJson);
        Object.assign(data.texts[0], patch);
        sketch.dataJson = JSON.stringify(data);
        return copy;
    };
    const merged = mergeDocuments(
        base,
        change({ value: "B", profileIds: [11, 12, 13] }),
        change({ height: 12 }),
    );
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toEqual([]);
    const doc = newDocument();
    await doc.modelManager.deserialize(merged.value.merged["models"]);
    const sketch = doc.modelManager.findNode((node) => node.id === "sketch-text") as SketchNode;
    const solver = new SketchSolver(Plane.XY, sketch.data);
    try {
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.toData().texts![0]).toMatchObject({ value: "B", height: 12, profileIds: [11, 12, 13] });
        sketch.setDataEmitShapeChanged(solver.toData());
        const profiles = sketchProfiles(sketch);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outer.map(wires)).toEqual([3]);
        const body = doc.modelManager.findNode((node) => node.id === "body-text") as ParametricBodyNode;
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(profiles.value.outer[0].area() * 2, 5);
    } finally {
        solver.dispose();
    }
});
