#!/usr/bin/env bash
# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.
#
# Rewrites the repository's history without the old WebAssembly kernels (#192, follow-up to #191):
# every `*.wasm` blob (packages/wasm/lib/spicy-wasm.wasm, the chili-wasm/chili_occ binaries before it,
# the old garlic_bg.wasm) and the Emscripten glue committed next to them. The `.d.ts` files stay:
# `packages/wasm/wasm.lock.json` pins spicy-wasm.d.ts. Runbook: docs/history-rewrite.md.
#
#   scripts/rewrite-history.sh [--repo <url>] [--workdir <dir>] [--keep <branch>]... [--check-build]
#                              [--push [--yes]]
#
#   1. mirror-clones --repo (default the GitHub repository) into <workdir>/repo.git;
#   2. checks, on every --keep branch (default develop and main), that the binary is no longer
#      tracked and that the release assets pinned by its wasm.lock.json exist and are the pinned
#      files (`node scripts/wasm-artifact.mjs verify`), so the current kernel is never lost;
#   3. bundles every branch and tag as they were (<workdir>/before.bundle, the way back), then runs
#      git filter-repo over every branch and tag (release tags X.Y.Z and wasm-* included);
#      refs/pull/* and other refs GitHub does not let anyone push are dropped from the clone;
#   4. checks that no ref reaches a removed path and that every --keep branch keeps its exact tree,
#      then prints the before/after size and the old -> new commit of every ref (the full commit map
#      is <workdir>/commit-map, from filter-repo); <workdir>/report.md holds the same;
#   5. with --check-build: npm ci, build, test and smoke on the rewritten develop;
#   6. stops there unless --push: then, after typing the repository URL (or --yes), force-pushes
#      every branch and tag at once (--atomic), each with a lease on the commit it had when cloned,
#      so a push that landed in between makes the whole push fail and nothing changes.
#
# Needs git >= 2.36, git-filter-repo (pip install git-filter-repo==2.47.0), node and curl.
# SPICY3D_WASM_BASE_URL (a mirror holding <tag>/<file>, as for scripts/fetch-wasm.mjs) replaces the
# release download URL of step 2.
set -euo pipefail

REPO="https://github.com/Lenny32/spicy3d.git"
WORKDIR="spicy3d-history-rewrite"
KEEP=()
CHECK_BUILD=0
PUSH=0
YES=0

usage() {
    sed -n '/^#   scripts\/rewrite-history.sh/,/^#                              \[--push/p' "$0" | sed 's/^# \{0,1\}//'
    echo "See the header of $0 and docs/history-rewrite.md."
}

die() {
    echo "rewrite-history: $*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO="${2:?--repo needs a URL}"; shift 2 ;;
        --workdir) WORKDIR="${2:?--workdir needs a folder}"; shift 2 ;;
        --keep) KEEP+=("${2:?--keep needs a branch}"); shift 2 ;;
        --check-build) CHECK_BUILD=1; shift ;;
        --push) PUSH=1; shift ;;
        --yes) YES=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; die "unknown option $1" ;;
    esac
done
[[ ${#KEEP[@]} -gt 0 ]] || KEEP=(develop main)

# What leaves the history: every WebAssembly binary and the Emscripten glue of the kernels (useless
# without their binary). filter-repo's --paths-from-file syntax: `glob:` patterns, else exact paths.
REMOVED_PATHS="glob:*.wasm
packages/wasm/lib/spicy-wasm.js
packages/wasm/lib/chili-wasm.js
packages/chili-wasm/lib/chili-wasm.js
packages/chili-occ/occ-wasm/chili_occ.js"

# The same set as a grep -E pattern over `git ls-tree`/`git log --name-only` paths.
REMOVED_REGEX='\.wasm$|^packages/wasm/lib/(spicy|chili)-wasm\.js$|^packages/chili-wasm/lib/chili-wasm\.js$|^packages/chili-occ/occ-wasm/chili_occ\.js$'

# ---- prerequisites -------------------------------------------------------------------------------

for tool in git node curl; do
    command -v "$tool" > /dev/null || die "$tool is required"
done
git filter-repo --version > /dev/null 2>&1 ||
    die "git-filter-repo is required (pip install git-filter-repo==2.47.0, or your package manager)"
if [[ -e "$WORKDIR" ]] && [[ -n "$(ls -A "$WORKDIR")" ]]; then
    die "$WORKDIR is not empty: give a new --workdir (filter-repo needs a fresh clone)"
fi
mkdir -p "$WORKDIR"
WORKDIR="$(cd "$WORKDIR" && pwd)"
MIRROR="$WORKDIR/repo.git"
g() { git -C "$MIRROR" "$@"; }

human() { # bytes -> MiB
    awk -v b="$1" 'BEGIN { printf "%.1f MiB", b / 1048576 }'
}
pack_size() { # bytes of the packs, as stored
    g count-objects -v | awk '/^size-pack:/ { s += $2 } /^size:/ { s += $2 } END { print s * 1024 }'
}
reachable_size() { # bytes on disk of the objects reachable from branches and tags
    g rev-list --objects --branches --tags --disk-usage
}
removed_in_history() { # paths of removed files any branch or tag still reaches
    g log --branches --tags --format= --name-only | grep -E "$REMOVED_REGEX" | sort -u || true
}

# ---- 1. mirror clone -----------------------------------------------------------------------------

echo "== 1. Mirror clone of $REPO into $MIRROR"
git clone --quiet --mirror "$REPO" "$MIRROR"
g for-each-ref --format='%(objectname) %(refname)' > "$WORKDIR/refs-before.txt"
SIZE_CLONED=$(pack_size)

# refs/pull/* (and anything else outside branches and tags) cannot be pushed back: drop them so
# they neither keep the old blobs in the clone nor end up in the push.
g for-each-ref --format='%(refname)' | grep -vE '^refs/(heads|tags)/' > "$WORKDIR/refs-dropped.txt" || true
while read -r ref; do
    g update-ref -d "$ref"
done < "$WORKDIR/refs-dropped.txt"
g for-each-ref --format='%(objectname) %(refname)' 'refs/heads/' 'refs/tags/' > "$WORKDIR/refs-kept-before.txt"
while read -r _ ref; do
    echo "$(g rev-parse "$ref^{tree}") $ref"
done < "$WORKDIR/refs-kept-before.txt" > "$WORKDIR/trees-before.txt"
SIZE_BEFORE=$(reachable_size)
BLOBS_BEFORE=$(g rev-list --objects --branches --tags | awk 'NF > 1 { $1 = ""; print substr($0, 2) }' |
    grep -cE "$REMOVED_REGEX" || true)
echo "   $(wc -l < "$WORKDIR/refs-kept-before.txt" | tr -d ' ') branches and tags kept," \
    "$(wc -l < "$WORKDIR/refs-dropped.txt" | tr -d ' ') other refs dropped (refs/pull/*)"

# ---- 2. the pinned kernel exists as a release ----------------------------------------------------

echo "== 2. The kernel pinned on ${KEEP[*]} is a release asset"
declare -a KEEP_TREES=()
for branch in "${KEEP[@]}"; do
    g rev-parse -q --verify "refs/heads/$branch^{commit}" > /dev/null || die "no branch $branch in $REPO"
    tracked=$(g ls-tree -r --name-only "refs/heads/$branch" | grep -E "$REMOVED_REGEX" || true)
    [[ -z "$tracked" ]] ||
        die "$branch still tracks $(echo "$tracked" | tr '\n' ' ')- merge #191 into $branch first"
    g cat-file -e "refs/heads/$branch:packages/wasm/wasm.lock.json" 2> /dev/null ||
        die "$branch has no packages/wasm/wasm.lock.json - merge #191 into $branch first"

    check="$WORKDIR/check/$branch"
    mkdir -p "$check/tree" "$check/assets"
    g archive "refs/heads/$branch" scripts/wasm-artifact.mjs packages/wasm/wasm.lock.json |
        tar -x -C "$check/tree"
    # Prints "<tag> <url>" then one file name per line; readLock refuses a malformed lock. The
    # leading "lock" keeps argv[1] off the script, whose CLI runs when argv[1] is itself.
    # shellcheck disable=SC2016 # JavaScript, not shell
    node --input-type=module -e '
        import { pathToFileURL } from "node:url";
        const [script, lockFile] = process.argv.slice(2);
        const { readLock } = await import(pathToFileURL(script).href);
        const lock = readLock(lockFile);
        console.log(`${lock.tag} ${lock.url}`);
        for (const name of Object.keys(lock.files)) console.log(name);
    ' lock "$check/tree/scripts/wasm-artifact.mjs" "$check/tree/packages/wasm/wasm.lock.json" > "$check/lock.txt"
    read -r tag url < "$check/lock.txt"
    base="${SPICY3D_WASM_BASE_URL:+${SPICY3D_WASM_BASE_URL%/}/$tag}"
    base="${base:-$url}"
    while read -r name; do
        case "$name" in */* | .* | "") die "unexpected file name '$name' in the lock of $branch" ;; esac
        curl -fsSL --retry 3 -o "$check/assets/$name" "$base/$name" ||
            die "release $tag has no asset $name ($base/$name): publish it before rewriting"
    done < <(tail -n +2 "$check/lock.txt")
    node "$check/tree/scripts/wasm-artifact.mjs" verify --dir "$check/assets" --root "$check/tree" ||
        die "the assets of release $tag are not the files pinned on $branch"
    KEEP_TREES+=("$branch $(g rev-parse "refs/heads/$branch^{tree}")")
done

# ---- 3. filter-repo ------------------------------------------------------------------------------

echo "== 3. git filter-repo over every branch and tag"
# The way back: every branch and tag as cloned (docs/history-rewrite.md, "Rollback").
g bundle create --quiet "$WORKDIR/before.bundle" --branches --tags
printf '%s\n' "$REMOVED_PATHS" > "$WORKDIR/removed-paths.txt"
# Its note about branches "outside the refs/remotes/ hierarchy" is the mirror's own branches: noise.
g filter-repo --paths-from-file "$WORKDIR/removed-paths.txt" --invert-paths --quiet > "$WORKDIR/filter-repo.log" 2>&1 ||
    { cat "$WORKDIR/filter-repo.log" >&2; die "git filter-repo failed"; }
g reflog expire --expire=now --all
g gc --prune=now --quiet
cp "$MIRROR/filter-repo/commit-map" "$WORKDIR/commit-map"
g for-each-ref --format='%(objectname) %(refname)' 'refs/heads/' 'refs/tags/' > "$WORKDIR/refs-after.txt"

# ---- 4. checks and report ------------------------------------------------------------------------

echo "== 4. Checks"
left=$(removed_in_history)
[[ -z "$left" ]] || die "history still reaches: $left"
wasm_log=$(g log --all --oneline -- '*.wasm')
[[ -z "$wasm_log" ]] || die "git log --all -- '*.wasm' is not empty"
for entry in "${KEEP_TREES[@]}"; do
    read -r branch tree <<< "$entry"
    after=$(g rev-parse "refs/heads/$branch^{tree}")
    [[ "$after" == "$tree" ]] || die "the tree of $branch changed ($tree -> $after)"
    echo "   $branch: same tree $tree"
done
echo "   git log --all -- '*.wasm': empty"

SIZE_AFTER=$(reachable_size)
SIZE_PACK_AFTER=$(pack_size)
COMMITS=$(($(wc -l < "$WORKDIR/commit-map") - 1))
PRUNED=$(awk 'NR > 1 && $2 ~ /^0+$/' "$WORKDIR/commit-map" | wc -l | tr -d ' ')
CHANGED=$(awk 'NR > 1 && $1 != $2 && $2 !~ /^0+$/' "$WORKDIR/commit-map" | wc -l | tr -d ' ')

# Refs whose tip tree changed: their tip still had a removed file (branches from before #191, the
# old release tags). They no longer build as they are; branches get rebased on the new develop.
CHANGED_TIPS=$(while read -r _ ref; do
    [[ "$(awk -v r="$ref" '$2 == r { print $1 }' "$WORKDIR/trees-before.txt")" == "$(g rev-parse "$ref^{tree}")" ]] ||
        echo "$ref"
done < "$WORKDIR/refs-after.txt")

# old -> new per ref (a ref missing after = all its commits were pruned)
REF_TABLE=$(awk '
    FNR == NR { after[$2] = $1; next }
    { new = ($2 in after) ? after[$2] : "(deleted)"; printf "| `%s` | `%s` | `%s` |\n", $2, substr($1, 1, 12), substr(new, 1, 12) }
' "$WORKDIR/refs-after.txt" "$WORKDIR/refs-kept-before.txt")

{
    echo "# History rewrite report"
    echo
    echo "- Repository: $REPO"
    echo "- Date: $(date -u '+%Y-%m-%d %H:%M UTC'), git-filter-repo $(git filter-repo --version)"
    echo "- Pack as cloned (refs/pull/* included): $(human "$SIZE_CLONED")"
    echo "- Branches and tags, before: $(human "$SIZE_BEFORE") ($BLOBS_BEFORE blobs of removed paths)"
    echo "- Branches and tags, after: $(human "$SIZE_AFTER"); pack after gc: $(human "$SIZE_PACK_AFTER")"
    echo "- Commits: $COMMITS, $CHANGED rewritten, $PRUNED pruned (they only touched removed files)"
    echo "- Dropped refs (not pushable, left untouched on GitHub): $(wc -l < "$WORKDIR/refs-dropped.txt" | tr -d ' ')"
    echo "- \`git log --all -- '*.wasm'\`: empty"
    for entry in "${KEEP_TREES[@]}"; do
        read -r branch tree <<< "$entry"
        echo "- \`$branch\` keeps its tree \`$tree\`"
    done
    echo "- Refs whose tip lost a removed file (no kernel at their tip any more):" \
        "$(echo "$CHANGED_TIPS" | grep -c . || true)"
    # shellcheck disable=SC2016 # literal backquotes
    echo "$CHANGED_TIPS" | grep . | sed 's/^/    - `/; s/$/`/' || true
    echo
    echo "Removed paths (\`git filter-repo --paths-from-file … --invert-paths\`):"
    echo
    echo '```'
    printf '%s\n' "$REMOVED_PATHS"
    echo '```'
    echo
    echo "| Ref | Old | New |"
    echo "| --- | --- | --- |"
    echo "$REF_TABLE"
    echo
    echo "Full old -> new commit map: \`$WORKDIR/commit-map\` (filter-repo's, one \"old new\" per line)."
} > "$WORKDIR/report.md"
cat "$WORKDIR/report.md"

# ---- 5. build check ------------------------------------------------------------------------------

if [[ $CHECK_BUILD -eq 1 ]]; then
    echo "== 5. npm ci, build, test and smoke on the rewritten develop"
    rm -rf "$WORKDIR/develop"
    git clone --quiet --branch develop "$MIRROR" "$WORKDIR/develop"
    (
        cd "$WORKDIR/develop"
        for step in "npm ci" "npm run build" "npm run test" "npx playwright install chromium-headless-shell" \
            "npm run smoke"; do
            log="$WORKDIR/check-$(echo "$step" | awk '{ print $NF }').log"
            echo "   $step (log: $log)"
            # The smoke test is offline (other origins blocked); an HTTP proxy would serve its
            # spicy.lan host itself.
            run=(env)
            [[ "$step" != "npm run smoke" ]] || run+=(-u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy)
            # shellcheck disable=SC2086 # the step's words
            "${run[@]}" $step > "$log" 2>&1 || die "$step failed on the rewritten develop, see $log"
        done
    )
    echo "   all passed" | tee -a "$WORKDIR/report.md"
fi

# ---- 6. push -------------------------------------------------------------------------------------

LEASES=()
REFSPECS=()
while read -r _ ref; do
    old=$(awk -v r="$ref" '$2 == r { print $1 }' "$WORKDIR/refs-kept-before.txt")
    [[ -n "$old" ]] || die "$ref was not in the clone"
    LEASES+=("--force-with-lease=$ref:$old")
    REFSPECS+=("$ref:$ref")
done < "$WORKDIR/refs-after.txt"

if [[ $PUSH -eq 0 ]]; then
    echo
    echo "Nothing pushed. Review $WORKDIR/report.md, then follow docs/history-rewrite.md and run:"
    echo "    scripts/rewrite-history.sh --repo $REPO --workdir <new folder> --push"
    exit 0
fi

echo "== 6. Force-push ${#REFSPECS[@]} branches and tags to $REPO"
if [[ $YES -eq 0 ]]; then
    read -r -p "Type the repository URL ($REPO) to overwrite its history: " answer
    [[ "$answer" == "$REPO" ]] || die "not confirmed, nothing pushed"
fi
g push --atomic --porcelain "${LEASES[@]}" "$REPO" "${REFSPECS[@]}"
remote=$(git ls-remote "$REPO" 'refs/heads/*' 'refs/tags/*' | awk '$2 !~ /\^\{\}$/ { print $1 " " $2 }' | sort)
local_refs=$(sort "$WORKDIR/refs-after.txt")
[[ "$remote" == "$local_refs" ]] || die "the remote's branches and tags differ from the rewritten ones"
echo "Pushed. Every branch and tag of $REPO is the rewritten one; continue with docs/history-rewrite.md."
