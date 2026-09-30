// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelRecovery, KernelState, Result } from "@spicy3d/core";
import { SerialQueue } from "../src/mcp/server";
import { isProgramJobTool } from "../src/tools/programJobs";
import { isMetadataReadTool } from "../src/tools/readTools";
import { buildRecoveryTools } from "../src/tools/recoveryTools";

test("recovery tool is available only with real support and retains normal mutation FIFO identity", async () => {
    expect(buildRecoveryTools()).toEqual([]);
    const events: string[] = [];
    const uninstall = KernelRecovery.current.install(async () => {
        events.push("recovery");
        KernelState.current.reset();
        return Result.ok({ documentIds: ["document"], undoReset: true });
    });
    try {
        const [tool] = buildRecoveryTools();
        expect(tool.name).toBe("recover_kernel");
        expect(isMetadataReadTool(tool)).toBe(false);
        expect(isProgramJobTool(tool)).toBe(false);
        KernelState.current.markCrashed("test crash");
        const queue = new SerialQueue();
        let release!: () => void;
        const previous = queue.run(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        await Promise.resolve();
        const recovery = queue.run(() => tool.handler({}));
        const next = queue.run(async () => {
            events.push("next mutation");
        });
        expect(events).toEqual([]);
        release();
        await previous;
        expect(JSON.parse((await recovery) as string)).toEqual({
            documentIds: ["document"],
            undoReset: true,
        });
        await next;
        expect(events).toEqual(["recovery", "next mutation"]);
    } finally {
        uninstall();
        KernelState.current.reset();
    }
    expect(buildRecoveryTools()).toEqual([]);
});
