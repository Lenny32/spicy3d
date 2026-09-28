// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compareProfileGeometry, profileGeometryIssues } from "./profile-geometry.mjs";

const probe = () => ({
    algorithm: "ordered-bfs-v1",
    root: [0, 0],
    nodes: [
        {
            kind: 3,
            anchors: [
                [0, 0, 0],
                [1, 1, 1],
            ],
            children: [
                [1, 0],
                [2, 1],
            ],
        },
        { kind: 7, anchors: [0, 0, 0], children: [] },
        { kind: 7, anchors: [1, 1, 1], children: [] },
    ],
    faces: [[0, 0]],
    edges: [],
    vertices: [
        [1, 0],
        [2, 1],
    ],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    volume: 1,
});
test("explicit hybrid mode accepts representation changes only with independent matching geometry", () => {
    const comparison = {
        coldCleanBrepIdentical: false,
        cyclesCleanBrepIdentical: true,
        baselineCold: { geometryProbe: probe() },
        afterCold: { geometryProbe: probe() },
        afterCycles: { geometryProbe: probe() },
    };
    comparison.afterCold.geometryProbe.nodes[2].anchors[0] += 1e-12;
    assert.deepEqual(profileGeometryIssues(comparison, "hybrid"), []);
    for (const mode of ["main", "auto", "worker"])
        assert.ok(profileGeometryIssues(comparison, mode).includes("cold geometry-only BREP differs"));
});
for (const [name, change] of [
    [
        "same-count adjacency",
        (value) => {
            value.nodes[0].children.reverse();
        },
    ],
    [
        "orientation",
        (value) => {
            value.vertices[1][1] = 0;
        },
    ],
    [
        "geometry anchor",
        (value) => {
            value.nodes[1].anchors[0] += 0.01;
        },
    ],
    [
        "bounds",
        (value) => {
            value.bounds.max[0] += 0.01;
        },
    ],
    [
        "mass despite equal graph",
        (value) => {
            value.volume += 0.01;
        },
    ],
    [
        "nonfinite geometry",
        (value) => {
            value.nodes[1].anchors[0] = NaN;
        },
    ],
])
    test(`independent comparison rejects changed ${name}`, () => {
        const value = probe();
        change(value);
        assert.equal(compareProfileGeometry(probe(), value).ok, false);
    });
test("hybrid cannot pass on counts, claimed graph equality, or missing probes alone", () => {
    assert.ok(
        profileGeometryIssues(
            {
                coldCleanBrepIdentical: false,
                cyclesCleanBrepIdentical: true,
                orderedGraphMatch: true,
                faces: 1232,
            },
            "hybrid",
        ).length > 0,
    );
    assert.ok(profileGeometryIssues(undefined, "hybrid").length > 0);
});
test("main mode keeps the original strict byte checks", () => {
    assert.deepEqual(
        profileGeometryIssues({ coldCleanBrepIdentical: true, cyclesCleanBrepIdentical: true }),
        [],
    );
    assert.deepEqual(
        profileGeometryIssues({ coldCleanBrepIdentical: true, cyclesCleanBrepIdentical: false }),
        ["cycle geometry-only BREP differs"],
    );
});
