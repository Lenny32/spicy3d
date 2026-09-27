// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { CloudClient, CSRF_HEADER, ifMatch, newIdempotencyKey } from "../src/client";
import type { CloudError } from "../src/problem";

const BASE = "https://spicy.test";

/**
 * Happy-DOM's `Request` drops the headers of a `Headers` instance that isn't its own, and the global
 * `Headers` (the one openapi-fetch builds) is Node's; browsers have a single class. Normalize to a
 * plain record so the tests see the headers a browser would send.
 */
class TestRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
        const headers =
            init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers;
        super(input, { ...init, headers });
    }
}

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
    const contentType = status >= 400 ? "application/problem+json" : "application/json";
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": contentType, ...headers },
    });
}

function clientAnswering(answer: (request: Request) => Response | Promise<Response>) {
    const requests: Request[] = [];
    const fetch = rs.fn(async (request: Request) => {
        requests.push(request);
        return answer(request);
    });
    return { client: new CloudClient({ baseUrl: `${BASE}/`, fetch }), requests, fetch };
}

const DOCUMENT = {
    id: "doc-1",
    name: "Bracket",
    headVersionId: "0190a0c2-0000-7000-8000-000000000001",
    sizeBytes: 42,
    thumbnailSha256: null,
    createdAt: "2026-09-25T14:03:11.123Z",
    updatedAt: "2026-09-25T14:03:11.123Z",
    deletedAt: null,
    head: null,
};

async function errorOf(answer: Response | (() => never)): Promise<CloudError> {
    const { client } = clientAnswering(() => (typeof answer === "function" ? answer() : answer));
    const result = await client.call((api) => api.GET("/api/me"));
    expect(result.isOk).toBe(false);
    return result.error;
}

describe("CloudClient requests", () => {
    test("GET goes to the base URL with the session cookie and without the CSRF header", async () => {
        const { client, requests } = clientAnswering(() => json(200, DOCUMENT));

        const result = await client.call((api) =>
            api.GET("/api/documents/{id}", { params: { path: { id: "doc-1" } } }),
        );

        expect(result.isOk).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe(`${BASE}/api/documents/doc-1`);
        expect(requests[0].method).toBe("GET");
        expect(requests[0].credentials).toBe("same-origin");
        expect(requests[0].headers.get(CSRF_HEADER)).toBeNull();
    });

    test.each([
        ["POST", (c: CloudClient) => c.call((api) => api.POST("/api/auth/logout"))],
        [
            "PUT",
            (c: CloudClient) =>
                c.call((api) =>
                    api.PUT("/api/blobs/{sha256}", {
                        params: { path: { sha256: "ab" } },
                        body: new Blob(["bytes"]),
                        bodySerializer: (blob) => blob,
                        headers: { "Content-Type": "application/octet-stream" },
                    }),
                ),
        ],
        [
            "PATCH",
            (c: CloudClient) => c.call((api) => api.PATCH("/api/me", { body: { displayName: "Ada" } })),
        ],
        [
            "DELETE",
            (c: CloudClient) =>
                c.call((api) => api.DELETE("/api/me/sessions/{id}", { params: { path: { id: "s" } } })),
        ],
    ])("%s carries X-Spicy3D-Request: 1", async (method, send) => {
        const { client, requests } = clientAnswering(() => new Response(null, { status: 204 }));

        const result = await send(client);

        expect(result.isOk).toBe(true);
        expect(requests[0].method).toBe(method);
        expect(requests[0].headers.get(CSRF_HEADER)).toBe("1");
        expect(requests[0].credentials).toBe("same-origin");
    });

    test("If-Match and Idempotency-Key are sent as given", async () => {
        const { client, requests } = clientAnswering(() => json(201, { id: "v2" }));
        const key = newIdempotencyKey();

        await client.call((api) =>
            api.POST("/api/documents/{id}/versions", {
                params: {
                    path: { id: "doc-1" },
                    header: { "If-Match": ifMatch(DOCUMENT.headVersionId), "Idempotency-Key": key },
                },
                body: {
                    kind: "manual",
                    parentIds: [DOCUMENT.headVersionId],
                    manifestSha256: "a".repeat(64),
                    blobs: [],
                    formatVersion: 1,
                    label: null,
                    thumbnailSha256: null,
                    deviceName: null,
                    clientId: null,
                },
            }),
        );

        expect(requests[0].headers.get("If-Match")).toBe(`"${DOCUMENT.headVersionId}"`);
        expect(requests[0].headers.get("Idempotency-Key")).toBe(key);
        expect(requests[0].headers.get("Content-Type")).toBe("application/json");
        expect(requests[0].headers.get(CSRF_HEADER)).toBe("1");
    });

    test("idempotency keys are unique per operation", () => {
        const keys = new Set(Array.from({ length: 20 }, newIdempotencyKey));
        expect(keys.size).toBe(20);
        for (const key of keys) expect(key).toMatch(/^[\x21-\x7e]{1,128}$/);
    });

    test.each([
        ["0190a0c2", '"0190a0c2"'],
        ['"0190a0c2"', '"0190a0c2"'],
        ['W/"0190a0c2"', '"0190a0c2"'],
    ])("ifMatch(%s) is %s", (version, header) => {
        expect(ifMatch(version)).toBe(header);
    });
});

describe("CloudClient replies", () => {
    test("a success carries the data, the unquoted ETag and the replay flag", async () => {
        const { client } = clientAnswering(() =>
            json(200, DOCUMENT, { ETag: `"${DOCUMENT.headVersionId}"`, "Idempotent-Replayed": "true" }),
        );

        const result = await client.call((api) =>
            api.GET("/api/documents/{id}", { params: { path: { id: "doc-1" } } }),
        );

        expect(result.isOk).toBe(true);
        expect(result.value.data.name).toBe("Bracket");
        expect(result.value.status).toBe(200);
        expect(result.value.etag).toBe(DOCUMENT.headVersionId);
        expect(result.value.replayed).toBe(true);
    });

    test("204 is a success without data", async () => {
        const { client } = clientAnswering(() => new Response(null, { status: 204 }));

        const result = await client.call((api) => api.POST("/api/auth/logout"));

        expect(result.isOk).toBe(true);
        expect(result.value.status).toBe(204);
        expect(result.value.data).toBeUndefined();
        expect(result.value.replayed).toBe(false);
    });
});

describe("CloudClient errors", () => {
    test("problem+json keeps its code and extensions", async () => {
        const error = await errorOf(
            json(409, {
                type: "urn:spicy3d:problem:version_conflict",
                title: "Conflict",
                status: 409,
                detail: "The document has a newer head version",
                code: "version_conflict",
                traceId: "00-abc-01",
                headVersionId: "v9",
                headCreatedAt: "2026-09-25T14:03:11.123Z",
                headDeviceName: "Laptop",
            }),
        );

        expect(error).toEqual({
            kind: "problem",
            status: 409,
            problem: {
                type: "urn:spicy3d:problem:version_conflict",
                title: "Conflict",
                status: 409,
                detail: "The document has a newer head version",
                code: "version_conflict",
                traceId: "00-abc-01",
                headVersionId: "v9",
                headCreatedAt: "2026-09-25T14:03:11.123Z",
                headDeviceName: "Laptop",
            },
        });
    });

    test("validation_failed keeps the field → codes map", async () => {
        const error = await errorOf(
            json(422, {
                status: 422,
                code: "validation_failed",
                errors: { name: ["name_too_long"], x: [1] },
            }),
        );

        expect(error.kind).toBe("problem");
        expect(error.kind === "problem" && error.problem.errors).toEqual({ name: ["name_too_long"], x: [] });
    });

    test("a problem without code gets the status' default code", async () => {
        const error = await errorOf(json(404, { title: "Not Found", status: 404 }));

        expect(error.kind === "problem" && error.problem.code).toBe("not_found");
    });

    test("a non-JSON error body (e.g. a proxy page) becomes the status' default problem", async () => {
        const error = await errorOf(new Response("<html>Bad Gateway</html>", { status: 502 }));

        expect(error).toEqual({
            kind: "problem",
            status: 502,
            problem: { status: 502, code: "internal_error" },
        });
    });

    test("Retry-After is read in seconds", async () => {
        const error = await errorOf(json(429, { code: "too_many_requests" }, { "Retry-After": "30" }));

        expect(error.kind === "problem" && error.retryAfterSeconds).toBe(30);
    });

    test("no answer is offline", async () => {
        const error = await errorOf(() => {
            throw new TypeError("Failed to fetch");
        });

        expect(error).toEqual({ kind: "offline" });
    });

    test("an aborted request is aborted, not offline", async () => {
        const error = await errorOf(() => {
            throw new DOMException("The operation was aborted.", "AbortError");
        });

        expect(error).toEqual({ kind: "aborted" });
    });

    test("a 200 that isn't JSON is an invalid response", async () => {
        const error = await errorOf(new Response("<!doctype html><html></html>", { status: 200 }));

        expect(error).toEqual({ kind: "invalidResponse" });
    });
});
