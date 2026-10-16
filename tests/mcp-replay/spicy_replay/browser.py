# Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.

"""The browser half of a replay: one fresh Chromium context signed in to the test deployment.

Everything a person would do before an agent connects, without weakening anything:

* signs in with the test account (``POST /api/auth/login`` with the CSRF header, like the app),
* creates a short-lived ``mcp:read``+``mcp:write`` access token for this run (revoked at the end),
* opens the app, waits for the kernel, opens the scenario's starting document,
* clicks **Allow** in the tab's normal pairing prompt — only for this run's token name.

The tab gets a unique device name (``cloud.device`` in localStorage, set before the app starts) so
the runner can pick it out of ``spicy3d_list_tabs`` even when other tabs of the account are open.
Credentials and the token stay in memory; nothing here is written to a report.
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright

from .scenario import DocumentSetup

log = logging.getLogger("spicy_replay.browser")

CSRF_HEADER = {"X-Spicy3D-Request": "1"}
APP_READY = """() => {
    try { return !!globalThis.app && !!globalThis.shapeFactory && !!globalThis.app.mainWindow; }
    catch { return false; }
}"""
PAIRING_DIALOG = "dialog[data-agent-id]"


class SetupError(Exception):
    """The browser could not be brought to the scenario's starting state; nothing was replayed."""


@dataclass
class BrowserOptions:
    url: str
    email: str
    password: str
    run_id: str
    headless: bool = True
    startup_timeout_s: float = 180.0
    ignore_https_errors: bool = False

    @property
    def token_name(self) -> str:
        return f"mcp-replay {self.run_id}"

    @property
    def device_name(self) -> str:
        return f"mcp-replay-{self.run_id}"


@dataclass
class OpenedDocument:
    id: str
    name: str


@dataclass
class BrowserSession:
    options: BrowserOptions
    playwright: Playwright
    browser: Browser
    context: BrowserContext
    page: Page
    token: str
    token_id: str
    console: list[str] = field(default_factory=list)
    approved_agents: list[str] = field(default_factory=list)
    _watch: asyncio.Task | None = None

    # ---- Starting document -----------------------------------------------------------------

    async def open_document(self, setup: DocumentSetup, scenario_dir: Path) -> OpenedDocument:
        """Opens the scenario's starting document as a *device* document (no cloud sync or pulls)."""
        # An empty document gets this run's name; a fixture keeps its own unless the scenario names one.
        name = setup.name or (f"mcp-replay {self.options.run_id}" if setup.kind == "empty" else "")
        data: Any = None
        if setup.kind == "fixture":
            raw = (scenario_dir / setup.path).read_bytes()
            data = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
        result = await self.page.evaluate(
            """async ({ kind, name, data }) => {
                const app = globalThis.app;
                const local = app.repositories.local;
                const document = kind === "empty"
                    ? await app.newDocument(name, local)
                    : await app.loadDocument(data, { repository: local });
                if (!document) throw new Error("the document did not open");
                if (kind !== "empty" && name) document.name = name;
                return { id: document.id, name: document.name };
            }""",
            {"kind": setup.kind, "name": name, "data": data},
        )
        return OpenedDocument(id=result["id"], name=result["name"])

    # ---- Pairing ---------------------------------------------------------------------------

    def watch_pairing(self) -> None:
        """Clicks Allow on pairing prompts naming this run's token; other prompts are left alone."""
        if self._watch is None:
            self._watch = asyncio.create_task(self._pairing_loop())

    async def _pairing_loop(self) -> None:
        while True:
            try:
                dialog = self.page.locator(PAIRING_DIALOG)
                await dialog.first.wait_for(state="visible", timeout=0)
                text = await dialog.first.inner_text()
                agent = await dialog.first.get_attribute("data-agent-id") or "?"
                if self.options.token_name not in text:
                    log.warning("pairing prompt for another token left unanswered: %s", agent)
                    await asyncio.sleep(1)
                    continue
                await dialog.first.get_by_role("button", name="Allow", exact=True).click()
                self.approved_agents.append(agent)
                log.info("allowed MCP session %s", agent)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # the page navigated or the dialog closed meanwhile
                log.debug("pairing watch: %s", error)
                await asyncio.sleep(0.2)

    # ---- Reports ---------------------------------------------------------------------------

    async def environment(self) -> dict[str, Any]:
        """Browser version and the hashes of the kernel binaries the page actually loaded."""
        wasm_urls: list[str] = await self.page.evaluate(
            """() => [...new Set(performance.getEntriesByType("resource")
                    .map((e) => e.name).filter((n) => /\\.wasm(\\?|$)/.test(n)))]"""
        )
        wasm: dict[str, str] = {}
        for url in wasm_urls:
            with contextlib.suppress(Exception):
                body = await (await self.context.request.get(url)).body()
                wasm[url.rsplit("/", 1)[-1]] = hashlib.sha256(body).hexdigest()
        app_info = await self.page.evaluate(
            """() => ({ userAgent: navigator.userAgent, language: navigator.language,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        appName: document.getElementById("appName")?.textContent ?? null })"""
        )
        app_name = app_info.pop("appName", None)
        return {
            "browser": {"name": self.browser.browser_type.name, "version": self.browser.version, **app_info},
            "app": {"version": app_name.rsplit("v", 1)[-1] if app_name else None},
            "wasm": wasm,
            "deviceName": self.options.device_name,
        }

    async def capture_artifacts(self, directory: Path) -> list[str]:
        """Screenshot + console log of the tab; never raises (it must not hide the original failure)."""
        saved: list[str] = []
        with contextlib.suppress(Exception):
            directory.mkdir(parents=True, exist_ok=True)
            await self.page.screenshot(path=directory / "page.png", timeout=10_000)
            saved.append("page.png")
        with contextlib.suppress(Exception):
            (directory / "console.log").write_text("\n".join(self.console), encoding="utf-8")
            saved.append("console.log")
        with contextlib.suppress(Exception):
            snapshot = await self.page.evaluate(
                """async () => {
                    const d = globalThis.app?.activeView?.document;
                    return d ? JSON.stringify(d.serialize()) : null;
                }"""
            )
            if snapshot:
                (directory / "document.json").write_text(snapshot, encoding="utf-8")
                saved.append("document.json")
        return saved

    async def close(self) -> None:
        if self._watch:
            self._watch.cancel()
            with contextlib.suppress(BaseException):
                await self._watch
        with contextlib.suppress(Exception):
            await self.context.request.delete(
                f"{self.options.url}/api/me/tokens/{self.token_id}", headers=CSRF_HEADER
            )
        with contextlib.suppress(Exception):
            await self.context.request.post(f"{self.options.url}/api/auth/logout", headers=CSRF_HEADER)
        with contextlib.suppress(Exception):
            await self.context.close()
        with contextlib.suppress(Exception):
            await self.browser.close()
        with contextlib.suppress(Exception):
            await self.playwright.stop()


def _redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


async def start_browser(options: BrowserOptions) -> BrowserSession:
    """Signs in, creates the run's token and opens the app; raises `SetupError` on any failure."""
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=options.headless)
    context = await browser.new_context(
        ignore_https_errors=options.ignore_https_errors, viewport={"width": 1280, "height": 800}
    )
    url = options.url.rstrip("/")
    token_id: str | None = None
    try:
        device = json.dumps({"deviceName": options.device_name})
        await context.add_init_script(
            f"try {{ localStorage.setItem('spicy3d.app.cloud.device', {json.dumps(device)}); }} catch {{}}"
        )
        login = await context.request.post(
            f"{url}/api/auth/login",
            headers=CSRF_HEADER,
            data={"email": options.email, "password": options.password},
        )
        if not login.ok:
            raise SetupError(f"sign-in failed: HTTP {login.status}")
        created = await context.request.post(
            f"{url}/api/me/tokens",
            headers=CSRF_HEADER,
            data={
                "name": options.token_name,
                "scopes": ["mcp:read", "mcp:write"],
                "expiresInDays": 30,
                "currentPassword": options.password,
            },
        )
        if created.status != 201:
            raise SetupError(f"creating the run's access token failed: HTTP {created.status}")
        token = await created.json()
        token_id = token["id"]
        page = await context.new_page()
        session = BrowserSession(
            options=options,
            playwright=playwright,
            browser=browser,
            context=context,
            page=page,
            token=token["token"],
            token_id=token["id"],
        )
        secrets = [options.password, token["token"]]
        page.on("console", lambda m: session.console.append(_redact(f"[{m.type}] {m.text}", secrets)))
        page.on("pageerror", lambda e: session.console.append(_redact(f"[pageerror] {e}", secrets)))
        await page.goto(f"{url}/", wait_until="load", timeout=options.startup_timeout_s * 1000)
        await page.wait_for_function(APP_READY, timeout=options.startup_timeout_s * 1000)
        return session
    except SetupError:
        await _quiet_close(playwright, browser, context, url, token_id)
        raise
    except Exception as error:
        await _quiet_close(playwright, browser, context, url, token_id)
        # Only the first line: Playwright appends a call log (request headers and the like).
        first_line = str(error).splitlines()[0] if str(error) else type(error).__name__
        raise SetupError(f"browser setup failed: {_redact(first_line, [options.password])}") from error


async def _quiet_close(
    playwright: Playwright, browser: Browser, context: BrowserContext, url: str, token_id: str | None
) -> None:
    if token_id:
        with contextlib.suppress(Exception):
            await context.request.delete(f"{url}/api/me/tokens/{token_id}", headers=CSRF_HEADER)
    with contextlib.suppress(Exception):
        await browser.close()
    with contextlib.suppress(Exception):
        await playwright.stop()
