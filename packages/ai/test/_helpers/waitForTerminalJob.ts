// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";

export function waitForTerminalJob<T extends { state: string }>(
    call: (name: string, args: Record<string, unknown>) => Promise<T>,
    tool: string,
    jobId: string,
) {
    return rs.waitFor(
        async () => {
            const value = await call(tool, { jobId });
            if (!["completed", "cancelled", "failed"].includes(value.state)) {
                throw new Error(`${tool} ${jobId} is still ${value.state}`);
            }
            return value;
        },
        { timeout: 10_000, interval: 5 },
    );
}
