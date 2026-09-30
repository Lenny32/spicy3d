// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    EditableShapeNode,
    getCurrentApplication,
    KernelRecovery,
    KernelRecoveryCheckpoints,
    KernelState,
    Plane,
    Transaction,
} from "@spicy3d/core";
import { retireKernelModule } from "../../src/kernelGuard";

function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}

async function run() {
    const application = getCurrentApplication();
    check(KernelRecovery.current.available, "Application startup did not install recovery");
    const release = AutosaveHolds.hold("browser recovery proof");
    try {
        const documents = [];
        const nodes: EditableShapeNode[] = [];
        for (let index = 0; index < 2; index++) {
            const document = await application.newDocument(`recovery-${index}`);
            const shape = application.shapeProvider.factory.box(Plane.XY, 10, 10, 10);
            check(shape.isOk, shape.isOk ? "" : shape.error);
            const node = new EditableShapeNode({
                document,
                id: `recovery-node-${index}`,
                name: "box",
                shape,
            });
            Transaction.execute(document, "committed geometry", () => document.modelManager.addNode(node));
            document.markSaved();
            if (index === 0) node.name = "unsaved committed name";
            check(KernelRecoveryCheckpoints.capture(document), "Committed checkpoint was not captured");
            documents.push(document);
            nodes.push(node);
        }
        const view = application.activeView;
        check(view, "No active view");
        const position = view.cameraController.cameraPosition;
        const target = view.cameraController.cameraTarget;
        const oldModule = globalThis.wasm;
        const oldHandle = nodes[0].shape.value;
        retireKernelModule(oldModule, "browser proof injected fatal generation");
        KernelState.current.markCrashed("browser proof injected fatal generation");
        document.documentElement.dataset.recoveryReady = "true";
        const deadline = performance.now() + 60_000;
        while (KernelState.current.isCrashed || KernelRecovery.current.status === "recovering") {
            check(performance.now() < deadline, `Recovery did not finish: ${KernelRecovery.current.error}`);
            if (KernelRecovery.current.status === "failed") throw new Error(KernelRecovery.current.error);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        check(!KernelRecovery.current.error, `Recovery reported: ${KernelRecovery.current.error}`);
        check(globalThis.wasm !== oldModule, "Recovery reused the retired main module");
        check(application.activeView === view, "Active view changed");
        check(view.cameraController.cameraPosition.isEqualTo(position), "Camera position changed");
        check(view.cameraController.cameraTarget.isEqualTo(target), "Camera target changed");
        let oldRejected = false;
        try {
            oldHandle.checkShape();
        } catch {
            oldRejected = true;
        }
        check(oldRejected, "Old native handle became usable after recovery");
        for (let index = 0; index < documents.length; index++) {
            const document = documents[index];
            const node = document.modelManager.findNode((item) => item.id === nodes[index].id);
            check(node instanceof EditableShapeNode, "Stable node identity was lost");
            check(node !== nodes[index], "Old graph was retained");
            check(node.name === (index === 0 ? "unsaved committed name" : "box"), "Committed edit changed");
            check(node.shape.value.checkShape(), "Recovered native solid is invalid");
            check(Math.abs(node.shape.value.volume() - 1000) < 1e-6, "Recovered volume changed");
            check(document.isDirty === (index === 0), "Dirty state changed");
            check(
                document.history.undoCount() === 0 && document.history.redoCount() === 0,
                "Undo boundary missing",
            );
        }
        const fresh = application.shapeProvider.factory.box(Plane.XY, 2, 3, 4);
        check(fresh.isOk && Math.abs(fresh.value.volume() - 24) < 1e-6, "Fresh native operation failed");
        return {
            documentIds: documents.map((item) => item.id),
            nativeModuleReplaced: true,
            oldHandleRejected: oldRejected,
            volumes: [1000, 1000],
            dirty: documents.map((item) => item.isDirty),
            undoReset: true,
            sameViewAndCamera: true,
            crash: "injected fatal generation",
        };
    } finally {
        release();
    }
}

(globalThis as unknown as { kernelRecoverySmoke: typeof run }).kernelRecoverySmoke = run;
