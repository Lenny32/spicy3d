#!/usr/bin/env bash
# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.
#
# One command for MCP replay scenarios (README.md): prepares the pinned Python environment and
# Chromium, then runs `python -m spicy_replay run`.
#
#   SPICY3D_REPLAY_URL=https://spicy.test SPICY3D_REPLAY_EMAIL=… SPICY3D_REPLAY_PASSWORD=… \
#       tests/mcp-replay/run.sh tests/mcp-replay/scenarios/*.json
#
#   tests/mcp-replay/run.sh --standin tests/mcp-replay/scenarios/*.json
#       against the local stand-in relay serving ./dist (npm run build first) — for developing the
#       runner and scenarios without a SpicySrv; results there are not an acceptance of SpicySrv.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$here/.venv"
python="$venv/bin/python"

if [ ! -x "$python" ] || ! cmp -s "$here/requirements.txt" "$venv/.requirements.txt"; then
    echo "mcp-replay: preparing $venv" >&2
    if command -v uv >/dev/null 2>&1; then
        uv venv -q --allow-existing "$venv" -p 3.12
        uv pip install -q -p "$python" --require-hashes -r "$here/requirements.txt"
    else
        python3 -m venv "$venv"
        "$python" -m pip install -q --require-hashes -r "$here/requirements.txt"
    fi
    cp "$here/requirements.txt" "$venv/.requirements.txt"
fi
"$python" -m playwright install --only-shell chromium >/dev/null

export PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}"
export SPICY3D_REPLAY_REPORTS="${SPICY3D_REPLAY_REPORTS:-$here/reports}"

if [ "${1:-}" = "--standin" ]; then
    shift
    port="${SPICY3D_STANDIN_PORT:-8765}"
    dist="${SPICY3D_STANDIN_DIST:-$here/../../dist}"
    "$python" -m spicy_replay standin --dist "$dist" --port "$port" &
    standin=$!
    trap 'kill "$standin" 2>/dev/null || true' EXIT
    for _ in $(seq 1 50); do
        curl -fsS "http://127.0.0.1:$port/api/config" >/dev/null 2>&1 && break
        kill -0 "$standin" 2>/dev/null || { echo "mcp-replay: the stand-in relay did not start" >&2; exit 3; }
        sleep 0.2
    done
    export SPICY3D_REPLAY_URL="http://127.0.0.1:$port"
    export SPICY3D_REPLAY_EMAIL="replay@standin.test" SPICY3D_REPLAY_PASSWORD="standin-password"
fi

"$python" -m spicy_replay run "$@"
