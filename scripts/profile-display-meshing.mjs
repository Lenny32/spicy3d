// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// npm run build && node scripts/profile-display-meshing.mjs
// Creates temporary documents in an isolated browser to compare eager and lazy profile meshing.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../dist");
const types = {
    ".js": "application/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".css": "text/css",
    ".html": "text/html",
};
const server = createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const file = path.join(root, pathname === "/" ? "index.html" : pathname);
        const data = await readFile(file);
        response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
        response.end(data);
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("spicy-project-view").waitFor({ state: "attached" });
    const runs = await page.evaluate(async () => {
        const core = globalThis.Spicy3DCore;
        const app = core.getCurrentApplication();
        const document = await app.newDocument("issue51-p5e200", app.repositories.local);
        const entities = [];
        for (let i = 0; i < 50; i++) {
            const x = (i % 10) * 3;
            const y = Math.floor(i / 10) * 3;
            for (const params of [
                [x, y, x + 1, y],
                [x + 1, y, x + 1, y + 1],
                [x + 1, y + 1, x, y + 1],
                [x, y + 1, x, y],
            ]) {
                entities.push({ id: entities.length + 1, type: "line", params });
            }
        }
        let prototype;
        for (let i = 0; i < 5; i++) {
            const node = core.Serializer.deserializeInstance({
                __cla$$__: "SketchNode",
                document,
                plane: core.Plane.XY.translateTo(new core.XYZ({ x: 0, y: 0, z: i })),
                data: { entities, constraints: [] },
            });
            prototype = Object.getPrototypeOf(node);
            document.modelManager.addNode(node);
        }
        const id = document.id;
        const saved = await document.save();
        if (!saved.isOk) throw new Error("Benchmark document could not be saved");
        await document.close();
        const display = Object.getOwnPropertyDescriptor(prototype, "displayMesh");
        const deferred = Object.getOwnPropertyDescriptor(prototype, "hasDeferredMesh");
        const runs = [];
        try {
            for (let trial = 0; trial < 7; trial++) {
                for (const mode of ["eager", "lazy"]) {
                    Object.defineProperty(
                        prototype,
                        "displayMesh",
                        mode === "lazy"
                            ? display
                            : {
                                  configurable: true,
                                  get() {
                                      return this.mesh;
                                  },
                              },
                    );
                    Object.defineProperty(
                        prototype,
                        "hasDeferredMesh",
                        mode === "lazy"
                            ? deferred
                            : {
                                  configurable: true,
                                  get() {
                                      return false;
                                  },
                              },
                    );
                    core.PerformanceTrace.enable();
                    const start = performance.now();
                    const opened = await app.openDocument(id, app.repositories.local);
                    const durationMs = performance.now() - start;
                    const trace = core.PerformanceTrace.snapshot();
                    core.PerformanceTrace.disable();
                    if (!opened) throw new Error("Benchmark document could not be reopened");
                    runs.push({
                        trial,
                        mode,
                        durationMs,
                        meshes: trace.records.filter((record) => record.stage === "mesh.kernel").length,
                    });
                    const sketches = opened.modelManager
                        .findNodes()
                        .filter((node) => node.constructor.name === "SketchNode");
                    for (const sketch of sketches) {
                        const visual = opened.visual.context.getVisual(sketch);
                        if (
                            visual.subShapeVisual(core.ShapeTypes.face).length !== 1 ||
                            sketch.mesh.faces.range.length !== 50
                        )
                            throw new Error("Deferred profiles were not made pickable on demand");
                    }
                    await opened.close();
                }
            }
        } finally {
            Object.defineProperty(prototype, "displayMesh", display);
            Object.defineProperty(prototype, "hasDeferredMesh", deferred);
            core.PerformanceTrace.disable();
        }
        return runs;
    });
    const summary = Object.fromEntries(
        ["eager", "lazy"].map((mode) => {
            const measured = runs.filter((run) => run.trial >= 2 && run.mode === mode);
            const durations = measured.map((run) => run.durationMs).sort((a, b) => a - b);
            return [mode, { medianMs: durations[2], meshCounts: measured.map((run) => run.meshes) }];
        }),
    );
    if (
        summary.eager.meshCounts.some((count) => count !== 255) ||
        summary.lazy.meshCounts.some((count) => count !== 5)
    )
        throw new Error("Unexpected document-open mesh counts");
    const progressive = await page.evaluate(async () => {
        const core = globalThis.Spicy3DCore;
        const app = core.getCurrentApplication();
        const originalIdle = globalThis.requestIdleCallback;
        const originalCancel = globalThis.cancelIdleCallback;
        const callbacks = new Map();
        let token = 0;
        globalThis.requestIdleCallback = (callback) => {
            callbacks.set(++token, callback);
            return token;
        };
        globalThis.cancelIdleCallback = (handle) => callbacks.delete(handle);
        try {
            const document = await app.newDocument("issue51-progressive", app.repositories.local);
            const nodes = [];
            for (let i = 0; i < 100; i++) {
                const shape = app.shapeProvider.factory.sphere(new core.XYZ({ x: i * 3, y: 0, z: 0 }), 1);
                if (!shape.isOk) throw new Error("Benchmark sphere could not be built");
                nodes.push(new core.EditableShapeNode({ document, name: `sphere${i}`, shape: shape.value }));
            }
            document.modelManager.rootNode.add(...nodes);
            if (!(await document.save()).isOk) throw new Error("Progressive document could not be saved");
            const id = document.id;
            await document.close();
            const opened = await app.openDocument(id, app.repositories.local);
            const bodies = opened.modelManager
                .findNodes()
                .filter((node) => node instanceof core.EditableShapeNode);
            const canonicalCount = () => bodies.filter((node) => node.shape.value._mesh !== undefined).length;
            const initialCanonical = canonicalCount();
            opened.visual.context.getVisual(bodies[0]).subShapeVisual(core.ShapeTypes.face);
            const afterPicking = canonicalCount();
            const [handle, callback] = callbacks.entries().next().value;
            callbacks.delete(handle);
            callback({ timeRemaining: () => 50, didTimeout: false });
            const afterIdle = canonicalCount();
            await opened.close();
            const pendingAfterClose = callbacks.size;
            if (initialCanonical !== 0 || afterPicking !== 1 || afterIdle !== 2 || pendingAfterClose !== 0)
                throw new Error("Progressive display did not defer/refine/cancel correctly");
            return { initialCanonical, afterPicking, afterIdle, pendingAfterClose };
        } finally {
            globalThis.requestIdleCallback = originalIdle;
            globalThis.cancelIdleCallback = originalCancel;
        }
    });
    process.stdout.write(`${JSON.stringify({ summary, progressive, runs }, null, 2)}\n`);
} finally {
    await browser?.close();
    server.close();
}
