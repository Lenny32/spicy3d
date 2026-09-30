// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, type IFace, ShapeTypes } from "@spicy3d/core";
import { registerProfileEntities } from "../src/features/profileEntities";
import { profileSeeds } from "../src/features/profileSeeds";
import { MATCH_TOLERANCE } from "../src/features/refGeometry";

/** A region face bounded by `entities`, centered at (x, y) with a 2×2 box. */
function regionAt(x: number, y: number, entities: number[]): IFace {
    const face = {
        shapeType: ShapeTypes.face,
        boundingBox: () => new BoundingBox({ x: x - 1, y: y - 1, z: 0 }, { x: x + 1, y: y + 1, z: 0 }),
        area: () => 4,
    } as unknown as IFace;
    registerProfileEntities(face, entities);
    return face;
}

describe("profileSeeds", () => {
    test("regions sharing an entity set are suffixed in center order", () => {
        const seeds = profileSeeds([regionAt(10, 0, [1, 2]), regionAt(0, 0, [1, 2]), regionAt(5, 0, [1, 2])]);
        expect(seeds).toEqual(["e1.2~2", "e1.2", "e1.2~1"]);
    });

    // Vertically stacked crossing circles: the regions share their center x up to the
    // box computation's floating-point noise, which must not decide the order.
    test.each([
        { name: "lower region's x noisily larger", lowerX: 1e-9, upperX: 0 },
        { name: "lower region's x noisily smaller", lowerX: -1e-9, upperX: 0 },
    ])("x within tolerance falls through to y ($name)", ({ lowerX, upperX }) => {
        const seeds = profileSeeds([regionAt(upperX, 5, [3, 4]), regionAt(lowerX, -5, [3, 4])]);
        expect(seeds).toEqual(["e3.4~1", "e3.4"]);
    });

    test.each(
        [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ].map((order) => ({ order })),
    )("overlapping tolerance ranges keep identities for order $order", ({ order }) => {
        // Pairwise fuzzy ordering cycles: A < C on x, C < B on y, B < A on y.
        const faces = [
            regionAt(0, 2, [3, 4]),
            regionAt(0.75 * MATCH_TOLERANCE, 1, [3, 4]),
            regionAt(1.5 * MATCH_TOLERANCE, 0, [3, 4]),
        ];
        const expected = ["e3.4~1", "e3.4", "e3.4~2"];
        expect(profileSeeds(order.map((index) => faces[index]))).toEqual(
            order.map((index) => expected[index]),
        );
    });
});
