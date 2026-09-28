// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentMigrations, migrateDocument } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import { PARAMETRIC_FORMAT_VERSION } from "../src/migrations";

describe("parametric format 2 (extrudeTarget features)", () => {
    test("is the running version, reached from 1 without a gap", () => {
        expect(PARAMETRIC_FORMAT_VERSION).toBe(2);
        expect(DocumentMigrations.currentVersion("parametric")).toBe(2);
        expect(DocumentMigrations.findGaps()).toEqual([]);
    });

    test("a parametric 1 document migrates with its feature lists untouched", () => {
        const fixture = loadDocumentFixtures().find((x) => x.name === "v1/rich.json");
        expect(fixture).not.toBeUndefined();
        expect(fixture!.data["moduleVersions"]).toMatchObject({ parametric: 1 });
        const original = structuredClone(fixture!.data);

        const migrated = migrateDocument(fixture!.data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["moduleVersions"]).toMatchObject({ parametric: 2 });
        expect(migrated.value["models"]).toEqual(original["models"]);
        // Pure: the input is left as it was.
        expect(fixture!.data).toEqual(original);
    });

    test("a parametric 2 document with extrude targets needs no migration", () => {
        const fixture = loadDocumentFixtures().find((x) => x.name === "v1/parametric2-extrude-targets.json");
        expect(fixture).not.toBeUndefined();

        const migrated = migrateDocument(fixture!.data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["models"]).toEqual(fixture!.data["models"]);
        const right = (migrated.value["models"] as any).nodes.find((x: any) => x.id === "body-right");
        expect(JSON.parse(right.featuresJson)[1]).toEqual({
            id: "feature-slot-target",
            type: "extrudeTarget",
            bodyId: "body-left",
            featureId: "feature-slot",
        });
    });
});
