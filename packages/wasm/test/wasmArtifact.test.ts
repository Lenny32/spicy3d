// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fetchScript = path.join(repoRoot, "scripts/fetch-wasm.mjs");
const artifactScript = path.join(repoRoot, "scripts/wasm-artifact.mjs");

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

interface Run {
    code: number;
    out: string;
}

/** Async: the local release server answers from this process's event loop. */
function run(script: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [script, ...args],
            { cwd: repoRoot, env: { ...process.env, SPICY3D_SKIP_WASM_FETCH: "", ...env } },
            (error, stdout, stderr) => {
                resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` });
            },
        );
    });
}

const RELEASE = { "spicy-wasm.wasm": "\0asm kernel bytes", "spicy-wasm.js": "export default () => {};" };

describe("fetch-wasm", () => {
    let dir: string;
    let lib: string;
    let lockFile: string;
    let cache: string;
    let server: Server;
    let baseUrl: string;
    let served: Record<string, string>;
    let requests: string[];

    const writeLockFor = (files: Record<string, string>, tag = "wasm-test") =>
        writeFileSync(
            lockFile,
            JSON.stringify({
                schema: 1,
                inputs: "0".repeat(64),
                tag,
                url: `${baseUrl}/${tag}`,
                files: Object.fromEntries(
                    Object.entries(files).map(([name, content]) => [name, { sha256: sha256(content) }]),
                ),
            }),
        );
    const fetchWasm = (extra: string[] = [], env: Record<string, string> = {}) =>
        run(fetchScript, ["--lib", lib, "--lock", lockFile, ...extra], {
            SPICY3D_WASM_CACHE: cache,
            ...env,
        });
    const libFile = (name: string) => readFileSync(path.join(lib, name), "utf8");

    beforeEach(async () => {
        dir = mkdtempSync(path.join(tmpdir(), "spicy3d-fetch-wasm-"));
        lib = path.join(dir, "lib");
        cache = path.join(dir, "cache");
        lockFile = path.join(dir, "wasm.lock.json");
        served = { ...RELEASE };
        requests = [];
        server = createServer((request, response) => {
            requests.push(request.url ?? "");
            const name = path.basename(request.url ?? "");
            if (name in served) response.end(served[name]);
            else response.writeHead(404).end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        writeLockFor(RELEASE);
    });

    afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
        rmSync(dir, { recursive: true, force: true });
    });

    test("downloads the pinned files, then has nothing to do", async () => {
        const first = await fetchWasm();
        expect(first.out).toContain("spicy-wasm.wasm of wasm-test");
        expect(first.code).toBe(0);
        expect(libFile("spicy-wasm.wasm")).toBe(RELEASE["spicy-wasm.wasm"]);
        expect(libFile("spicy-wasm.js")).toBe(RELEASE["spicy-wasm.js"]);
        expect(requests).toEqual(["/wasm-test/spicy-wasm.wasm", "/wasm-test/spicy-wasm.js"]);

        const second = await fetchWasm();
        expect(second.code).toBe(0);
        expect(second.out).toContain("kernel wasm-test is in place");
        expect(requests).toHaveLength(2);
    });

    test("a file that is not the pinned one stops it and writes nothing", async () => {
        served["spicy-wasm.js"] = "tampered";
        const result = await fetchWasm();
        expect(result.code).toBe(1);
        expect(result.out).toContain("is not the pinned spicy-wasm.js");
        expect(existsSync(path.join(lib, "spicy-wasm.wasm"))).toBe(false);
        expect(existsSync(path.join(lib, "spicy-wasm.js"))).toBe(false);
    });

    test("a missing release asset names the WASM workflow", async () => {
        delete served["spicy-wasm.wasm"];
        const result = await fetchWasm();
        expect(result.code).toBe(1);
        expect(result.out).toContain("HTTP 404");
        expect(result.out).toContain("wasm.yml");
    });

    test("SPICY3D_WASM_DIR serves a machine without network access", async () => {
        const offline = path.join(dir, "offline");
        mkdirSync(offline);
        for (const [name, content] of Object.entries(RELEASE))
            writeFileSync(path.join(offline, name), content);
        const result = await fetchWasm([], {
            SPICY3D_WASM_DIR: offline,
            SPICY3D_WASM_BASE_URL: "http://127.0.0.1:9",
        });
        expect(result.code).toBe(0);
        expect(libFile("spicy-wasm.wasm")).toBe(RELEASE["spicy-wasm.wasm"]);
        expect(requests).toEqual([]);
    });

    test("a wrong file in SPICY3D_WASM_DIR is an error, not a download", async () => {
        const offline = path.join(dir, "offline");
        mkdirSync(offline);
        writeFileSync(path.join(offline, "spicy-wasm.wasm"), "other build");
        const result = await fetchWasm([], { SPICY3D_WASM_DIR: offline });
        expect(result.code).toBe(1);
        expect(result.out).toContain("is not the spicy-wasm.wasm of wasm-test");
        expect(requests).toEqual([]);
    });

    test("another checkout gets the files from the download cache", async () => {
        expect((await fetchWasm()).code).toBe(0);
        lib = path.join(dir, "other-checkout");
        const result = await fetchWasm();
        expect(result.code).toBe(0);
        expect(result.out).toContain("from cache");
        expect(libFile("spicy-wasm.js")).toBe(RELEASE["spicy-wasm.js"]);
        expect(requests).toHaveLength(2);
    });

    test("keeps a local build unless forced", async () => {
        mkdirSync(lib);
        writeFileSync(path.join(lib, "spicy-wasm.wasm"), "local build");
        writeFileSync(path.join(lib, "spicy-wasm.js"), "local glue");

        const kept = await fetchWasm();
        expect(kept.code).toBe(0);
        expect(kept.out).toContain("keeping the local build");
        expect(libFile("spicy-wasm.wasm")).toBe("local build");
        expect(requests).toEqual([]);

        const forced = await fetchWasm(["--force"]);
        expect(forced.code).toBe(0);
        expect(libFile("spicy-wasm.wasm")).toBe(RELEASE["spicy-wasm.wasm"]);
    });

    test("replaces files it fetched once the lock moves on", async () => {
        expect((await fetchWasm()).code).toBe(0);
        const next = { "spicy-wasm.wasm": "\0asm next kernel", "spicy-wasm.js": RELEASE["spicy-wasm.js"] };
        served = next;
        writeLockFor(next, "wasm-next");

        const result = await fetchWasm();
        expect(result.code).toBe(0);
        expect(libFile("spicy-wasm.wasm")).toBe(next["spicy-wasm.wasm"]);
        expect(requests.slice(2)).toEqual(["/wasm-next/spicy-wasm.wasm"]);
    });
});

describe("wasm-artifact", () => {
    let root: string;

    const write = (file: string, content: string) => {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), content);
    };
    const inputs = async () => {
        const result = await run(artifactScript, ["inputs", "--root", root]);
        expect(result.code).toBe(0);
        return result.out.trim();
    };

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "spicy3d-wasm-artifact-"));
        write("cpp/CMakeLists.txt", "project (spicy-wasm)\n");
        write("cpp/src/factory.cpp", "int a;\n");
        write("scripts/setup_wasm_deps.mjs", 'tag: "V8_0_1"\n');
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    test("the inputs hash follows the sources and toolchain pins only", async () => {
        const before = await inputs();
        expect(before).toMatch(/^[0-9a-f]{64}$/);

        write("cpp/build/occt/huge.cxx", "build output");
        write("cpp/README.md", "docs only");
        write("cpp/src/factory.cpp", "int a;\r\n");
        expect(await inputs()).toBe(before);

        write("cpp/src/factory.cpp", "int b;\n");
        const changedSource = await inputs();
        expect(changedSource).not.toBe(before);

        write("scripts/setup_wasm_deps.mjs", 'tag: "V8_0_2"\n');
        expect(await inputs()).not.toBe(changedSource);
    });

    test("check fails on a lock of other sources or another .d.ts", async () => {
        const built = path.join(root, "built");
        mkdirSync(built);
        for (const name of ["spicy-wasm.wasm", "spicy-wasm.js", "spicy-wasm.d.ts"]) {
            writeFileSync(path.join(built, name), `${name} content`);
        }
        mkdirSync(path.join(root, "packages/wasm/lib"), { recursive: true });
        expect((await run(artifactScript, ["lock", "--dir", built, "--root", root])).code).toBe(0);
        const lock = JSON.parse(readFileSync(path.join(root, "packages/wasm/wasm.lock.json"), "utf8"));
        expect(lock.tag).toBe(`wasm-${(await inputs()).slice(0, 16)}`);
        expect(lock.files["spicy-wasm.wasm"].sha256).toBe(sha256("spicy-wasm.wasm content"));
        expect((await run(artifactScript, ["check", "--root", root])).code).toBe(0);

        write("packages/wasm/lib/spicy-wasm.d.ts", "other types");
        const types = await run(artifactScript, ["check", "--root", root]);
        expect(types.code).toBe(1);
        expect(types.out).toContain("spicy-wasm.d.ts is not the one of release");

        write("packages/wasm/lib/spicy-wasm.d.ts", "spicy-wasm.d.ts content");
        write("cpp/src/factory.cpp", "int changed;\n");
        const sources = await run(artifactScript, ["check", "--root", root]);
        expect(sources.code).toBe(1);
        expect(sources.out).toContain("the kernel's sources changed");
    });

    test("the committed lock pins the committed .d.ts and its release URL", () => {
        const lock = JSON.parse(readFileSync(path.join(repoRoot, "packages/wasm/wasm.lock.json"), "utf8"));
        expect(lock.tag).toBe(`wasm-${lock.inputs.slice(0, 16)}`);
        expect(lock.url).toBe(`https://github.com/Lenny32/spicy3d/releases/download/${lock.tag}`);
        expect(lock.files["spicy-wasm.d.ts"].sha256).toBe(
            sha256(readFileSync(path.join(repoRoot, "packages/wasm/lib/spicy-wasm.d.ts"))),
        );
    });
});
