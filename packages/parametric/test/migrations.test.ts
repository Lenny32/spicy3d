// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentMigrations, migrateDocument } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import { PARAMETRIC_FORMAT_VERSION } from "../src/migrations";

function fixture(name: string) {
    const found = loadDocumentFixtures().find((x) => x.name === name);
    expect(found).not.toBeUndefined();
    return found!;
}

describe("parametric format 3 (extrude extents)", () => {
    test("is the running version, reached from 1 without a gap", () => {
        expect(PARAMETRIC_FORMAT_VERSION).toBe(3);
        expect(DocumentMigrations.currentVersion("parametric")).toBe(3);
        expect(DocumentMigrations.findGaps()).toEqual([]);
    });

    test.each([
        ["v1/rich.json", 1],
        ["v1/parametric2-extrude-targets.json", 2],
    ])("%s (parametric %i) migrates with its feature lists untouched", (name, version) => {
        const { data } = fixture(name);
        expect(data["moduleVersions"]).toMatchObject({ parametric: version });
        const original = structuredClone(data);

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["moduleVersions"]).toMatchObject({ parametric: 3 });
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

    test("a parametric 3 document with extents needs no migration", () => {
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
});
