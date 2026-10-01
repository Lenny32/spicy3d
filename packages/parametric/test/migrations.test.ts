// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentMigrations, migrateDocument } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import { PARAMETRIC_FORMAT_VERSION, SKETCH_FORMAT_VERSION } from "../src/migrations";

function fixture(name: string) {
    const found = loadDocumentFixtures().find((x) => x.name === name);
    expect(found).not.toBeUndefined();
    return found!;
}

describe("parametric format 14 (emboss/deboss)", () => {
    test("is the running version, reached from 1 without a gap", () => {
        expect(PARAMETRIC_FORMAT_VERSION).toBe(14);
        expect(DocumentMigrations.currentVersion("parametric")).toBe(14);
        expect(DocumentMigrations.findGaps()).toEqual([]);
    });

    test.each([
        ["v1/rich.json", 1],
        ["v1/parametric2-extrude-targets.json", 2],
        ["v1/parametric3-extrude-extents.json", 3],
        ["v1/parametric4-loft.json", 4],
        ["v2/construction-expressions.json", 4],
        ["v2/parametric5-thicken.json", 5],
        ["v2/parametric6-from-face.json", 6],
        ["v2/parametric7-variable-fillet.json", 7],
        ["v2/parametric8-next.json", 8],
        ["v2/parametric9-sweep.json", 9],
        ["v2/parametric10-projection.json", 10],
        ["v2/parametric11-face-sweep.json", 11],
        ["v2/parametric12-corner-setback.json", 12],
        ["v2/parametric13-guided-loft.json", 13],
        ["v2/parametric14-emboss.json", 14],
    ])("%s (parametric %i) migrates with its feature lists untouched", (name, version) => {
        const { data } = fixture(name);
        expect(data["moduleVersions"]).toMatchObject({ parametric: version });
        const original = structuredClone(data);

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["moduleVersions"]).toMatchObject({ parametric: 14 });
        expect(migrated.value["models"]).toEqual(original["models"]);
        // Pure: the input is left as it was.
        expect(data).toEqual(original);
    });

    test("an extrude without an extent is still a blind distance after migrating", () => {
        const { data } = fixture("v1/parametric2-extrude-targets.json");

        const migrated = migrateDocument(data);

        const left = (migrated.value["models"] as any).nodes.find((x: any) => x.id === "body-left");
        const slot = JSON.parse(left.featuresJson)[1];
        expect(slot).toMatchObject({ id: "feature-slot", type: "extrude", depth: -5, operation: "cut" });
        expect(slot.extent).toBeUndefined();
    });

    test("a parametric 3 document keeps its extents through the migration", () => {
        const { data } = fixture("v1/parametric3-extrude-extents.json");
        expect(data["moduleVersions"]).toMatchObject({ parametric: 3 });

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["models"]).toEqual(data["models"]);
        const extents = (migrated.value["models"] as any).nodes
            .filter((x: any) => x.__cla$$__ === "ParametricBodyNode")
            .flatMap((x: any) => JSON.parse(x.featuresJson))
            .flatMap((x: any) => (x.extent === undefined ? [] : [x.extent.type]));
        expect(extents.sort()).toEqual(["throughAll", "toObject"]);
    });

    test("a parametric 4 document keeps its lofts through the migration", () => {
        const { data } = fixture("v1/parametric4-loft.json");
        expect(data["moduleVersions"]).toMatchObject({ parametric: 4 });

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["models"]).toEqual(data["models"]);
        const lofts = (migrated.value["models"] as any).nodes
            .filter((x: any) => x.__cla$$__ === "ParametricBodyNode")
            .flatMap((x: any) => JSON.parse(x.featuresJson))
            .map((x: any) => [x.type, x.sections.length]);
        expect(lofts).toEqual([
            ["loft", 3],
            ["loft", 2],
        ]);
    });

    test("a parametric 5 document keeps its thickens unchanged", () => {
        const { data } = fixture("v2/parametric5-thicken.json");
        expect(data["moduleVersions"]).toMatchObject({ parametric: 5 });

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["models"]).toEqual(data["models"]);
        const thickens = (migrated.value["models"] as any).nodes
            .filter((x: any) => x.__cla$$__ === "ParametricBodyNode")
            .flatMap((x: any) => JSON.parse(x.featuresJson))
            .filter((x: any) => x.type === "thicken")
            .map((x: any) => [x.thickness, x.openFaces?.length ?? 0]);
        expect(thickens).toEqual([
            ["-wall_t", 1],
            ["wall_t", 0],
        ]);
    });
});

/** Names of the fixtures stored at sketch format 1. */
function sketchV1Fixtures(): string[] {
    return loadDocumentFixtures()
        .filter((x) => (x.data["moduleVersions"] as Record<string, number> | undefined)?.["sketch"] === 1)
        .map((x) => x.name);
}

describe("sketch format 3 (control NURBS)", () => {
    test("is the running version, reached from 1 without a gap", () => {
        expect(SKETCH_FORMAT_VERSION).toBe(3);
        expect(DocumentMigrations.currentVersion("sketch")).toBe(3);
        expect(DocumentMigrations.findGaps()).toEqual([]);
    });

    test.each(sketchV1Fixtures())("%s (sketch 1) migrates with its sketches untouched", (name) => {
        const { data } = fixture(name);
        const original = structuredClone(data);

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["moduleVersions"]).toMatchObject({ sketch: 3 });
        expect(migrated.value["models"]).toEqual(original["models"]);
        expect(data).toEqual(original);
    });

    test("the sketch 1 corpus the migration test runs on is not empty", () => {
        expect(sketchV1Fixtures().length).toBeGreaterThan(0);
    });

    test("a sketch 2 document migrates with fit bsplines unchanged", () => {
        const { data } = fixture("v2/sketch2-bspline.json");
        expect(data["moduleVersions"]).toMatchObject({ sketch: 2 });

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["models"]).toEqual(data["models"]);
        const entities = (migrated.value["models"] as any).nodes
            .filter((x: any) => x.__cla$$__ === "SketchNode")
            .flatMap((x: any) => JSON.parse(x.dataJson).entities)
            .filter((x: any) => x.type === "bspline")
            .map((x: any) => [x.params.length / 2, x.parametrization, x.periodic ?? false]);
        expect(entities).toEqual([
            [5, "chord", false],
            [5, "centripetal", true],
        ]);
    });
});
