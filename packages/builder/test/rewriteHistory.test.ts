// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = resolve(import.meta.dirname, "../../../scripts/rewrite-history.sh");
const TAG = "wasm-0123456789abcdef";
// Each case clones, filters and checks real repositories: seconds, not milliseconds.
const TIMEOUT = 60_000;
const hasFilterRepo = spawnSync("git", ["filter-repo", "--version"]).status === 0;

const GIT_ENV = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", ["-c", "init.defaultBranch=develop", ...args], {
        cwd,
        env: { ...process.env, ...GIT_ENV },
        encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
}

function write(root: string, file: string, content: string) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
}

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** The part of scripts/wasm-artifact.mjs (#191) the rewrite uses: `readLock` and `verify`. */
const WASM_ARTIFACT = `
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function readLock(file) {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    if (!/^wasm-[0-9a-f]{16}$/.test(lock.tag)) throw new Error("bad tag");
    return lock;
}
const sha = (file) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, ...args] = process.argv.slice(2);
    const option = (name) => args[args.indexOf(name) + 1];
    const lock = readLock(path.join(option("--root"), "packages/wasm/wasm.lock.json"));
    const wrong = Object.entries(lock.files).filter(([n, f]) => sha(path.join(option("--dir"), n)) !== f.sha256);
    process.exitCode = command === "verify" && wrong.length === 0 ? 0 : 1;
}
`;

const KERNEL = {
    "spicy-wasm.wasm": "\0asm kernel v2",
    "spicy-wasm.js": "glue v2",
    "spicy-wasm.d.ts": "types v2",
};

interface Fixture {
    dir: string;
    remote: string;
    releases: string;
    oldBranchTip: string;
}

/**
 * A repository like Spicy3D's around #191: chili-wasm binaries, then spicy-wasm ones, a release tag
 * 0.0.1 and a branch from back then, then develop/main with the kernel moved to a pinned release.
 */
function makeFixture(): Fixture {
    const dir = mkdtempSync(join(tmpdir(), "rewrite-history-"));
    const work = join(dir, "work");
    mkdirSync(work);
    git(work, "init", "-q");
    write(work, "README.md", "Spicy3D\n");
    write(work, "packages/wasm/lib/chili-wasm.wasm", "\0asm chili");
    write(work, "packages/wasm/lib/chili-wasm.js", "chili glue");
    write(work, "packages/wasm/lib/chili-wasm.d.ts", "chili types");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "Chili kernel");
    git(work, "tag", "0.0.1");

    git(work, "rm", "-q", "packages/wasm/lib/chili-wasm.wasm", "packages/wasm/lib/chili-wasm.js");
    write(work, "packages/wasm/lib/spicy-wasm.wasm", "\0asm kernel v1");
    write(work, "packages/wasm/lib/spicy-wasm.js", "glue v1");
    write(work, "packages/wasm/lib/spicy-wasm.d.ts", "types v1");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "Spicy kernel");
    write(work, "packages/wasm/lib/spicy-wasm.wasm", KERNEL["spicy-wasm.wasm"]);
    git(work, "commit", "-qam", "Rebuild the kernel only");
    git(work, "branch", "feature/old");
    const oldBranchTip = git(work, "rev-parse", "HEAD");

    git(work, "rm", "-q", "packages/wasm/lib/spicy-wasm.wasm", "packages/wasm/lib/spicy-wasm.js");
    write(work, "packages/wasm/lib/spicy-wasm.d.ts", KERNEL["spicy-wasm.d.ts"]);
    write(work, "scripts/wasm-artifact.mjs", WASM_ARTIFACT);
    const files = Object.fromEntries(
        Object.entries(KERNEL).map(([name, data]) => [name, { sha256: sha256(data), size: data.length }]),
    );
    write(
        work,
        "packages/wasm/wasm.lock.json",
        JSON.stringify({ schema: 1, tag: TAG, url: "unused", files }),
    );
    git(work, "add", "-A");
    git(work, "commit", "-qm", "The kernel is a release artifact (#191)");
    git(work, "tag", TAG);
    git(work, "branch", "main");

    const remote = join(dir, "remote.git");
    git(dir, "clone", "-q", "--bare", work, remote);
    // A pull request ref: GitHub refuses pushes to it, so it is neither rewritten nor pushed.
    git(remote, "update-ref", "refs/pull/1/head", oldBranchTip);

    const releases = join(dir, "releases");
    for (const [name, data] of Object.entries(KERNEL)) write(releases, `${TAG}/${name}`, data);
    return { dir, remote, releases, oldBranchTip };
}

/** Runs the script on the fixture's remote; `input` answers its confirmation prompt. */
function rewrite(fixture: Fixture, args: string[], input = "") {
    const result = spawnSync("bash", [SCRIPT, "--repo", fixture.remote, ...args], {
        cwd: fixture.dir,
        env: { ...process.env, ...GIT_ENV, SPICY3D_WASM_BASE_URL: pathToFileURL(fixture.releases).href },
        input,
        encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
}

const refs = (repo: string, ...patterns: string[]) =>
    git(repo, "for-each-ref", "--format=%(objectname) %(refname)", ...patterns);
const removedInHistory = (repo: string) =>
    git(repo, "log", "--branches", "--tags", "--format=", "--name-only", "--", "*.wasm", "*-wasm.js");

describe.skipIf(!hasFilterRepo)("scripts/rewrite-history.sh", () => {
    let fixture: Fixture;
    beforeEach(() => {
        fixture = makeFixture();
    });
    afterEach(() => {
        rmSync(fixture.dir, { recursive: true, force: true });
    });

    test(
        "rewrites a mirror clone without the binaries and pushes nothing",
        () => {
            const before = refs(fixture.remote);
            const developTree = git(fixture.remote, "rev-parse", "develop^{tree}");
            const work = join(fixture.dir, "run");

            const { status, output } = rewrite(fixture, ["--workdir", work]);

            expect(status).toBe(0);
            const mirror = join(work, "repo.git");
            expect(git(mirror, "log", "--all", "--oneline", "--", "*.wasm")).toBe("");
            expect(removedInHistory(mirror)).toBe("");
            expect(git(mirror, "log", "--all", "--format=", "--name-only", "--", "*.d.ts")).toContain(
                "packages/wasm/lib/spicy-wasm.d.ts",
            );
            expect(git(mirror, "rev-parse", "develop^{tree}")).toBe(developTree);
            expect(git(mirror, "rev-parse", "main^{tree}")).toBe(developTree);
            expect(git(mirror, "for-each-ref", "--format=%(refname)", "refs/pull")).toBe("");
            // The commit that only rebuilt the kernel is gone; the others are mapped.
            const map = readFileSync(join(work, "commit-map"), "utf8").trim().split("\n").slice(1);
            expect(map).toHaveLength(4);
            expect(map.filter((line) => /^\S+ 0+$/.test(line))).toHaveLength(1);

            const report = readFileSync(join(work, "report.md"), "utf8");
            expect(output).toContain(report.trim());
            expect(report).toContain("Commits: 4, 3 rewritten, 1 pruned");
            expect(report).toMatch(/`develop` keeps its tree/);
            expect(report).toContain("    - `refs/heads/feature/old`");
            expect(report).toContain("    - `refs/tags/0.0.1`");
            expect(report).toContain(`| \`refs/tags/${TAG}\` |`);
            // The way back holds every branch and tag as cloned.
            expect(git(work, "bundle", "list-heads", "before.bundle")).toBe(
                refs(fixture.remote, "refs/heads", "refs/tags"),
            );
            expect(output).toContain("Nothing pushed.");
            expect(refs(fixture.remote)).toBe(before);
        },
        TIMEOUT,
    );

    test(
        "--push --yes replaces every branch and tag and leaves refs/pull alone",
        () => {
            const work = join(fixture.dir, "run");
            const { status, output } = rewrite(fixture, ["--workdir", work, "--push", "--yes"]);

            expect(status).toBe(0);
            expect(output).toContain("Pushed.");
            expect(removedInHistory(fixture.remote)).toBe("");
            expect(git(fixture.remote, "rev-parse", "refs/pull/1/head")).toBe(fixture.oldBranchTip);
            const after = readFileSync(join(work, "refs-after.txt"), "utf8").trim();
            expect(refs(fixture.remote, "refs/heads", "refs/tags")).toBe(after);
        },
        TIMEOUT,
    );

    test(
        "--push asks for the repository URL and pushes nothing without it",
        () => {
            const before = refs(fixture.remote);
            const { status, output } = rewrite(fixture, ["--workdir", "run", "--push"], "yes\n");

            expect(status).toBe(1);
            expect(output).toContain("not confirmed, nothing pushed");
            expect(refs(fixture.remote)).toBe(before);
        },
        TIMEOUT,
    );

    test(
        "refuses a kept branch that still tracks the binary",
        () => {
            const work = join(fixture.dir, "run");
            const { status, output } = rewrite(fixture, ["--workdir", work, "--keep", "feature/old"]);

            expect(status).toBe(1);
            expect(output).toContain("feature/old still tracks packages/wasm/lib/spicy-wasm.js");
            expect(existsSync(join(work, "commit-map"))).toBe(false);
        },
        TIMEOUT,
    );

    test.each([
        [
            "is missing",
            () => rmSync(join(fixture.releases, TAG, "spicy-wasm.wasm")),
            `has no asset spicy-wasm.wasm`,
        ],
        [
            "is another build",
            () => writeFileSync(join(fixture.releases, TAG, "spicy-wasm.wasm"), "\0asm other"),
            "are not the files pinned on develop",
        ],
    ])(
        "refuses to rewrite when the pinned release asset %s",
        (_case, breakRelease, message) => {
            breakRelease();
            const work = join(fixture.dir, "run");

            const { status, output } = rewrite(fixture, ["--workdir", work]);

            expect(status).toBe(1);
            expect(output).toContain(message);
            expect(existsSync(join(work, "commit-map"))).toBe(false);
        },
        TIMEOUT,
    );

    test("refuses a work folder that is not empty", () => {
        write(fixture.dir, "run/leftover", "");

        const { status, output } = rewrite(fixture, ["--workdir", join(fixture.dir, "run")]);

        expect(status).toBe(1);
        expect(output).toContain("is not empty");
    });
});
