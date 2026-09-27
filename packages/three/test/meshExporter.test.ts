// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { VisualNode } from "@spicy3d/core";
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { ThreeMeshExporter } from "../src/meshExporter";
import { createThreeMockVisualContext } from "./mocks";

describe("ThreeMeshExporter", () => {
    let meshesToDispose: Mesh[] = [];

    afterEach(() => {
        for (const mesh of meshesToDispose) {
            mesh.geometry?.dispose();
            (mesh.material as MeshBasicMaterial)?.dispose();
        }
        meshesToDispose = [];
    });

    test("exportToObj returns a Result", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToObj([]);
        expect(result.isOk).toBe(true);
        expect(typeof result.unchecked()).toBe("string");
    });

    test("exportToStl returns a Result with binary mode", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToStl([], false);
        expect(result.isOk).toBe(true);
    });

    test("exportToStl returns a Result with ascii mode", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToStl([], true);
        expect(result.isOk).toBe(true);
    });

    test("exportToPly returns ok for empty input", () => {
        const context = createThreeMockVisualContext();
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToPly([], false);
        expect(result.isOk).toBe(true);
    });

    test("export includes meshes from visual objects", () => {
        const mockNode = { id: "test-node-1" } as unknown as VisualNode;
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), 3));
        geo.computeBoundingBox();

        const mesh = new Mesh(geo, new MeshBasicMaterial());
        meshesToDispose.push(mesh);

        const parent = new Group();
        parent.add(mesh);

        const visualMap = new Map<VisualNode, Mesh>();
        visualMap.set(mockNode, parent as any);

        const context = createThreeMockVisualContext(visualMap);
        const exporter = new ThreeMeshExporter(context);

        const result = exporter.exportToObj([mockNode]);
        expect(result.isOk).toBe(true);
        expect(typeof result.unchecked()).toBe("string");
    });

    function createTriangleContext(positions: number[], index?: number[]) {
        const mockNode = { id: "test-node-triangle" } as unknown as VisualNode;
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
        if (index) geo.setIndex(index);

        const mesh = new Mesh(geo, new MeshBasicMaterial());
        meshesToDispose.push(mesh);

        const parent = new Group();
        parent.add(mesh);

        const visualMap = new Map<VisualNode, Mesh>();
        visualMap.set(mockNode, parent as any);

        return { mockNode, exporter: new ThreeMeshExporter(createThreeMockVisualContext(visualMap)) };
    }

    test("exportToObj output contains the expected vertex coordinates", () => {
        const { mockNode, exporter } = createTriangleContext([0, 0, 0, 2, 0, 0, 0, 2, 0]);

        const result = exporter.exportToObj([mockNode]);

        expect(result.isOk).toBe(true);
        const obj = result.unchecked() as string;
        expect(obj).toContain("v 0 0 0");
        expect(obj).toContain("v 2 0 0");
        expect(obj).toContain("v 0 2 0");
        expect(obj).toContain("f 1 2 3");
    });

    test("exportToStl ascii output contains the expected vertex coordinates", () => {
        const { mockNode, exporter } = createTriangleContext([0, 0, 0, 2, 0, 0, 0, 2, 0]);

        const result = exporter.exportToStl([mockNode], true);

        expect(result.isOk).toBe(true);
        const stl = result.unchecked() as string;
        expect(stl).toContain("facet normal");
        expect(stl).toContain("vertex 0 0 0");
        expect(stl).toContain("vertex 2 0 0");
        expect(stl).toContain("vertex 0 2 0");
    });

    test("exportToPly returns err when indices are not divisible by 3", () => {
        const { mockNode, exporter } = createTriangleContext([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1]);

        const result = exporter.exportToPly([mockNode], true);

        expect(result.isOk).toBe(false);
        expect(result.error).toBe("can not export to ply");
    });
});
