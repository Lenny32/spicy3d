// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    CommandStore,
    decodeDocumentFile,
    EditSessions,
    getCurrentApplication,
    type IDocumentRepository,
    PerformanceTrace,
    Result,
    ShapeTypes,
    sha256HexSync,
} from "@spicy3d/core";
import { ParametricBodyNode, SketchNode } from "@spicy3d/parametric";
import { replicaTopology, sameReplicaTopology } from "../../src/replicaTopology";
import type { OccShape } from "../../src/shape";

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
type Baseline = { brep: string; featuresJson: string; sketches: unknown; visibility: unknown };

async function run({
    baseline,
    mode,
    allSketches,
}: {
    baseline: Baseline;
    mode: "main" | "hybrid";
    allSketches: boolean;
}) {
    const app = getCurrentApplication();
    const release = AutosaveHolds.hold("read-only worker application smoke");
    const bridge = (
        globalThis as unknown as {
            Spicy3DWorkerProfile: {
                settled(): Promise<void>;
                snapshot(): { booleanCount: number; pendingNative: number; telemetryComplete: boolean };
            };
        }
    ).Spicy3DWorkerProfile;
    const repository: IDocumentRepository = {
        kind: "local",
        // Editing sessions are exercised, but persistence is blocked by this repository and the runner.
        isReadOnly: () => false,
        list: async () => Result.ok({ items: [] }),
        load: async () => Result.err({ kind: "notFound", id: "smoke" }),
        save: async () => {
            throw new Error("Read-only smoke attempted to save");
        },
        delete: async () => {
            throw new Error("Read-only smoke attempted to delete");
        },
    };
    const button = document.createElement("button");
    button.id = "worker-input-probe";
    button.textContent = "Input during rebuild";
    button.style.cssText = "position:fixed;right:20px;top:20px;z-index:2147483647;padding:20px";
    document.body.append(button);
    let inputDuringFirstOperation = false;
    button.addEventListener("click", () => {
        const status = bridge.snapshot();
        inputDuringFirstOperation = status.pendingNative > 0 && status.booleanCount === 0;
        button.textContent = "Input handled";
    });
    let frames = 0;
    let ticking = true;
    const frame = () => {
        if (ticking) {
            frames++;
            requestAnimationFrame(frame);
        }
    };
    requestAnimationFrame(frame);
    let lastTick = performance.now();
    let maxEventLoopGapMs = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick);
        lastTick = now;
    }, 10);
    const capacity = () =>
        Math.max(
            0,
            ...(globalThis as unknown as { workerTestMemories: WebAssembly.Memory[] }).workerTestMemories.map(
                (memory) => memory.buffer.byteLength,
            ),
        );
    PerformanceTrace.enable();
    const started = performance.now();
    try {
        const decoded = await decodeDocumentFile(await (await fetch("/worker-test-model")).blob());
        check(decoded.isOk, "Model decoding failed");
        const doc = await app.loadDocument(decoded.value, { repository });
        check(doc, "Document did not load");
        await doc.settled();
        await bridge.settled();
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const elapsedMs = performance.now() - started;
        clearInterval(timer);
        ticking = false;
        const mainWasmCapacityCold = capacity();
        const records = PerformanceTrace.snapshot().records;
        const worker = records.filter(
            (record) => record.stage === "worker.kernel.operation" && record.details?.["boolean"],
        );
        const main = records.filter(
            (record) => record.stage === "kernel.operation" && record.details?.["boolean"],
        );
        check(
            worker.length === (mode === "hybrid" ? 83 : 0) && main.length === (mode === "main" ? 83 : 0),
            `Unexpected ${mode} booleans: worker=${worker.length}, main=${main.length}`,
        );
        check(bridge.snapshot().telemetryComplete, "Incomplete worker telemetry");
        check(
            mode === "main" || (inputDuringFirstOperation && frames > 0),
            "Main thread did not process input/animation during offload",
        );
        const nodes = doc.modelManager.findNodes();
        const body = nodes.find((node) => node instanceof ParametricBodyNode);
        check(body instanceof ParametricBodyNode && body.shape.isOk, "Body did not rebuild");
        check(body.features.length === 84, "Feature order/count changed");
        check(body.featuresJson === baseline.featuresJson, "Feature payload differs from pristine baseline");
        check(
            JSON.stringify(
                nodes
                    .filter((node) => node instanceof SketchNode)
                    .map((node) => ({ id: node.id, dataJson: node.dataJson })),
            ) === JSON.stringify(baseline.sketches),
            "Sketch payload differs from pristine baseline",
        );
        check(
            JSON.stringify(
                nodes.map((node) => ({
                    id: node.id,
                    visible: node.visible,
                    parentVisible: node.parentVisible,
                })),
            ) === JSON.stringify(baseline.visibility),
            "Visibility differs from pristine baseline",
        );
        const shape = body.shape.value as OccShape;
        const original = wasm.Converter.convertFromBrep(baseline.brep);
        let topologyMatches: boolean;
        try {
            topologyMatches = sameReplicaTopology(
                replicaTopology(wasm, shape.shape),
                replicaTopology(wasm, original),
            );
        } finally {
            original.delete();
        }
        check(topologyMatches, "Full ordered topology graph differs from pristine baseline");
        const volume = shape.volume();
        check(Math.abs(volume - 22330.460970036078) < 1e-6, "Body volume changed");
        const faces = shape.findSubShapes(ShapeTypes.face);
        const edges = shape.findSubShapes(ShapeTypes.edge);
        try {
            check(faces.length === 1232 && edges.length === 3448, "Topology counts changed");
            const mesh = shape.mesh;
            check(mesh.faces && mesh.edges, "Worker mesh is missing");
            for (const range of mesh.faces.range)
                check(range.shape.isSame(faces[range.shape.index]), "Wrong face pick range");
            for (const range of mesh.edges.range)
                check(range.shape.isSame(edges[range.shape.index]), "Wrong edge pick range");
        } finally {
            faces.forEach((face) => face.dispose());
            edges.forEach((edge) => edge.dispose());
        }
        const faceIds = Array.from({ length: 1232 }, (_, index) => body.faceIdAt(index));
        const edgeIds = Array.from({ length: 3448 }, (_, index) => body.edgeIdAt(index));
        check(
            faceIds.every((id) => typeof id === "string") && edgeIds.every((id) => typeof id === "string"),
            "Missing tracked subshape ids",
        );
        const trackedIdsHash = sha256HexSync(new TextEncoder().encode(JSON.stringify([faceIds, edgeIds])));
        const payload = () =>
            JSON.stringify({
                features: body.featuresJson,
                sketches: nodes
                    .filter((node) => node instanceof SketchNode)
                    .map((node) => [node.id, node.dataJson]),
                visibility: nodes.map((node) => [node.id, node.visible, node.parentVisible]),
            });
        const beforeSessions = payload();
        const sessions: Array<{ name: string; elapsedMs: number; mainWasmCapacityBytes: number }> = [];
        const Enter = CommandStore.getCommand("sketch.enter");
        const Exit = CommandStore.getCommand("sketch.exit");
        check(Enter && Exit, "Sketch commands are not registered");
        for (const sketch of allSketches ? nodes.filter((node) => node instanceof SketchNode) : []) {
            const sessionStarted = performance.now();
            doc.selection.setSelectedNodes([sketch], false);
            await new Enter().execute(app);
            await doc.settled();
            check(EditSessions.isActive(doc) && sketch.editingSession, "Sketch entry failed");
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await new Exit().execute(app);
            await doc.settled();
            await bridge.settled();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            check(!EditSessions.isActive(doc) && !sketch.editingSession, "Sketch exit failed");
            check(
                body.shape.value === shape && payload() === beforeSessions,
                "Rollback changed model/cache payload",
            );
            check(
                faceIds.every((id, index) => id === body.faceIdAt(index)) &&
                    edgeIds.every((id, index) => id === body.edgeIdAt(index)),
                "Rollback changed tracked ids",
            );
            sessions.push({
                name: sketch.name,
                elapsedMs: performance.now() - sessionStarted,
                mainWasmCapacityBytes: capacity(),
            });
        }
        const afterRecords = PerformanceTrace.snapshot().records.slice(records.length);
        check(
            !afterRecords.some(
                (record) =>
                    ["kernel.operation", "worker.kernel.operation"].includes(record.stage) &&
                    record.details?.["boolean"],
            ),
            "Unchanged sketches performed booleans",
        );
        check(
            !afterRecords.some(
                (record) => record.stage === "body.feature" && record.details?.["cacheHit"] === false,
            ),
            "Unchanged sketches missed the feature cache",
        );
        const stages = Object.fromEntries(
            [...new Set(records.map((record) => record.stage))].map((stage) => {
                const events = records.filter((record) => record.stage === stage);
                return [
                    stage,
                    {
                        count: events.length,
                        totalMs: events.reduce((sum, record) => sum + record.durationMs, 0),
                        maxMs: Math.max(...events.map((record) => record.durationMs)),
                    },
                ];
            }),
        );
        return {
            mode,
            elapsedMs,
            maxEventLoopGapMs,
            mainWasmCapacityCold,
            mainWasmCapacityAfterSessions: capacity(),
            workerBooleans: worker.length,
            mainBooleans: main.length,
            longestWorkerBooleanMs: Math.max(0, ...worker.map((record) => record.durationMs)),
            longestMainBooleanMs: Math.max(0, ...main.map((record) => record.durationMs)),
            residentHits: records
                .filter((record) => record.stage === "replica.capture")
                .reduce((sum, record) => sum + Number(record.details?.["residentHits"] ?? 0), 0),
            stages,
            trackedIdsHash,
            unchangedSketchSessions: sessions,
            frames,
            inputDuringFirstOperation,
            topologyMatches,
            volume,
            unchangedPristinePayloads: true,
        };
    } finally {
        clearInterval(timer);
        ticking = false;
        PerformanceTrace.disable();
        button.remove();
        release();
    }
}

Object.assign(globalThis, { workerApplicationSmoke: run });
