// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { profileDeploymentConfig, serveProfileDeployment } from "./profile-deployment.mjs";

for (const mode of [undefined, "main", "hybrid", "auto", "worker"]) {
    test(`startup config is served over HTTP, mode=${mode ?? "default"}`, async () => {
        const config = profileDeploymentConfig(mode);
        const server = createServer((request, response) => {
            if (serveProfileDeployment(request, response, config)) return;
            // Simulate a conflicting static deployment; the interception must take precedence.
            response
                .writeHead(200)
                .end(JSON.stringify({ performance: { geometryWorker: mode !== "hybrid" } }));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const url = `http://127.0.0.1:${server.address().port}/deployment.json`;
            const response = await fetch(url);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(response.headers.get("content-type"), "application/json");
            assert.deepEqual(await response.json(), { performance: { geometryWorker: mode === "hybrid" } });
            const unsafe = await fetch(url, { method: "PUT", body: "overwrite" });
            assert.equal(unsafe.status, 405);
            assert.deepEqual(
                await (await fetch(url)).json(),
                config,
                "unsafe method cannot change deployment",
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
}
test("invalid mode cannot accidentally opt in", () => {
    assert.throws(() => profileDeploymentConfig("true"), /Invalid kernel mode/);
});
