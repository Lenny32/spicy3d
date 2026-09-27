// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ExternalContentPolicy, Observable, PubSub } from "@spicy3d/core";
import { Account } from "./account/account";
import type { ConfigResponse } from "./api";
import { CloudClient, type CloudClientOptions } from "./client";
import type { ApiCompatibility, CloudDiscovery } from "./config";

export type CloudOptions = CloudClientOptions;

/** A reachable server that speaks this client's contract. */
export class CloudConnection {
    /** Who is signed in to this server; see {@link Account}. */
    readonly account: Account;

    constructor(
        readonly config: ConfigResponse,
        readonly client: CloudClient,
    ) {
        this.account = new Account(client);
    }
}

/**
 * The app's cloud state: `connection` stays `undefined` (and no cloud UI shows) unless a compatible
 * server was discovered. Observable, so the account UI can appear once it's set.
 */
export class Cloud extends Observable {
    static readonly current = new Cloud();

    get connection(): CloudConnection | undefined {
        return this.getPrivateValue("connection", undefined);
    }
    set connection(value: CloudConnection | undefined) {
        this.setProperty("connection", value);
    }

    /** The account of the connected server; `undefined` while the cloud is dormant. */
    get account(): Account | undefined {
        return this.connection?.account;
    }
}

export const API_VERSION_BANNER_ID = "cloud.apiVersion";

/** Non-blocking: the app keeps working locally, only cloud features wait for the reload. */
export function showApiVersionBanner(compatibility: Exclude<ApiCompatibility, "compatible">) {
    if (compatibility === "serverNewer") {
        PubSub.default.pub("showBanner", {
            id: API_VERSION_BANNER_ID,
            level: "warn",
            message: "cloud.banner.appOutdated",
            action: { label: "common.reload", run: () => globalThis.location.reload() },
        });
    } else {
        PubSub.default.pub("showBanner", {
            id: API_VERSION_BANNER_ID,
            level: "warn",
            message: "cloud.banner.serverOutdated",
        });
    }
}

/**
 * Acts on a discovery: a compatible server becomes `Cloud.current.connection`; an incompatible one
 * shows the reload banner and stays unused; no server changes nothing.
 */
export function startCloud(
    discovery: CloudDiscovery,
    options: CloudOptions = {},
): CloudConnection | undefined {
    switch (discovery.status) {
        case "dormant":
            return undefined;
        case "incompatible":
            showApiVersionBanner(discovery.compatibility);
            return undefined;
        case "ready": {
            const connection = new CloudConnection(discovery.config, new CloudClient(options));
            Cloud.current.connection = connection;
            // Plugins loaded from other origins ask while a session may exist (CLOUD-17).
            ExternalContentPolicy.setSessionProbe(() => connection.account.status !== "signedOut");
            return connection;
        }
    }
}
