#!/usr/bin/env node
// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * spicy3d-mcp-bridge: an MCP stdio server whose tools run in the user's Spicy3D browser tab.
 *
 * stdout carries MCP messages only (newline-delimited JSON-RPC); every log line goes to stderr.
 *
 * Options and environment variables: see USAGE in options.mjs (`spicy3d-mcp-bridge --help`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { WebSocketServer } from "ws";
import packageJson from "../package.json" with { type: "json" };
import { BridgeCore, pairingUrl } from "./bridge.mjs";
import { parseOptions, USAGE } from "./options.mjs";

const HEARTBEAT_MS = 30_000;

// Imported rather than read from disk, so compiled binaries carry it too.
const { version } = packageJson;

let options;
try {
    options = parseOptions(process.argv.slice(2), process.env);
} catch (err) {
    process.stderr.write(`spicy3d-mcp-bridge: ${err.message}\n\n${USAGE}`);
    process.exit(2);
}
if (options.help) {
    process.stderr.write(USAGE);
    process.exit(0);
}
if (options.version) {
    process.stderr.write(`${version}\n`);
    process.exit(0);
}

const { appUrl, port, noToken, allowedOrigins } = options;
const token = noToken ? "" : options.token || randomBytes(16).toString("hex");

const log = (/** @type {string} */ text) => process.stderr.write(`[spicy3d-bridge] ${text}\n`);
const link = pairingUrl(appUrl, port, token);

const core = new BridgeCore({
    pairingUrl: link,
    version,
    log,
    sendToClient: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
});

/** @param {string | undefined} candidate */
function tokenMatches(candidate) {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
}

const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    maxPayload: 64 * 1024 * 1024, // screenshots travel base64-encoded
    handleProtocols: (protocols) => (protocols.has("mcp") ? "mcp" : false),
    verifyClient: ({ origin, req }, done) => {
        // The token is the real gate; the origin check keeps other sites in the same browser from
        // even trying, since any page can open a WebSocket to 127.0.0.1.
        if (!allowedOrigins.has(origin)) {
            log(`refused connection from origin ${origin || "(none)"}`);
            return done(false, 403, "origin not allowed");
        }
        if (noToken) return done(true);
        const candidate = new URL(req.url ?? "/", "ws://127.0.0.1").searchParams.get("token") ?? undefined;
        if (!tokenMatches(candidate)) {
            log("refused connection with a wrong or missing token");
            return done(false, 401, "bad token");
        }
        done(true);
    },
});

wss.on("error", (err) => {
    log(`cannot listen on 127.0.0.1:${port}: ${err.message}`);
    process.exit(1);
});

wss.on("listening", () => {
    log(`listening on ws://127.0.0.1:${port}`);
    if (noToken)
        log("WARNING: running without a pairing token; any program on this machine can drive the tab");
    log(`accepting pages from: ${[...allowedOrigins].join(", ")}`);
    log(`open Spicy3D with: ${link}`);
});

wss.on("connection", (socket) => {
    /** @type {import("./bridge.mjs").TabPeer} */
    const peer = {
        send: (message) => socket.send(JSON.stringify(message)),
        close: (code, reason) => socket.close(code, reason),
    };
    let alive = true;
    socket.on("pong", () => {
        alive = true;
    });
    const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
    }, HEARTBEAT_MS);

    core.attachTab(peer);
    socket.on("message", (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            log("dropped a malformed message from the tab");
            return;
        }
        core.handleTabMessage(peer, message);
    });
    socket.on("close", () => {
        clearInterval(heartbeat);
        core.detachTab(peer);
    });
});

createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
        );
        return;
    }
    core.handleClientMessage(message);
});

// The MCP client owns our lifetime: when it closes stdin, we are done.
process.stdin.on("end", () => {
    wss.close();
    process.exit(0);
});
