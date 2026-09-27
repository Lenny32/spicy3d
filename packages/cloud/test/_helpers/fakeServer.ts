// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { ObjectStorage } from "@spicy3d/core";
import { Account, type AccountUser } from "../../src/account/account";
import { CloudDeviceSettings } from "../../src/account/deviceSettings";
import { CloudClient } from "../../src/client";

export const BASE = "https://spicy.test";

export const USER: AccountUser = {
    id: "0190a0c2-0000-7000-8000-00000000000a",
    email: "ada@example.test",
    displayName: "Ada Lovelace",
    emailVerified: true,
    roles: [],
    createdAt: "2026-09-01T08:00:00Z",
};

/**
 * Happy-DOM's `Request` drops the headers of a `Headers` instance that isn't its own (openapi-fetch
 * builds Node's); normalize to a plain record as in client.test.ts.
 */
export class TestRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
        const headers =
            init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers;
        super(input, { ...init, headers });
    }
}

export function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
    if (body === undefined) return new Response(null, { status, headers });
    const contentType = status >= 400 ? "application/problem+json" : "application/json";
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": contentType, ...headers },
    });
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
    return json(status, { status, code, ...extra });
}

export interface RecordedRequest {
    method: string;
    path: string;
    search: string;
    body: unknown;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * A scripted server: `on("POST /api/auth/login", a, b)` answers that route with `a`, then `b` from
 * then on (replacing earlier answers of the route); every request is recorded with its JSON body.
 */
export class FakeServer {
    readonly requests: RecordedRequest[] = [];
    private readonly routes = new Map<string, Handler[]>();

    readonly fetch = rs.fn(async (request: Request) => {
        const url = new URL(request.url);
        const path = url.pathname;
        const text = await request.text();
        const recorded: RecordedRequest = {
            method: request.method,
            path,
            search: url.search,
            body: text ? JSON.parse(text) : undefined,
        };
        this.requests.push(recorded);
        const key = `${request.method} ${path}`;
        const handlers = this.routes.get(key);
        if (!handlers || handlers.length === 0) return problem(404, "not_found");
        const handler = handlers.length > 1 ? handlers.shift()! : handlers[0];
        return handler(recorded);
    });

    on(route: string, ...answers: (Response | Handler)[]): this {
        const handlers = answers.map((answer) =>
            answer instanceof Response ? () => answer.clone() : answer,
        );
        this.routes.set(route, handlers);
        return this;
    }

    /** The routes requested, e.g. `["GET /api/me", "POST /api/auth/login"]`. */
    get calls(): string[] {
        return this.requests.map((r) => `${r.method} ${r.path}`);
    }

    client(): CloudClient {
        return new CloudClient({ baseUrl: BASE, fetch: this.fetch });
    }
}

/** A fresh account over a fake server, with device settings in a storage no other test shares. */
export function accountOn(server: FakeServer, keepOfflineCopies = false): Account {
    const settings = new CloudDeviceSettings(new ObjectStorage("spicy3d-test", String(Math.random())));
    settings.keepOfflineCopies = keepOfflineCopies;
    return new Account(server.client(), settings);
}

/** An account already signed in as {@link USER}. */
export async function signedInAccount(server: FakeServer, keepOfflineCopies = false): Promise<Account> {
    server.on("GET /api/me", json(200, USER));
    const account = accountOn(server, keepOfflineCopies);
    await account.refresh();
    server.requests.length = 0;
    return account;
}
