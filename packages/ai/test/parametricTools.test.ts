// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { I18n } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import * as parametric from "@spicy3d/parametric";
import { SKETCH_ACTION_NAMES } from "@spicy3d/parametric";
import { buildTools } from "../src/tools";
import { buildParametricTools } from "../src/tools/parametricTools";
import { isProgramJobTool } from "../src/tools/programJobs";

const runParametric = () => buildParametricTools().find((tool) => tool.name === "run_parametric")!;

interface OpsSchema {
    properties: { op: { enum: string[] } };
    required: string[];
}

/** The tool's op schema, reached through the JSON the providers send. */
const opsSchema = () => (runParametric().parameters as any).properties.ops.items as OpsSchema;

describe("parametricTools", () => {
    test("run_parametric is registered, and appended after the shipped tools", () => {
        const names = buildTools().map((tool) => tool.name);
        expect(names).toContain("run_parametric");
        // The API matches the cached prompt prefix in order tools -> system -> messages, so a
        // tool inserted anywhere but the end would invalidate the cached list of every
        // conversation that started before it existed. load_skill is the last shipped tool.
        expect(names.indexOf("run_parametric")).toBeGreaterThan(names.indexOf("load_skill"));
    });

    test("the op schema enumerates every supported op", () => {
        expect(opsSchema().properties.op.enum).toEqual([
            "sketch",
            "extrude",
            "revolve",
            "loft",
            "editLoft",
            "sweep",
            "editSweep",
            "faceSweep",
            "editFaceSweep",
            "projection",
            "fillet",
            "chamfer",
            "thicken",
            "boolean",
            "editFeature",
            "features",
            "edges",
            "faces",
            "editSketch",
            "sketchInfo",
            "construct",
            "editConstruction",
            "constructionInfo",
        ]);
        expect(opsSchema().required).toEqual(["op"]);
        expect((runParametric().parameters as any).required).toEqual(["ops"]);
    });

    test("tolerant thicken is a boolean option without top-level schema unions", () => {
        const schema = runParametric().parameters as any;
        expect(opsSchema().properties).toHaveProperty(
            "tolerant",
            expect.objectContaining({ type: "boolean" }),
        );
        for (const key of ["oneOf", "anyOf", "allOf"]) {
            expect(schema).not.toHaveProperty(key);
            expect(opsSchema()).not.toHaveProperty(key);
        }
    });

    test("edge queries advertise origin, adjacency, outline, curve and analytic selectors", () => {
        const properties = (opsSchema() as any).properties;
        expect(Object.keys(properties.selector.anyOf[0].properties)).toEqual([
            "featureIds",
            "adjoiningFaces",
            "outlineOfFaces",
            "curves",
            "geometry",
            "tolerance",
        ]);
        expect(properties.selector.anyOf[0].additionalProperties).toBe(false);
        expect(properties.expectedCount.minimum).toBe(1);
        expect(properties.selector.anyOf[0].properties.geometry.properties.elevation.required).toEqual([
            "value",
        ]);
    });

    test("face queries and extrusion picks advertise tracked ids and face predicates", () => {
        const properties = (opsSchema() as any).properties;
        const selector = properties.selector.anyOf[1];
        expect(Object.keys(selector.properties)).toEqual([
            "faceIds",
            "featureIds",
            "containsPoint",
            "largest",
            "tolerance",
        ]);
        expect(selector.additionalProperties).toBe(false);
        expect(properties.startFace.properties.selector).toEqual(selector);
        expect(properties.startFace.required).toEqual(["nodeId"]);
        expect(properties.startFace.oneOf).toEqual([
            { required: ["faceIndex"] },
            { required: ["faceId"] },
            { required: ["selector"] },
        ]);
    });

    test("corner insertion and historical edge queries advertise a nonnegative integer position", () => {
        const index = (opsSchema() as any).properties.index;
        expect(index.type).toBe("integer");
        expect(index.minimum).toBe(0);
        expect(index.description).toContain("fillet/chamfer");
        expect(index.description).toContain("edges");
    });

    test("the sketch schema offers every entity type and every engine action", () => {
        const properties = (opsSchema() as any).properties;
        expect(properties.entities.items.properties.type.enum).toEqual([
            "line",
            "circle",
            "arc",
            "point",
            "ellipse",
            "spline",
            "bspline",
        ]);
        expect(properties.entities.items.properties.parametrization.enum).toEqual([
            "chord",
            "centripetal",
            "uniform",
        ]);
        expect(properties.entities.items.properties.periodic.type).toBe("boolean");
        expect(properties.entities.items.properties.construction.type).toBe("boolean");
        // The schema is the only place a client learns an action exists — keep it in step with the engine.
        expect(properties.actions.items.properties.action.enum).toEqual([...SKETCH_ACTION_NAMES]);
    });

    test("returns the no-document error rather than throwing", async () => {
        const result = await runParametric().handler({ ops: [{ op: "features", body: "b1" }] });
        expect(JSON.parse(result as string).error).toBe(I18n.translate("ai.error.noDocument"));
    });

    test("rejects a missing or empty ops array before loading the parametric module", async () => {
        const app = createMockApplication();
        (app as any).activeView = { document: createMockDocument() };
        rs.stubGlobal("app", app);

        try {
            await expect(runParametric().handler({})).rejects.toThrow(/non-empty "ops" array/);
            await expect(runParametric().handler({ ops: [] })).rejects.toThrow(/non-empty "ops" array/);
        } finally {
            rs.unstubAllGlobals();
        }
    });

    test("passes the call's signal to the program: a cancelled call runs no op", async () => {
        const add = rs.fn((_record: unknown) => {});
        const document = createMockDocument({ history: { add } as any });
        const app = createMockApplication();
        (app as any).activeView = { document };
        rs.stubGlobal("app", app);
        const controller = new AbortController();
        controller.abort();

        try {
            await expect(
                runParametric().handler({ ops: [{ op: "features", body: "b1" }] }, controller.signal),
            ).rejects.toThrow('cancelled before op 0 ("features"); the whole program was rolled back');
            expect(add).not.toHaveBeenCalled();
        } finally {
            rs.unstubAllGlobals();
        }
    });
});

describe("parametric response mode", () => {
    test("the MCP schema advertises full and compact modes", () => {
        expect((runParametric().parameters as any).properties.responseMode.enum).toEqual(["full", "compact"]);
    });

    test.each([
        undefined,
        "full",
        "compact",
    ])("passes responseMode %s to the program", async (responseMode) => {
        const document = createMockDocument();
        const app = createMockApplication();
        (app as any).activeView = { document };
        rs.stubGlobal("app", app);
        const envelope = { created: [], bodies: [], consumed: [], results: { explicit: [] } };
        const program = rs.spyOn(parametric, "runParametricProgram").mockReturnValue(envelope);
        try {
            const result = await runParametric().handler({
                ops: [{ op: "features", body: "b1" }],
                responseMode,
            });
            expect(JSON.parse(result as string)).toEqual(envelope);
            expect(program).toHaveBeenCalledWith(
                document,
                [{ op: "features", body: "b1" }],
                expect.objectContaining({ responseMode }),
            );
        } finally {
            program.mockRestore();
            rs.unstubAllGlobals();
        }
    });

    test("rejects invalid response modes before a transaction", async () => {
        const add = rs.fn((_record: unknown) => {});
        const document = createMockDocument({ history: { add } as any });
        const app = createMockApplication();
        (app as any).activeView = { document };
        rs.stubGlobal("app", app);
        try {
            await expect(
                runParametric().handler({ ops: [{ op: "features", body: "b1" }], responseMode: "quiet" }),
            ).rejects.toThrow(/responseMode/);
            expect(add).not.toHaveBeenCalled();
        } finally {
            rs.unstubAllGlobals();
        }
    });
});

test("parametric job tools append after existing tools and bypass only by built-in identity", () => {
    const tools = buildTools();
    // #124 appended read_export_chunk, then get_error_log, after the jobs to preserve the cached tools prefix.
    expect(tools.slice(-2).map((tool) => tool.name)).toEqual(["read_export_chunk", "get_error_log"]);
    const jobs = tools.slice(-5, -2);
    expect(jobs.map((tool) => tool.name)).toEqual([
        "start_parametric_job",
        "get_parametric_job",
        "cancel_parametric_job",
    ]);
    for (const tool of jobs) {
        expect(isProgramJobTool(tool)).toBe(true);
        expect(isProgramJobTool({ ...tool })).toBe(false);
    }
});
