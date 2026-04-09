#!/usr/bin/env python3
"""manul_bridge_api.py — ManulAI to ManulEngine subprocess bridge.

Spawned as a long-lived child process by ManulBridge (TypeScript).
Communication is via newline-delimited JSON on stdin / stdout.

Incoming request envelope:
    {"id": "1", "tool": "<name>", ...args}

Outgoing response envelope:
    {"id": "1", "ok": true|false, "data": {...}}
    {"id": "1", "ok": false, "error": "<message>"}

Supported tools:
    run_steps       steps, context, title
    get_state       (no args) → {url, title}
    scan_page       (no args) → {url, title, text}
    read_page_text  (no args) → {text}
    save_hunt       path, content
    close           (no args) — closes the browser and exits the loop
"""

from __future__ import annotations

import asyncio
import json
import os
import sys


def _write(obj: dict) -> None:  # noqa: ANN001
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def main() -> None:  # noqa: C901
    headless = os.environ.get("MANUL_HEADLESS", "0") == "1"
    loop = asyncio.get_event_loop()

    try:
        from manul_engine import ManulSession  # type: ignore[import]
    except ImportError as exc:
        _write({
            "id": "",
            "ok": False,
            "error": (
                f"manul-engine is not installed in this Python environment: {exc}. "
                "Install it with: pip install manul-engine  "
                "(or: pipx install manul-engine)"
            ),
        })
        return

    session: ManulSession | None = None

    async def ensure_session() -> ManulSession:
        nonlocal session
        if session is None:
            session = ManulSession(headless=headless)
            await session.start()
        return session

    async def readline() -> str:
        """Read one line from stdin without blocking the event loop."""
        return await loop.run_in_executor(None, sys.stdin.readline)

    while True:
        raw = await readline()
        if not raw:  # EOF — parent closed stdin
            break
        raw = raw.strip()
        if not raw:
            continue

        try:
            req: dict = json.loads(raw)
        except json.JSONDecodeError as exc:
            _write({"id": "", "ok": False, "error": f"JSON parse error: {exc}"})
            continue

        rid: str = req.get("id", "")
        tool: str = req.get("tool", "")

        try:
            # ── run_steps ──────────────────────────────────────────────────
            if tool == "run_steps":
                s = await ensure_session()
                steps = req.get("steps", "")
                context = req.get("context", "") or ""
                result = await s.run_steps(steps, context)
                _write({
                    "id": rid,
                    "ok": result.status in ("pass", "flaky"),
                    "data": {
                        "status": result.status,
                        "passed": result.passed,
                        "failed": result.failed,
                    },
                })

            # ── get_state ──────────────────────────────────────────────────
            elif tool == "get_state":
                s = await ensure_session()
                try:
                    url = s.page.url
                    title = await s.page.title()
                except Exception:
                    url, title = "", ""
                _write({"id": rid, "ok": True, "data": {"url": url, "title": title}})

            # ── scan_page ──────────────────────────────────────────────────
            elif tool == "scan_page":
                s = await ensure_session()
                try:
                    url = s.page.url
                    title = await s.page.title()
                    text = await s.page.inner_text("body")
                except Exception as exc2:
                    _write({"id": rid, "ok": False, "error": str(exc2)})
                    continue
                _write({"id": rid, "ok": True, "data": {"url": url, "title": title, "text": text[:4000]}})

            # ── read_page_text ─────────────────────────────────────────────
            elif tool == "read_page_text":
                s = await ensure_session()
                try:
                    text = await s.page.inner_text("body")
                except Exception as exc2:
                    _write({"id": rid, "ok": False, "error": str(exc2)})
                    continue
                _write({"id": rid, "ok": True, "data": {"text": text}})

            # ── save_hunt ──────────────────────────────────────────────────
            elif tool == "save_hunt":
                fpath = req.get("path", "")
                content = req.get("content", "")
                if not fpath:
                    _write({"id": rid, "ok": False, "error": "No path provided for save_hunt."})
                    continue
                parent = os.path.dirname(fpath)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                with open(fpath, "w", encoding="utf-8") as fh:
                    fh.write(content)
                _write({"id": rid, "ok": True, "data": {"saved": fpath}})

            # ── close ──────────────────────────────────────────────────────
            elif tool == "close":
                if session is not None:
                    await session.close()
                    session = None
                _write({"id": rid, "ok": True, "data": {}})
                break

            else:
                _write({"id": rid, "ok": False, "error": f"Unknown tool: {tool!r}"})

        except Exception as exc:  # noqa: BLE001
            _write({"id": rid, "ok": False, "error": str(exc)})

    if session is not None:
        try:
            await session.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    asyncio.run(main())
