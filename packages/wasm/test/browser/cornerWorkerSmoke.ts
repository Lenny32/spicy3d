// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MainModule } from "../../lib/spicy-wasm";
import { replicaTopology, sameReplicaTopology } from "../../src/replicaTopology";
import { KernelWorkerClient } from "../../src/workerClient";
import { createKernelWorker } from "../../src/workerFactory";
import type { CornerReplica, KernelResult, ShapeReplica } from "../../src/workerProtocol";

function requireValue<T>(answer: KernelResult<T>): T {
    if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.value;
}
function requireCondition(value: boolean, error: string): void {
    if (!value) throw new Error(error);
}

async function cancelCorner(snapshot: ShapeReplica, indexes: number[]) {
    const worker = new Worker(new URL("./cancellationWorker.ts", import.meta.url), { type: "module" });
    let terminations = 0;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
        terminations++;
        terminate();
    };
    const client = new KernelWorkerClient(worker);
    const channel = new MessageChannel();
    worker.postMessage({ type: "probe-port", port: channel.port2 }, [channel.port2]);
    let returned = false;
    const entered = new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
            if (event.data === "corner-native-entered") resolve();
            if (event.data === "corner-native-returned") returned = true;
        };
    });
    let fresh: KernelWorkerClient | undefined;
    try {
        requireValue(await client.request("ready", undefined));
        const old = requireValue(await client.request("importBrep", { brep: snapshot.brep }));
        const signal = new AbortController();
        const pending = client.request(
            "cornerSetbackReplica",
            {
                shape: snapshot,
                edges: indexes,
                radius: 2,
                distances: [2.49, 2.5, 2.51],
            },
            signal.signal,
            { terminateOnAbort: true },
        );
        await Promise.race([
            entered,
            pending.then((answer) => {
                if (!answer.ok)
                    throw new Error(`Corner cancellation did not enter native: ${answer.error.message}`);
                throw new Error("Corner native operation returned before cancellation barrier");
            }),
        ]);
        requireCondition(!returned, "Corner native operation completed before cancellation");
        const started = performance.now();
        signal.abort();
        const answer = await pending;
        const cancellationMs = performance.now() - started;
        requireCondition(
            !answer.ok && answer.error.code === "cancelled",
            "Corner cancellation returned the wrong error",
        );
        requireCondition(
            cancellationMs < 250 && terminations === 1,
            "Corner worker did not terminate promptly exactly once",
        );
        requireCondition(
            client.isClosed && client.pendingRequests === 0 && client.pendingNative === 0,
            "Cancelled corner worker retained a generation or requests",
        );
        fresh = createKernelWorker();
        requireValue(await fresh.request("ready", undefined));
        const stale = await fresh.request("bounds", { handle: old });
        requireCondition(
            !stale.ok && stale.error.code === "invalid",
            "Fresh corner generation accepted an old handle",
        );
        const box = requireValue(
            await fresh.request("box", { origin: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 20, z: 30 } }),
        );
        requireCondition(
            Math.abs(requireValue(await fresh.request("bounds", { handle: box })).max.z - 30) < 1e-6,
            "Fresh worker geometry failed after corner cancellation",
        );
        requireValue(await fresh.request("release", { handles: [box] }));
        requireCondition(
            requireValue(await fresh.request("stats", undefined)).shapes === 0,
            "Fresh corner worker leaked handles",
        );
        return { cancellationMs, terminations, nativeEntryObserved: true, freshGeometryVerified: true };
    } finally {
        channel.port1.close();
        channel.port2.close();
        client.dispose();
        fresh?.dispose();
    }
}

/** Actual separate browser/WASM realm: no mocked native construction or copied output history. */
export async function cornerWorkerSmoke(main: MainModule, client: KernelWorkerClient) {
    const boxResult = main.ShapeFactory.box(
        {
            location: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 0, z: 1 },
            xDirection: { x: 1, y: 0, z: 0 },
        },
        40,
        40,
        40,
    );
    requireCondition(boxResult.isOk, "Corner input box failed");
    const box = boxResult.shape;
    const edges = main.Shape.findSubShapes(box, main.TopAbs_ShapeEnum.TopAbs_EDGE);
    try {
        const indexes = edges.flatMap((shape, index) => {
            const edge = main.TopoDS.edge(shape);
            try {
                return main.Edge.ends(edge).some((point) => Math.hypot(point.x, point.y, point.z) < 1e-6)
                    ? [index]
                    : [];
            } finally {
                edge.delete();
            }
        });
        requireCondition(indexes.length === 3, "Corner input lacks three origin edges");
        const snapshot = { brep: main.Converter.convertToBrep(box), topology: replicaTopology(main, box) };
        let ticks = 0;
        const timer = setInterval(() => {
            ticks++;
        }, 10);
        const started = performance.now();
        let result: CornerReplica;
        try {
            result = requireValue(
                await client.request("cornerSetbackReplica", {
                    shape: snapshot,
                    edges: indexes,
                    radius: 2,
                    distances: [2.49, 2.5, 2.51],
                }),
            );
        } finally {
            clearInterval(timer);
        }
        requireCondition(ticks > 10, "Browser main thread did not tick during the fitted corner");
        const elapsedMs = performance.now() - started;
        const output = main.Converter.convertFromBrep(result.brep);
        try {
            requireCondition(main.Shape.check(output), "Corner worker returned invalid BREP");
            requireCondition(
                main.Shape.volume(output) > 0 && main.Shape.volume(output) < 64000,
                "Corner worker returned the wrong solid volume",
            );
            requireCondition(
                sameReplicaTopology(result.topology, replicaTopology(main, output)),
                "Corner worker changed BREP topology order",
            );
            requireCondition(result.cornerFaces.length === 1, "Corner worker lost the explicit corner role");
            const corner = result.cornerFaces[0];
            const supports = new Set<number>();
            for (let i = 0; i < result.tracking.faceAncestors.length; i += 2)
                if (result.tracking.faceAncestors[i] === corner)
                    supports.add(result.tracking.faceAncestors[i + 1]);
            requireCondition(supports.size === 3, "Corner worker lost actual support ancestry");
            const stripSources = Array.from(result.tracking.faceEdgeMap)
                .filter((value, face) => value >= 0 && face !== corner)
                .sort((a, b) => a - b);
            requireCondition(
                JSON.stringify(stripSources) === JSON.stringify([...indexes].sort((a, b) => a - b)),
                "Corner worker lost actual generating strip edges",
            );
            for (const [metric, maximum] of [
                [result.g0Error, 1e-4],
                [result.g1Error, 1e-3],
                [result.fitDistanceError, 1e-4],
                [result.fitAngleError, 1e-3],
            ])
                requireCondition(
                    Number.isFinite(metric) && metric >= 0 && metric <= maximum,
                    "Corner worker violated a fitted or CAD continuity limit",
                );
            requireCondition(
                main.Converter.convertToBrep(box) === snapshot.brep,
                "Corner worker changed the main input BREP",
            );
        } finally {
            output.delete();
        }
        const cancellation = await cancelCorner(snapshot, indexes);
        return {
            elapsedMs,
            ticks,
            boundaryDistanceMm: result.g0Error,
            boundaryAngleRad: result.g1Error,
            occtApproxErrorMm: result.fitDistanceError,
            occtCriterionErrorRad: result.fitAngleError,
            cancellation,
        };
    } finally {
        for (const edge of edges) edge.delete();
        boxResult.delete();
    }
}
