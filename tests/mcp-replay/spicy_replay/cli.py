# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""Command line: ``python -m spicy_replay run|validate|standin``.

    SPICY3D_REPLAY_URL=https://spicy.test SPICY3D_REPLAY_EMAIL=… SPICY3D_REPLAY_PASSWORD=… \\
        python -m spicy_replay run scenarios/*.json

Exit codes: 0 every scenario passed, 1 a step failed, 2 an invalid scenario or usage, 3 the
environment could not be set up (sign-in, tab, pairing, starting state) — nothing was replayed.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import logging
import os
import platform
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .browser import BrowserOptions, SetupError, start_browser
from .runner import Runner, RunResult, StepReport, missing_tools
from .scenario import Scenario, ScenarioError, load_scenario
from .session import SdkCaller, SetupFailure, check_initial_state, connect, select_tab

EXIT_PASSED, EXIT_FAILED, EXIT_INVALID, EXIT_SETUP = 0, 1, 2, 3
TAB_TIMEOUT_S = 90
PAIRING_TIMEOUT_S = 60


def _versions() -> dict[str, str]:
    found = {"python": platform.python_version()}
    for package in ("mcp", "playwright"):
        try:
            found[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            found[package] = "?"
    return found


def _git_revision() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=Path(__file__).parent,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _describe(error: BaseException) -> str:
    """The leaf errors of an exception group (anyio task groups wrap the SDK's failures)."""
    if isinstance(error, BaseExceptionGroup):
        return "; ".join(_describe(e) for e in error.exceptions)
    return f"{type(error).__name__}: {error}"


def _leaves(error: BaseException) -> str:
    if isinstance(error, BaseExceptionGroup):
        return "; ".join(_leaves(e) for e in error.exceptions)
    return str(error)


def _print_step(report: StepReport) -> None:
    mark = {"passed": "ok  ", "failed": "FAIL", "skipped": "skip"}[report.status]
    polls = f", {report.polls} polls" if report.polls else ""
    print(f"  {mark} {report.id} ({report.tool}) {report.seconds:.2f}s{polls}", flush=True)
    if report.failure:
        print(f"       {report.failure.kind}: {report.failure.message}", flush=True)
        print(f"       arguments: {json.dumps(report.arguments)[:2000]}", flush=True)


async def run_scenario(scenario: Scenario, args: argparse.Namespace, run_dir: Path) -> int:
    run_id = uuid.uuid4().hex[:10]
    out = run_dir / scenario.name
    out.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "scenario": scenario.name,
        "scenarioFile": str(scenario.path) if scenario.path else None,
        "scenarioSha256": hashlib.sha256(scenario.path.read_bytes()).hexdigest() if scenario.path else None,
        "runId": run_id,
        "startedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {"runner": {**_versions(), "revision": _git_revision()}, "url": args.url},
        "status": "setup-failed",
    }
    print(f"{scenario.name}:", flush=True)
    options = BrowserOptions(
        url=args.url.rstrip("/"),
        email=args.email,
        password=args.password,
        run_id=run_id,
        headless=not args.headed,
        ignore_https_errors=args.ignore_https_errors,
    )
    browser = None
    code = EXIT_SETUP
    result: RunResult | None = None
    try:
        browser = await start_browser(options)
        config = await (await browser.context.request.get(f"{options.url}/api/config")).json()
        report["environment"]["server"] = {
            "version": config.get("version"),
            "apiVersion": config.get("apiVersion"),
        }
        endpoint = (config.get("mcp") or {}).get("endpoint")
        if not endpoint:
            raise SetupFailure("the server's /api/config has no MCP endpoint (features.mcp off?)")
        document = await browser.open_document(scenario.document, scenario.directory)
        report["document"] = {
            "kind": scenario.document.kind,
            "path": scenario.document.path or None,
            "id": document.id,
        }
        read_timeout = max(s.timeout_s for s in scenario.steps) + 60
        async with connect(endpoint, browser.token, read_timeout) as (session, server_info):
            caller = SdkCaller(session)
            report["environment"]["mcpServer"] = server_info
            tools = await caller.list_tools()
            tab = await select_tab(caller, tools, options.device_name, document.id, TAB_TIMEOUT_S)
            report["tab"] = {k: v for k, v in tab.items() if k != "documentName"}
            # The tab's own tool list (the first listing may have come before the tab was chosen).
            tools = await caller.list_tools()
            if missing := missing_tools(scenario, tools):
                raise SetupFailure(f"the tab does not offer {', '.join(missing)}")
            browser.watch_pairing()
            initial = await check_initial_state(
                caller, document.name, scenario.document.kind == "empty", PAIRING_TIMEOUT_S
            )
            report["initialState"] = {"nodeCount": initial.get("nodeCount")}
            report["environment"].update(await browser.environment())
            result = await Runner(caller, scenario, on_step=_print_step).run()
        report["steps"] = [s.as_dict() for s in result.steps]
        report["status"] = "passed" if result.passed else "failed"
        code = EXIT_PASSED if result.passed else EXIT_FAILED
        if first := result.first_failure:
            report["firstFailure"] = {
                "step": first.id,
                "kind": first.failure.kind,
                "message": first.failure.message,
            }
    except* (SetupError, SetupFailure) as group:
        report["setupError"] = _leaves(group)
        print(f"  SETUP FAILED: {report['setupError']}", flush=True)
    except* Exception as group:  # the run broke down: still a report, still artifacts
        report["setupError"] = _describe(group)
        print(f"  ERROR: {report['setupError']}", flush=True)
        if result is not None:
            report["steps"] = [s.as_dict() for s in result.steps]
    finally:
        if browser is not None:
            if code != EXIT_PASSED or args.artifacts == "always":
                report["artifacts"] = await browser.capture_artifacts(out)
            await browser.close()
        report["finishedAt"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"  {report['status']} → {out / 'report.json'}", flush=True)
    return code


async def run_all(scenarios: list[Scenario], args: argparse.Namespace) -> int:
    run_dir = Path(args.report_dir) / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    codes = []
    for repetition in range(args.repeat):
        if args.repeat > 1:
            print(f"--- repetition {repetition + 1}/{args.repeat}", flush=True)
        target = run_dir / f"r{repetition + 1}" if args.repeat > 1 else run_dir
        for scenario in scenarios:
            started = time.monotonic()
            codes.append(await run_scenario(scenario, args, target))
            logging.getLogger("spicy_replay").debug(
                "%s took %.1fs", scenario.name, time.monotonic() - started
            )
    if EXIT_SETUP in codes:
        return EXIT_SETUP
    return EXIT_FAILED if EXIT_FAILED in codes else EXIT_PASSED


def _load_all(paths: list[str]) -> list[Scenario]:
    scenarios, problems = [], []
    for path in paths:
        try:
            scenarios.append(load_scenario(Path(path)))
        except ScenarioError as error:
            problems.append(f"{path}:\n  " + "\n  ".join(error.problems))
    if problems:
        print("\n".join(problems), file=sys.stderr)
        raise SystemExit(EXIT_INVALID)
    names = [s.name for s in scenarios]
    if len(set(names)) != len(names):
        print("two scenarios share a name (their reports would overwrite each other)", file=sys.stderr)
        raise SystemExit(EXIT_INVALID)
    return scenarios


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m spicy_replay", description="Replay MCP scenarios against Spicy3D."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="replay scenarios through SpicySrv and a real browser")
    run.add_argument("scenarios", nargs="+")
    run.add_argument(
        "--url", default=os.environ.get("SPICY3D_REPLAY_URL"), help="deployment (env SPICY3D_REPLAY_URL)"
    )
    run.add_argument("--report-dir", default=os.environ.get("SPICY3D_REPLAY_REPORTS", "reports"))
    run.add_argument(
        "--repeat", type=int, default=1, help="run every scenario this many times, each from fresh state"
    )
    run.add_argument("--headed", action="store_true")
    run.add_argument("--artifacts", choices=("failure", "always"), default="failure")
    run.add_argument(
        "--ignore-https-errors", action="store_true", help="a test deployment with an internal CA"
    )
    run.add_argument("-v", "--verbose", action="store_true")
    validate = commands.add_parser("validate", help="check scenarios without running them")
    validate.add_argument("scenarios", nargs="+")
    commands.add_parser(
        "standin", help="local stand-in relay for developing the runner (not SpicySrv)", add_help=False
    )
    args, rest = parser.parse_known_args(argv)

    if args.command == "standin":
        from .standin import main as standin_main

        return standin_main(rest)
    if rest:
        parser.error(f"unrecognized arguments: {' '.join(rest)}")
    scenarios = _load_all(args.scenarios)
    if args.command == "validate":
        for scenario in scenarios:
            print(f"{scenario.name}: {len(scenario.steps)} steps, tools {', '.join(scenario.required_tools)}")
        return EXIT_PASSED
    args.email = os.environ.get("SPICY3D_REPLAY_EMAIL")
    args.password = os.environ.get("SPICY3D_REPLAY_PASSWORD")
    if not args.url or not args.email or not args.password:
        parser.error("set SPICY3D_REPLAY_URL (or --url), SPICY3D_REPLAY_EMAIL and SPICY3D_REPLAY_PASSWORD")
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING, format="%(name)s: %(message)s"
    )
    return asyncio.run(run_all(scenarios, args))
