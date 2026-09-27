// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export type JsonSchema = Record<string, unknown>;

/** A tool the MCP server exposes: clients read name/description/parameters, the server runs handler. */
export interface Tool {
    name: string;
    description: string;
    parameters: JsonSchema;
    /** `signal` aborts when the request is cancelled; long-running handlers should respect it. */
    handler: (
        args: Record<string, unknown>,
        signal?: AbortSignal,
        context?: ToolCallContext,
    ) => Promise<string | ToolResult>;
}

/** Who is calling, when the front end knows (MCP: the session, so its open questions end with it). */
export interface ToolCallContext {
    /** Stable per MCP session: the relay's agent id (or the connection's, when a request names none). */
    caller?: string;
}

export interface ImagePart {
    mediaType: string; // e.g. "image/png", "image/jpeg"
    data: string; // base64, without the data URL prefix
}

/** A tool result that can carry images (e.g. a viewport screenshot) back to the model. */
export interface ToolResult {
    content: string;
    images?: ImagePart[];
}
