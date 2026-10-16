# Rewriting history without the old WebAssembly kernels

Since #191 the kernel (`packages/wasm/lib/spicy-wasm.{wasm,js}`) is a GitHub release pinned by
`packages/wasm/wasm.lock.json` and no longer committed. Its old versions still sit in the history:
about 180 blobs of `spicy-wasm.wasm`, `chili-wasm.wasm`, `chili_occ.wasm` and `garlic_bg.wasm`,
two thirds of every clone (measured 2026-10-16 on a mirror clone: 330 MiB pack as cloned, 287 MiB
reachable from branches and tags, 86 MiB after the rewrite). `scripts/rewrite-history.sh` (#192)
removes them from every branch and tag. This page is the runbook around it.

What leaves the history: every `*.wasm` file, and the Emscripten glue committed next to the kernels
(`packages/wasm/lib/spicy-wasm.js`, `packages/wasm/lib/chili-wasm.js`,
`packages/chili-wasm/lib/chili-wasm.js`, `packages/chili-occ/occ-wasm/chili_occ.js`). The `.d.ts`
files stay: the lock pins `spicy-wasm.d.ts` and the type check needs it without a download.

What does not change: the trees of `develop` and `main` (the script checks they are the same,
object for object, so the build and the deployment are exactly what they were), the GitHub
releases and their assets, the ghcr images.

## The script

```bash
pip install git-filter-repo==2.47.0       # or: pipx install / brew install git-filter-repo
scripts/rewrite-history.sh --workdir ~/spicy3d-rewrite [--check-build] [--push]
```

1. Mirror-clones the repository (`--repo`, default GitHub) into `<workdir>/repo.git`; drops
   `refs/pull/*` from the clone, since nobody can push them.
2. On every `--keep` branch (default `develop` and `main`): refuses if it still tracks a removed
   file or has no `wasm.lock.json` (#191 not merged there yet), downloads the release assets its
   lock pins and runs that branch's `node scripts/wasm-artifact.mjs verify` on them, so the kernel
   in use can never be lost with the history.
3. Bundles every branch and tag as cloned (`<workdir>/before.bundle`), then runs
   `git filter-repo --paths-from-file … --invert-paths` over all branches and tags, the release tags
   `0.0.x` and `wasm-*` included.
4. Checks that `git log --all -- '*.wasm'` is empty and that every `--keep` branch kept its tree,
   then prints the report (also in `<workdir>/report.md`): sizes before and after, commits rewritten
   and pruned (commits that only rebuilt the kernel disappear), refs whose tip lost a file, and the
   old → new commit of every branch and tag. The full map is `<workdir>/commit-map` (filter-repo's
   `old new` per line).
5. `--check-build`: `npm ci`, `npm run build`, `npm run test` and `npm run smoke` on the rewritten
   `develop` (logs in `<workdir>/check-*.log`).
6. Stops, unless `--push`: then it asks for the repository URL (`--yes` skips that) and pushes every
   branch and tag in one atomic push, each with a lease on the commit it had when cloned. If anybody
   pushed in between, the whole push is refused and nothing changes: run it again from a new
   `--workdir`.

Without `--push` the script only reads the remote, so a dry run is always safe. Each run needs an
empty `--workdir` and about 1 GB of disk (more with `--check-build`); keep it off a small `/tmp`.

## Before

- #191 is merged into `develop` **and** `main`: the script refuses otherwise.
- The release of the lock exists (`gh release view wasm-<…>`); the script checks it again.
- A dry run with the report attached to #192:
  `scripts/rewrite-history.sh --workdir ~/spicy3d-dry-run --check-build`.
- Announce a window; nothing else of the repository moves during it.

## The day

1. **Freeze merges.** Stop the board from moving tickets to Done and merging pull requests, and
   ask everyone to push what they want kept now (anything pushed after the clone makes the push
   fail, by design; anything only local must be rebased afterwards, see below).
2. **Note the open pull requests and branches**: `gh pr list --state open --json number,headRefName,baseRefName`.
3. **Let the push through**: the rules that protect `develop`, `main` and the tags (Settings >
   Branches / Rules) must allow a force push by you for the window. Note what you change.
4. **Run the one command** (fresh clone, checks, rewrite, report, build check, push):

   ```bash
   scripts/rewrite-history.sh --workdir ~/spicy3d-rewrite-$(date +%F) --check-build --push
   ```

   Read the report before typing the URL. Keep the work folder: `commit-map`, `report.md` and
   `before.bundle` are needed afterwards. Attach `report.md` and `commit-map` to #192.
5. **Restore the protection rules** exactly as noted in step 3.
6. **Check**: `git clone https://github.com/Lenny32/spicy3d.git` is small (≈ 90 MiB) and
   `git log --all -- '*.wasm'` is empty in it; `gh release list` still shows every release with its
   assets; run Deploy once (or wait for the next one) and see it pick the next version.

## After

- **Open pull requests and branches on GitHub** were rewritten with everything else, so a pull
  request between two pushed branches keeps working; check that its diff is the same size as
  before. A pull request from a fork, or one whose diff suddenly shows hundreds of commits, is based
  on the old history: close it, or rebase its branch (next point) and push it again.
- **Local work** (unpushed commits, the board's ticket branches that never reached GitHub): in the
  old clone, fetch the new history and move the commits onto the rewritten base:

  ```bash
  git fetch --force origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
  old_base=$(git merge-base my-branch <old develop SHA>)
  new_base=$(awk -v c="$old_base" '$1 == c { print $2 }' ~/spicy3d-rewrite-…/commit-map)
  git rebase --onto "$new_base" "$old_base" my-branch
  ```

  If `new_base` is `0000…`, the commit was pruned (it only rebuilt the kernel): use its parent.
- **Re-clone every workspace**, the board's ticket clones and developer machines included, and
  delete the old ones. Never pull or push from an old clone: a push from one brings
  the old commits, and with them every binary, back. A pull request with hundreds of commits is the
  sign.
- **Pull request refs** (`refs/pull/*`) cannot be rewritten: GitHub keeps them, so old pull
  requests still show their old commits, and those commits keep the old blobs alive on GitHub's
  side. Clones do not fetch them, so every new clone is small at once. To purge the cached views and
  the stored size, ask GitHub Support to run a garbage collection on the repository and name the
  old SHAs (`commit-map`).
- **Releases and tags**: the tags `0.0.x` and `wasm-*` are lightweight tags that the push moved to
  the rewritten commits. A GitHub release belongs to its tag name, so every release, its notes and
  its assets (the kernels) stay. The deploy workflow's "last release tag + 1 patch" reads tag names
  only, so the next deploy still takes the next number. The old release tags no longer build from
  source (their commits had no lock and lose their kernel): an old version is reproduced from its
  ghcr image.
- **ghcr images** are untouched. Their `org.opencontainers.image.revision` label names the old
  commit: translate it with `commit-map`.
- **The kernel workflow** (`wasm.yml`) only publishes from the committed files (`seed`) while no
  release exists for the inputs. After the rewrite no tree holds them any more: a kernel whose
  release is missing is rebuilt, never taken from `develop`.
- **Signed commits**: filter-repo drops commit signatures, so the merge commits GitHub signed lose
  their "Verified" badge.
- **Old SHAs** in issues, tickets, the knowledge base and commit messages: filter-repo rewrites the
  abbreviated hashes it finds in commit messages; elsewhere, look them up in `commit-map`.

## Rollback

Until the old clones are gone, the old history is recoverable: `<workdir>/before.bundle` holds every
branch and tag as they were cloned.

```bash
git clone --mirror ~/spicy3d-rewrite-…/before.bundle restore.git
cd restore.git
git push --force https://github.com/Lenny32/spicy3d.git 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
```

(with the protection rules opened as in step 3, and every workspace re-cloned once more).
