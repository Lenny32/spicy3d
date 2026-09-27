// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result, trimTrailingSlashes } from "@spicy3d/core";
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./api";
import { defaultBaseUrl } from "./config";
import { type CloudError, toProblem } from "./problem";

/** Sent on every unsafe request; the server rejects unsafe requests without it (`csrf_failed`). */
export const CSRF_HEADER = "X-Spicy3D-Request";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export type ApiClient = Client<paths>;

export interface CloudClientOptions {
    /**
     * Where the server's `/api` lives, without trailing slash. Defaults to the folder the app is
     * served from (`https://host/` → `https://host/api/…`). The server allows no cross-origin
     * requests and its session cookie is `SameSite=Strict`, so it must be the app's origin.
     */
    baseUrl?: string;
    /** For tests: replaces `globalThis.fetch`. */
    fetch?: (request: Request) => Promise<Response>;
}

/** A successful answer. */
export interface CloudReply<T> {
    data: T;
    status: number;
    /** The `ETag` without quotes, e.g. a document's head version id; send it back with {@link ifMatch}. */
    etag?: string;
    /** The server answered a retry with the result of the original request (`Idempotent-Replayed`). */
    replayed: boolean;
}

type ApiResult<D> = Promise<{ data?: D; error?: unknown; response: Response }>;

/** A value for the `If-Match` header of a save based on `version` (a head version id or an ETag). */
export function ifMatch(version: string): string {
    return `"${version.replace(/^W\//, "").replace(/"/g, "")}"`;
}

/**
 * A new `Idempotency-Key`. Generate one per logical operation and send the same key with every retry
 * of it: a replay within 24 hours answers the original result instead of doing the work twice.
 */
export function newIdempotencyKey(): string {
    return crypto.randomUUID();
}

function parseEtag(value: string | null): string | undefined {
    if (!value) return undefined;
    return value.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/**
 * Typed access to the Spicy3D server. `api` is the generated client (paths, params and bodies typed
 * from the OpenAPI document); `call` runs one request and turns every outcome into a `Result`:
 *
 * ```ts
 * const saved = await cloud.call((api) =>
 *     api.POST("/api/documents/{id}/versions", {
 *         params: { path: { id }, header: { "If-Match": ifMatch(base), "Idempotency-Key": key } },
 *         body,
 *     }),
 * );
 * ```
 *
 * Cookies go with every request (same origin), and unsafe methods carry `X-Spicy3D-Request: 1`.
 */
export class CloudClient {
    readonly baseUrl: string;
    readonly api: ApiClient;

    constructor(options: CloudClientOptions = {}) {
        this.baseUrl = trimTrailingSlashes(options.baseUrl ?? defaultBaseUrl());
        this.api = createClient<paths>({
            baseUrl: this.baseUrl,
            credentials: "same-origin",
            headers: { Accept: "application/json, application/problem+json" },
            // Resolved per call so a test (or a service worker shim) replacing globalThis.fetch is honoured.
            fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
        });
        this.api.use({
            onRequest({ request }) {
                if (!SAFE_METHODS.has(request.method.toUpperCase())) {
                    request.headers.set(CSRF_HEADER, "1");
                }
                return request;
            },
        });
    }

    async call<D>(send: (api: ApiClient) => ApiResult<D>): Promise<Result<CloudReply<D>, CloudError>> {
        let answer: Awaited<ApiResult<D>>;
        try {
            answer = await send(this.api);
        } catch (error) {
            return Result.err(CloudClient.thrownError(error));
        }

        const { response } = answer;
        if (!response.ok) {
            return Result.err({
                kind: "problem",
                status: response.status,
                problem: toProblem(response.status, answer.error),
                retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
            });
        }
        return Result.ok({
            data: answer.data as D,
            status: response.status,
            etag: parseEtag(response.headers.get("ETag")),
            replayed: response.headers.get("Idempotent-Replayed") === "true",
        });
    }

    /** fetch rejects on no answer (TypeError) or abort; `response.json()` rejects on a non-JSON body. */
    private static thrownError(error: unknown): CloudError {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "AbortError") return { kind: "aborted" };
        if (error instanceof SyntaxError) return { kind: "invalidResponse" };
        return { kind: "offline" };
    }
}
