// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ErrorLog } from "@spicy3d/core";
import type { Tool } from "../llm/types";

const DEFAULT_LIMIT = 20;

/** The session error list the user sees in the viewport's bottom-left corner (never saved). */
export function buildErrorLogTools(): Tool[] {
    return [
        {
            name: "get_error_log",
            description:
                "Read the errors of this session (the list the user sees in the app's bottom-left corner): time, source, message and details such as a stack trace. Newest last. The same errors also arrive as `notifications/message` logging messages (level error) while connected.",
            parameters: {
                type: "object",
                properties: {
                    limit: {
                        type: "number",
                        description: `Newest entries to return (default ${DEFAULT_LIMIT}).`,
                    },
                    clear: { type: "boolean", description: "Clear the list after reading it." },
                },
            },
            handler: async (args) => {
                const limit =
                    typeof args["limit"] === "number" && args["limit"] > 0 ? args["limit"] : DEFAULT_LIMIT;
                const all = ErrorLog.entries;
                const entries = all.slice(-limit).map((e) => ({
                    id: e.id,
                    time: new Date(e.time).toISOString(),
                    source: e.source,
                    message: e.message,
                    details: e.details,
                }));
                if (args["clear"] === true) ErrorLog.clear();
                return JSON.stringify({ total: all.length, entries });
            },
        },
    ];
}
