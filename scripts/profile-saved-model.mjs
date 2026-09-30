// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFileSync } from "node:child_process";
/** Read-only, version-isolated browser benchmark. See docs/saved-model-performance.md. */
import { createHash } from "node:crypto";
import {
    closeSync,
    createReadStream,
    existsSync,
    openSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { chromium, firefox } from "playwright";
import { profileDeploymentConfig, serveProfileDeployment } from "./profile-deployment.mjs";
import {
    captureProfileGeometry,
    compareProfileGeometry,
    profileGeometryIssues,
} from "./profile-geometry.mjs";
import { aggregateProfileRealms } from "./profile-realms.mjs";

const { values: args } = parseArgs({
    options: {
        source: { type: "string" },
        model: { type: "string" },
        output: { type: "string" },
        browser: { type: "string", default: "firefox" },
        cycles: { type: "string", default: "10" },
        sketch: { type: "string" },
        "all-sketches": { type: "boolean", default: false },
        "compare-before": { type: "string" },
        "assert-optimized": { type: "boolean", default: false },
        "kernel-mode": { type: "string", default: "main" },
        "allow-dirty": { type: "boolean", default: false },
        headed: { type: "boolean", default: false },
    },
});
if (!args.source || !args.model || !args.output) {
    throw new Error("Required: --source <built checkout> --model <read-only .spicy> --output <new .json>");
}
const source = path.resolve(args.source);
const model = path.resolve(args.model);
const output = path.resolve(args.output);
if (output === model || path.extname(output) !== ".json") {
    throw new Error("Output must be a NEW .json evidence file, never the model or existing evidence");
}
const cycles = Number(args.cycles);
if (!Number.isInteger(cycles) || cycles < 0) throw new Error("cycles must be a nonnegative integer");
if (!["auto", "main", "hybrid", "worker"].includes(args["kernel-mode"]))
    throw new Error("Invalid --kernel-mode");
const git = (...params) => execFileSync("git", params, { cwd: source, encoding: "utf8" }).trim();
const diff = git("diff", "HEAD", "--");
if (diff && !args["allow-dirty"])
    throw new Error("Baseline source is dirty; use a detached pristine worktree");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (folder, filter = () => true) => {
    const files = readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .filter(filter)
        .sort();
    return sha256(files.map((file) => `${file}:${sha256(readFileSync(path.join(folder, file)))}`).join("\n"));
};
const sourceFingerprint = () =>
    fingerprint(
        path.join(source, "packages"),
        (file) => file.includes("/src/") || /\/package.json$/.test(file),
    );
const bytes = readFileSync(model); // Read only: this path is NEVER opened for writing or served as a file handle.
const deploymentOverride = profileDeploymentConfig(args["kernel-mode"]);
const evidence = {
    revision: git("rev-parse", "HEAD"),
    sourceDirty: !!diff,
    sourceDiffSha256: sha256(diff),
    sourceFilesSha256: sourceFingerprint(),
    distSha256: fingerprint(path.join(source, "dist")),
    harnessSha256: sha256(readFileSync(new URL(import.meta.url))),
    modelSha256Before: sha256(bytes),
    modelBytes: bytes.length,
    environment: {
        platform: os.platform(),
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        memoryBytes: os.totalmem(),
        node: process.version,
    },
    browser: args.browser,
    expectedKernelMode: args["kernel-mode"],
    deploymentOverride,
    deploymentConfigRequests: 0,
    realmTelemetryVersion: 1,
    scenarios: [],
    errors: [],
};
const dist = path.join(source, "dist");
const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".svg": "image/svg+xml",
};
// Exclusive creation is the existence check. Keep the descriptor so a replaced path is never written.
const outputFile = openSync(output, "wx");
const server = createServer((req, res) => {
    if (req.method !== "GET") return res.writeHead(405).end();
    if (serveProfileDeployment(req, res, deploymentOverride)) {
        evidence.deploymentConfigRequests++;
        return;
    }
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/benchmark-input") return res.writeHead(200).end(bytes);
    const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        return res.writeHead(404).end();
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
});
let browser;
try {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    browser = await { firefox, chromium }[args.browser].launch({ headless: !args.headed });
    evidence.browserVersion = browser.version();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin && route.request().method() === "GET"
            ? route.continue()
            : route.abort(),
    );
    await context.addInitScript(() => {
        globalThis.__profileWasmMemories = [];
        for (const method of ["instantiate", "instantiateStreaming"]) {
            const original = WebAssembly[method];
            WebAssembly[method] = async function (...params) {
                const result = await original.apply(this, params);
                for (const value of Object.values((result.instance ?? result).exports)) {
                    if (value instanceof WebAssembly.Memory) globalThis.__profileWasmMemories.push(value);
                }
                return result;
            };
        }
        // No file handles and no browser document writes, even if an unexpected save path runs.
        globalThis.__profileWriteAttempts = [];
        const refuse = (kind) => {
            globalThis.__profileWriteAttempts.push(kind);
            throw new Error(`Benchmark blocked ${kind}`);
        };
        globalThis.showSaveFilePicker = () => refuse("file picker");
        if (globalThis.FileSystemFileHandle)
            FileSystemFileHandle.prototype.createWritable = () => refuse("file write");
        HTMLAnchorElement.prototype.click = () => refuse("download");
        for (const method of ["add", "put", "delete", "clear"]) {
            IDBObjectStore.prototype[method] = () => refuse(`IndexedDB ${method}`);
        }
        Storage.prototype.setItem = () => {};
    });
    const page = await context.newPage();
    let workerRealmsObserved = 0;
    page.on("worker", () => {
        workerRealmsObserved++;
    });
    page.on("pageerror", (error) => evidence.errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(
        () => {
            try {
                return !!globalThis.Spicy3DCore?.getCurrentApplication();
            } catch {
                return false;
            }
        },
        undefined,
        { timeout: 120_000 },
    );
    evidence.startupConfig = await page.evaluate(() => ({
        geometryWorker: globalThis.Spicy3DCore.DeploymentConfig.section("performance")?.geometryWorker,
        kernelMode: globalThis.Spicy3DWorkerProfile?.snapshot?.().mode ?? null,
    }));
    if (
        evidence.deploymentConfigRequests === 0 ||
        evidence.startupConfig.geometryWorker !== deploymentOverride.performance.geometryWorker
    )
        throw new Error("Benchmark deployment override was not consumed before startup");
    if (args["kernel-mode"] === "hybrid" && evidence.startupConfig.kernelMode !== "hybrid")
        throw new Error("Hybrid deployment opt-in did not enable the provider");
    if (
        args["kernel-mode"] === "main" &&
        evidence.startupConfig.kernelMode !== null &&
        evidence.startupConfig.kernelMode !== "main"
    )
        throw new Error("Main benchmark unexpectedly enabled the geometry worker");
    await page.evaluate(() => {
        const core = globalThis.Spicy3DCore;
        const app = core.getCurrentApplication();
        core.AutosaveHolds.hold("read-only benchmark");
        const failSave = async () => {
            globalThis.__profileWriteAttempts.push("repository save");
            return core.Result.err({ kind: "readOnly" });
        };
        app.repositories.local.save = failSave;
        const state = {
            records: [],
            feature: undefined,
            visual: undefined,
            document: undefined,
            repository: {
                id: "benchmark-memory",
                kind: "local",
                isReadOnly: false,
                save: failSave,
                list: async () => core.Result.ok([]),
                load: failSave,
                delete: failSave,
            },
        };
        globalThis.__savedModelProfile = state;
        const wrap = (object, key, stage, metadata = () => ({})) => {
            const original = object[key];
            if (typeof original !== "function") return;
            object[key] = function (...params) {
                const details = metadata.call(this, params);
                const started = performance.now();
                try {
                    return original.apply(this, params);
                } finally {
                    state.records.push({ stage, started, durationMs: performance.now() - started, details });
                }
            };
        };
        // Same runtime wrappers on BEFORE and AFTER: the pristine build needs no source patches.
        // Calls include OCCT's internal history completion; JS history conversion is outside them.
        for (const key of Object.keys(wasm.ShapeFactory)) {
            if (typeof wasm.ShapeFactory[key] !== "function") continue;
            wrap(
                wasm.ShapeFactory,
                key,
                key === "facesFromEdges" ? "profile.kernelRegions" : "kernel.operation",
                () => ({
                    operation: key,
                    boolean: /boolean(Fuse|Cut|Common)/.test(key),
                    featureIndex: state.feature?.index,
                    featureType: state.feature?.type,
                }),
            );
        }
        wrap(wasm.Mesher.prototype, "mesh", "mesh.kernel", () => ({
            meshKind: state.visual?.kind ?? "computational-or-unclassified",
            nodeId: state.visual?.id,
            visible: state.visual?.visible,
        }));
        wasm.Mesher = new Proxy(wasm.Mesher, {
            construct(target, params) {
                const started = performance.now();
                try {
                    return Reflect.construct(target, params);
                } finally {
                    state.records.push({
                        stage: "mesh.construct",
                        started,
                        durationMs: performance.now() - started,
                    });
                }
            },
        });
        wrap(core.DocumentMigrations, "migrate", "document.migrate");
        const create = app.visualFactory.create;
        app.visualFactory.create = function (...params) {
            const visual = create.apply(this, params);
            const original = visual.context.displayNode;
            if (original)
                visual.context.displayNode = function (node, ...rest) {
                    const previous = state.visual;
                    state.visual = {
                        id: node.id,
                        kind: node.constructor.name === "ParametricBodyNode" ? "body" : "construction",
                        visible: node.visible && node.parentVisible,
                    };
                    const started = performance.now();
                    try {
                        return original.call(this, node, ...rest);
                    } finally {
                        state.records.push({
                            stage: "visual.create",
                            started,
                            durationMs: performance.now() - started,
                            details: state.visual,
                        });
                        state.visual = previous;
                    }
                };
            return visual;
        };
        const deserialize = core.Serializer.deserializeObject;
        core.Serializer.deserializeObject = function (document, data) {
            const started = performance.now();
            const node = deserialize.call(this, document, data);
            if (data?.id && node instanceof core.Node) {
                state.records.push({
                    stage: "node.deserialize",
                    started,
                    durationMs: performance.now() - started,
                    details: { nodeId: node.id, nodeType: node.constructor.name },
                });
                if (node.evaluateFeatureStep) {
                    const step = node.evaluateFeatureStep;
                    const miss = node.evaluateAndCache;
                    node.evaluateAndCache = function (...params) {
                        if (state.feature) state.feature.cacheHit = false;
                        return miss.apply(this, params);
                    };
                    node.evaluateFeatureStep = function (feature, ...params) {
                        const previous = state.feature;
                        const details = {
                            index: this.features.findIndex((f) => f.id === feature.id),
                            type: feature.type,
                            cacheHit: true,
                        };
                        state.feature = details;
                        const started = performance.now();
                        try {
                            return step.call(this, feature, ...params);
                        } finally {
                            state.records.push({
                                stage: "feature.step",
                                started,
                                durationMs: performance.now() - started,
                                details,
                            });
                            state.feature = previous;
                        }
                    };
                    wrap(node, "evaluateChain", "feature.chain");
                } else if (node.evaluateAndCache) {
                    // Generator evaluateChain is measured by source body.rebuild/body.batch hooks.
                    // Timing generator construction would falsely report a near-zero chain duration.
                    const miss = node.evaluateAndCache;
                    node.evaluateAndCache = function (feature, ...params) {
                        const previous = state.feature;
                        state.feature = {
                            index: this.features.findIndex((f) => f.id === feature.id),
                            type: feature.type,
                        };
                        try {
                            return miss.call(this, feature, ...params);
                        } finally {
                            state.feature = previous;
                        }
                    };
                }
            }
            return node;
        };
        state.memory = () => ({
            realm: "main", // Worker heaps are unavailable here; use the optional bridge snapshot separately.
            wasmHeapBytes: globalThis.__profileWasmMemories.length
                ? Math.max(...globalThis.__profileWasmMemories.map((memory) => memory.buffer.byteLength))
                : null,
            wasmMemoriesBytes: globalThis.__profileWasmMemories.map((memory) => memory.buffer.byteLength),
            jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
        });
        state.settle = async () => {
            if (state.document) await state.document.settled();
            // Optimized builds may expose pending evaluation jobs. Never force a second rebuild.
            for (const node of state.document?.modelManager.findNodes() ?? []) {
                if (typeof node.whenRebuilt === "function") await node.whenRebuilt();
            }
            await globalThis.Spicy3DWorkerProfile?.settled?.();
            await new Promise((resolve) => setTimeout(resolve, 50));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        state.measure = async (action) => {
            // A cancelled caller may settle before native execution stops. Drain the transport too.
            await globalThis.Spicy3DWorkerProfile?.settled?.();
            state.records = [];
            core.PerformanceTrace?.enable();
            const workerBefore = globalThis.Spicy3DWorkerProfile?.snapshot?.() ?? null;
            let workerAfter = null;
            const memoryBefore = state.memory();
            let last = performance.now();
            let maxEventLoopGapMs = 0;
            const timer = setInterval(() => {
                const now = performance.now();
                maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - last);
                last = now;
            }, 10);
            await new Promise((resolve) => setTimeout(resolve, 20));
            const start = performance.now();
            try {
                await action();
                await state.settle();
                await globalThis.Spicy3DWorkerProfile?.settled?.();
                workerAfter = globalThis.Spicy3DWorkerProfile?.snapshot?.() ?? null;
            } finally {
                clearInterval(timer);
                core.PerformanceTrace?.disable();
            }
            return {
                elapsedMs: performance.now() - start,
                maxEventLoopGapMs,
                memoryBefore,
                memoryAfter: state.memory(),
                records: state.records,
                sourceTrace: core.PerformanceTrace?.snapshot() ?? null,
                workerCapture: { before: workerBefore, after: workerAfter },
            };
        };
        state.snapshot = () => {
            const nodes = state.document.modelManager.findNodes();
            const body = nodes.find((n) => n.constructor.name === "ParametricBodyNode");
            if (!body?.shape.isOk) throw new Error(`No valid body: ${body?.shape.error}`);
            const shape = body.shape.value;
            const count = (type) => {
                const items = shape.findSubShapes(type);
                const result = items.length;
                items.forEach((item) => {
                    item.dispose();
                });
                return result;
            };
            const brep = app.shapeProvider.converter.convertToBrep(shape);
            if (!brep.isOk) throw new Error(brep.error);
            const faces = count(core.ShapeTypes.face);
            const edges = count(core.ShapeTypes.edge);
            const faceIds = Array.from({ length: faces }, (_, index) => body.faceIdAt(index));
            const edgeIds = Array.from({ length: edges }, (_, index) => body.edgeIdAt(index));
            if (![...faceIds, ...edgeIds].every((id) => typeof id === "string"))
                throw new Error("Missing tracked IDs");
            state.trackedSizes = { faces, edges };
            const picking = {};
            for (const [kind, type] of [
                ["faces", core.ShapeTypes.face],
                ["edges", core.ShapeTypes.edge],
            ]) {
                const analytic = shape.findSubShapes(type);
                try {
                    const ranges = shape.mesh[kind]?.range;
                    if (!ranges?.length) throw new Error(`Missing ${kind} pick ranges`);
                    let nonidentity = 0;
                    for (let meshIndex = 0; meshIndex < ranges.length; meshIndex++) {
                        const range = ranges[meshIndex];
                        const topologyIndex = core.pickedTopologyIndex(range);
                        if (!analytic[topologyIndex] || !range.shape.isSame(analytic[topologyIndex]))
                            throw new Error(`${kind} topology pick mismatch`);
                        if (!core.meshIndexesForTopology(ranges, topologyIndex).includes(meshIndex))
                            throw new Error(`${kind} inverse pick mapping mismatch`);
                        if (topologyIndex !== meshIndex) nonidentity++;
                    }
                    picking[kind] = {
                        checkedRanges: ranges.length,
                        analyticCount: analytic.length,
                        nonidentity,
                        valid: true,
                    };
                } finally {
                    analytic.forEach((item) => {
                        item.dispose();
                    });
                }
            }
            return {
                brep: brep.value,
                faces,
                edges,
                trackedIds: [faceIds, edgeIds],
                picking,
                vertices: count(core.ShapeTypes.vertex),
                bounds: wasm.Shape.boundingBox(shape.shape, false),
                featuresJson: body.featuresJson,
                sketches: nodes
                    .filter((n) => n.constructor.name === "SketchNode")
                    .map((n) => ({ id: n.id, dataJson: n.dataJson })),
                visibility: nodes.map((n) => ({
                    id: n.id,
                    visible: n.visible,
                    parentVisible: n.parentVisible,
                })),
                featureErrors: [...body._featureErrors],
                volume: shape.volume(),
                hiddenGeometry: nodes
                    .filter(
                        (node) => node instanceof core.GeometryNode && !(node.visible && node.parentVisible),
                    )
                    .map((node) => {
                        const visual = state.document.visual.context._NodeVisualMap.get(node);
                        const resolved = node.resolvedShape;
                        return {
                            nodeId: node.id,
                            nodeType: node.constructor.name,
                            visualFound: !!visual,
                            visualMeshesBuilt: !!(visual?._faces || visual?._edges || visual?._vertexs),
                            resolvedShapeAvailable: !!resolved,
                            kernelMeshed: resolved?._mesh?._isMeshed === true,
                        };
                    }),
            };
        };
        state.references = () => {
            const nodes = state.document.modelManager.findNodes();
            return {
                features: nodes
                    .filter((n) => n.featuresJson !== undefined)
                    .map((n) => [n.id, n.featuresJson]),
                sketches: nodes
                    .filter((n) => n.constructor.name === "SketchNode")
                    .map((n) => [n.id, n.dataJson]),
                visibility: nodes.map((n) => [n.id, n.visible, n.parentVisible]),
                trackedIds: nodes
                    .filter((node) => node.constructor.name === "ParametricBodyNode")
                    .map((body) => [
                        Array.from({ length: state.trackedSizes.faces }, (_, index) => body.faceIdAt(index)),
                        Array.from({ length: state.trackedSizes.edges }, (_, index) => body.edgeIdAt(index)),
                    ]),
            };
        };
        state.cycle = async (name) => {
            const sketch = state.document.modelManager.findNode((n) => n.name === name);
            if (!sketch) throw new Error(`Missing benchmark sketch ${name}`);
            const before = state.references();
            // Registered UI command awaits SketchEditor.enterAsync; do not fire-and-forget PubSub.
            state.document.selection.setSelectedNodes([sketch], false);
            const Enter = core.CommandStore.getCommand("sketch.enter");
            const Exit = core.CommandStore.getCommand("sketch.exit");
            const run = await state.measure(async () => {
                await new Enter().execute(app);
                await state.document.settled();
                if (!core.EditSessions.isActive(state.document) || !sketch.editingSession)
                    throw new Error("Async sketch entry did not claim the requested sketch");
                await state.settle();
                await new Exit().execute(app);
                await state.document.settled();
                if (core.EditSessions.isActive(state.document) || sketch.editingSession)
                    throw new Error("Async sketch exit did not finish");
            });
            const after = state.references();
            run.stability = Object.fromEntries(
                Object.keys(before).map((key) => [
                    key,
                    JSON.stringify(before[key]) === JSON.stringify(after[key]),
                ]),
            );
            run.changedSketchIds = before.sketches
                .filter(([id, json]) => after.sketches.find(([nextId]) => nextId === id)?.[1] !== json)
                .map(([id]) => id);
            return run;
        };
    });
    const cold = await page.evaluate(async () => {
        const state = globalThis.__savedModelProfile;
        const core = globalThis.Spicy3DCore;
        const blob = await (await fetch("/benchmark-input")).blob();
        return state.measure(async () => {
            const started = performance.now();
            const decoded = await core.decodeDocumentFile(blob);
            state.records.push({
                stage: "document.decode",
                started,
                durationMs: performance.now() - started,
            });
            if (!decoded.isOk) throw new Error(decoded.error.message);
            state.input = decoded.value;
            state.document = await core
                .getCurrentApplication()
                .loadDocument(decoded.value, { repository: state.repository });
            if (!state.document) throw new Error("Document failed to load");
        });
    });
    const summarize = (name, run) => {
        const realms = aggregateProfileRealms(run, {
            expectedMode: args["kernel-mode"],
            workersObserved: workerRealmsObserved,
        });
        const summary = {
            name,
            elapsedMs: run.elapsedMs,
            maxEventLoopGapMs: run.maxEventLoopGapMs,
            booleanCount: realms.booleanCount,
            booleanMs: realms.booleanMs,
            longestBooleanMs: realms.longestBooleanMs,
            mainBooleanCount: realms.main.booleanCount,
            workerBooleanCount: realms.worker.booleanCount,
            longestMainBooleanMs: realms.main.longestBooleanMs,
            longestWorkerBooleanMs: realms.worker.longestBooleanMs,
            kernelMode: realms.mode,
            telemetryComplete: realms.complete,
            telemetryIssues: realms.issues,
            meshCount: realms.meshCount,
            memoryAfter: run.memoryAfter,
            stability: run.stability,
            sourceBooleanCount:
                realms.complete && realms.main.sourceBooleanCount !== null
                    ? realms.main.sourceBooleanCount + realms.worker.booleanCount
                    : null,
            sourceFeatureHits: run.sourceTrace?.records.filter(
                (r) => r.stage === "body.feature" && r.details?.cacheHit,
            ).length,
            sourceFeatureMisses: run.sourceTrace?.records.filter(
                (r) => r.stage === "body.feature" && !r.details?.cacheHit,
            ).length,
        };
        evidence.scenarios.push({ ...summary, ...run, realmTelemetry: realms });
        console.log(JSON.stringify(summary));
    };
    summarize("cold-open", cold);
    evidence.before = await page.evaluate(() => globalThis.__savedModelProfile.snapshot());
    evidence.before.brepSha256 = sha256(evidence.before.brep);
    evidence.before.trackedIdsHash = sha256(JSON.stringify(evidence.before.trackedIds));
    const sketchNames = args.sketch
        ? [args.sketch]
        : await page.evaluate(() => {
              const nodes = globalThis.__savedModelProfile.document.modelManager.findNodes();
              const body = nodes.find((n) => n.constructor.name === "ParametricBodyNode");
              const sketchId = body.features.findLast((f) => f.sketchId)?.sketchId;
              const final = nodes.find((n) => n.id === sketchId);
              if (!final) throw new Error("No sketch found for the last sketch-based feature");
              return ["Sk_Plate", "Sk_RibBox1", final.name];
          });
    for (const name of [...sketchNames, ...Array(cycles).fill(sketchNames[0])]) {
        const run = await page.evaluate((name) => globalThis.__savedModelProfile.cycle(name), name);
        summarize(`unchanged:${name}`, run);
    }
    if (args["all-sketches"]) {
        const names = await page.evaluate(() =>
            globalThis.__savedModelProfile.document.modelManager
                .findNodes()
                .filter((n) => n.constructor.name === "SketchNode")
                .map((n) => n.name),
        );
        evidence.allSketchCount = names.length;
        for (const name of names) {
            const run = await page.evaluate((name) => globalThis.__savedModelProfile.cycle(name), name);
            summarize(`all-sketches:${name}`, run);
        }
    }
    evidence.after = await page.evaluate(() => globalThis.__savedModelProfile.snapshot());
    evidence.after.brepSha256 = sha256(evidence.after.brep);
    evidence.after.trackedIdsHash = sha256(JSON.stringify(evidence.after.trackedIds));
    if (args["compare-before"]) {
        const baselineBytes = readFileSync(args["compare-before"]);
        const baseline = JSON.parse(
            args["compare-before"].endsWith(".gz") ? gunzipSync(baselineBytes) : baselineBytes,
        );
        evidence.geometryComparison = {
            baselineArtifactSha256: sha256(baselineBytes),
            baselineRevision: baseline.revision,
            validationMode: args["kernel-mode"] === "hybrid" ? "hybrid-ordered-graph-v1" : "strict-brep",
        };
        // Parse detached exports and clean ONLY those independent shapes. Never clean the live document.
        for (const [label, snapshot] of Object.entries({
            baselineCold: baseline.before,
            afterCold: evidence.before,
            afterCycles: evidence.after,
        })) {
            const cleanBrep = await page.evaluate((brep) => {
                const detached = wasm.Converter.convertFromBrep(brep);
                try {
                    wasm.Shape.clean(detached);
                    return wasm.Converter.convertToBrep(detached);
                } finally {
                    detached.delete();
                }
            }, snapshot.brep);
            evidence.geometryComparison[label] = {
                cleanBrep,
                sha256: sha256(cleanBrep),
                faces: snapshot.faces,
                edges: snapshot.edges,
                vertices: snapshot.vertices,
                bounds: snapshot.bounds,
                volume: snapshot.volume,
                ...(args["kernel-mode"] === "hybrid" && {
                    geometryProbe: await page.evaluate(captureProfileGeometry, snapshot.brep),
                }),
            };
        }
        const comparison = evidence.geometryComparison;
        comparison.coldCleanBrepIdentical = comparison.baselineCold.sha256 === comparison.afterCold.sha256;
        comparison.cyclesCleanBrepIdentical = comparison.afterCold.sha256 === comparison.afterCycles.sha256;
        if (args["kernel-mode"] === "hybrid") {
            comparison.independentCold = compareProfileGeometry(
                comparison.baselineCold.geometryProbe,
                comparison.afterCold.geometryProbe,
            );
            comparison.independentCycles = compareProfileGeometry(
                comparison.baselineCold.geometryProbe,
                comparison.afterCycles.geometryProbe,
            );
        }
        console.log(
            JSON.stringify({
                geometryComparison: {
                    coldCleanBrepIdentical: comparison.coldCleanBrepIdentical,
                    cyclesCleanBrepIdentical: comparison.cyclesCleanBrepIdentical,
                },
            }),
        );
    }
    if (args["kernel-mode"] === "hybrid") {
        const cancelled = await page.evaluate(async () => {
            const state = globalThis.__savedModelProfile;
            const core = globalThis.Spicy3DCore;
            const factory = core.getCurrentApplication().shapeProvider.factory;
            const bridge = globalThis.Spicy3DWorkerProfile;
            const shapes = [];
            let callerSettled;
            try {
                for (let i = 0; i < 26; i++) {
                    const plane = new core.Plane({
                        origin: new core.XYZ({
                            x: i ? ((i - 1) % 5) * 1.8 : 0,
                            y: i ? Math.floor((i - 1) / 5) * 1.8 : 0,
                            z: 0,
                        }),
                        normal: core.XYZ.unitZ,
                        xvec: core.XYZ.unitX,
                    });
                    const box = factory.box(plane, 10, 10, 10);
                    if (!box.isOk) throw new Error("Synthetic cancellation box failed");
                    shapes.push(box.value);
                }
                const run = await state.measure(async () => {
                    const operation = factory.asyncOperations.booleanTracked(
                        "fuse",
                        [shapes[0]],
                        shapes.slice(1),
                    );
                    if (!operation) throw new Error("Synthetic cancellation did not use async worker");
                    let didCancel = false;
                    const timer = setTimeout(() => {
                        didCancel = true;
                        operation.cancel();
                    }, 20);
                    try {
                        await operation.ready;
                        callerSettled = bridge.snapshot();
                        if (!didCancel || callerSettled.pendingNative < 1)
                            throw new Error("Cancellation did not precede native terminal delivery");
                        if (operation.take().isOk)
                            throw new Error("Cancelled synthetic operation remained consumable");
                    } finally {
                        clearTimeout(timer);
                    }
                    await bridge.settled();
                });
                return { ...run, callerSettled };
            } finally {
                shapes.forEach((shape) => {
                    shape.dispose();
                });
            }
        });
        evidence.cancellationProbe = {
            ...cancelled,
            realmTelemetry: aggregateProfileRealms(cancelled, {
                expectedMode: "hybrid",
                workersObserved: workerRealmsObserved,
            }),
        };
        const result = evidence.cancellationProbe.realmTelemetry;
        if (!result.complete || result.main.booleanCount !== 0 || result.worker.booleanCount !== 1)
            throw new Error(`Cancelled native work was not fully accounted for: ${JSON.stringify(result)}`);
        console.log(
            JSON.stringify({
                cancellationProbe: {
                    complete: result.complete,
                    nativeBooleans: result.worker.booleanCount,
                    pendingAfter: result.worker.pendingAfter,
                },
            }),
        );
    }
    evidence.writeAttempts = await page.evaluate(() => globalThis.__profileWriteAttempts);
    evidence.capabilities = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        longTasks: PerformanceObserver.supportedEntryTypes.includes("longtask"),
        jsMemory: !!performance.memory,
        wasmHeap: globalThis.__profileWasmMemories.length > 0,
    }));
    if (args["assert-optimized"]) {
        evidence.regressions = [];
        for (const scenario of evidence.scenarios) {
            if (!scenario.telemetryComplete)
                evidence.regressions.push(
                    `${scenario.name}: incomplete realm telemetry: ${scenario.telemetryIssues.join("; ")}`,
                );
        }
        if (evidence.scenarios[0]?.booleanCount !== 83)
            evidence.regressions.push("cold-load total native boolean count is not 83");
        if (
            ["hybrid", "worker"].includes(evidence.scenarios[0]?.kernelMode) &&
            !(evidence.scenarios[0]?.workerBooleanCount > 0)
        )
            evidence.regressions.push("requested worker path performed no verified native worker booleans");
        for (const scenario of evidence.scenarios.filter((run) => run.name !== "cold-open")) {
            if (scenario.booleanCount !== 0)
                evidence.regressions.push(`${scenario.name}: ${scenario.booleanCount} booleans`);
            if (Object.values(scenario.stability).some((stable) => !stable))
                evidence.regressions.push(`${scenario.name}: state changed`);
            if (scenario.sourceTrace?.dropped)
                evidence.regressions.push(`${scenario.name}: dropped source records`);
        }
        evidence.regressions.push(...profileGeometryIssues(evidence.geometryComparison, args["kernel-mode"]));
        if (evidence.regressions.length || evidence.writeAttempts.length || evidence.errors.length)
            process.exitCode = 1;
    }
} catch (error) {
    evidence.failure = error.stack;
    process.exitCode = 1;
} finally {
    try {
        await browser?.close();
        server.close();
        evidence.modelSha256After = sha256(readFileSync(model));
        evidence.sourceDiffSha256After = sha256(git("diff", "HEAD", "--"));
        evidence.sourceFilesSha256After = sourceFingerprint();
        if (evidence.modelSha256Before !== evidence.modelSha256After) {
            evidence.errors.push("BENCHMARK INPUT HASH CHANGED");
            process.exitCode = 1;
        }
        writeFileSync(outputFile, JSON.stringify(evidence, null, 2));
        console.log(`Evidence: ${output}`);
        if (evidence.failure) console.error(evidence.failure);
    } finally {
        closeSync(outputFile);
    }
}
