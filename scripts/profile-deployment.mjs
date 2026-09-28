// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Benchmark-only startup response. Never reads/writes the deployment file or browser storage. */
export function profileDeploymentConfig(mode = "main") {
    if (!["main", "hybrid", "auto", "worker"].includes(mode)) throw new Error("Invalid kernel mode");
    return { performance: { geometryWorker: mode === "hybrid" } };
}

/** Intercepts the same-origin GET before static dist files; even a worker-enabled dist cannot override main. */
export function serveProfileDeployment(request, response, config) {
    if (new URL(request.url, "http://localhost").pathname !== "/deployment.json") return false;
    if (request.method !== "GET") response.writeHead(405).end();
    else
        response
            .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            .end(JSON.stringify(config));
    return true;
}
