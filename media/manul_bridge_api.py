#!/usr/bin/env python3
"""
ManulAI Python Subprocess Bridge
================================
Persistent subprocess that holds an open ManulSession (browser stays alive
across tool calls). Speaks a JSON-line protocol over stdin/stdout so the
parent ManulAI process can send commands and receive results without any HTTP server.

Protocol
--------
Each message is a single UTF-8 JSON line.

Incoming (Node → Python):
  {"id": "1", "method": "run_steps",    "params": {"steps": [...], "context": "...", "title": "...", "headless": false}}
  {"id": "2", "method": "get_state",    "params": {}}
  {"id": "3", "method": "propose_hunt", "params": {"context": "...", "title": "..."}}
  {"id": "4", "method": "save_hunt",    "params": {"path": "...", "content": "..."}}
  {"id": "5", "method": "reset",        "params": {"context": "...", "title": "..."}}
  {"id": "6", "method": "shutdown",     "params": {}}

Outgoing (Python → Node), first message:
  {"type": "ready", "version": "1.0"}

Outgoing for every command:
  {"id": "1", "ok": true,  "data": {...}}
  {"id": "1", "ok": false, "error": "..."}
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
from typing import Any

# ── Force UTF-8 on Windows (stdout/stderr may default to charmap) ─────────────
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ── import guard ──────────────────────────────────────────────────────────────

def _emit_raw(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# Custom page-scan JS (enriched: resolves <label for> for radio/checkbox,
# and includes manul_id when SNAPSHOT_JS has already stamped elements).
_SCAN_PAGE_JS = """() => {
    function isHidden(el) {
        if (el.getAttribute('aria-hidden') === 'true') return true;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return true;
        try {
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return true;
        } catch (_) {}
        return false;
    }
    function bestLabel(el) {
        const tag  = el.tagName ? el.tagName.toUpperCase() : '';
        const type = (el.getAttribute('type') || '').toLowerCase();
        // For radio/checkbox prefer the associated <label for="..."> text.
        if (tag === 'INPUT' && (type === 'radio' || type === 'checkbox')) {
            if (el.id) {
                const lbl = document.querySelector('label[for="' + el.id + '"]');
                if (lbl) return lbl.innerText.trim();
            }
            const closestLbl = el.closest('label');
            if (closestLbl) return closestLbl.innerText.trim();
            const nextSib = el.nextElementSibling;
            if (nextSib && nextSib.tagName === 'LABEL') return nextSib.innerText.trim();
        }
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text && text.length <= 80) return text;
        const aria = el.getAttribute('aria-label') || '';
        if (aria.trim()) return aria.trim();
        const ph = el.getAttribute('placeholder') || '';
        if (ph.trim()) return ph.trim();
        const title = el.getAttribute('title') || '';
        if (title.trim()) return title.trim();
        const name = el.getAttribute('name') || '';
        if (name.trim()) return name.trim();
        const id = el.getAttribute('id') || '';
        if (id.trim()) return id.trim();
        return '';
    }
    function classify(el) {
        const tag  = el.tagName ? el.tagName.toUpperCase() : '';
        const type = (el.getAttribute('type') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (tag === 'SELECT') return 'select';
        if (tag === 'INPUT' && type === 'checkbox') return 'checkbox';
        if (tag === 'INPUT' && type === 'radio')    return 'radio';
        if (tag === 'INPUT' && !['submit','reset','image','hidden','button'].includes(type)) return 'input';
        if (tag === 'TEXTAREA') return 'input';
        if (tag === 'BUTTON')   return 'button';
        if (tag === 'A' && el.getAttribute('href') !== null) return 'link';
        if (role === 'button')   return 'button';
        if (role === 'link')     return 'link';
        if (role === 'checkbox') return 'checkbox';
        if (role === 'radio')    return 'radio';
        if (role === 'combobox') return 'select';
        if (role === 'switch')   return 'checkbox';
        if (tag === 'INPUT' && type === 'submit') return 'button';
        if (tag === 'INPUT' && type === 'button') return 'button';
        return null;
    }
    function scanRoot(root, results, seen) {
        const candidates = root.querySelectorAll(
            'button, a[href], input, select, textarea, ' +
            '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
            '[role="combobox"], [role="switch"]'
        );
        for (const el of candidates) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (isHidden(el)) continue;
            const kind  = classify(el);
            if (!kind)  continue;
            const label = bestLabel(el);
            if (!label) continue;
            const entry = { type: kind, identifier: label };
            const mid = el.getAttribute('data-manul-id');
            if (mid !== null) entry.manul_id = parseInt(mid, 10);
            // Include current value for fillable elements so callers can verify state.
            if ((kind === 'input' || kind === 'select') && el.value !== undefined && el.value !== '') {
                entry.value = el.value;
            }
            results.push(entry);
        }
        for (const el of root.querySelectorAll('[class*="shadow"], [class*="component"], [data-shadow], *:defined:not(div):not(span):not(p):not(a):not(button):not(input):not(select):not(textarea):not(ul):not(ol):not(li):not(table):not(tr):not(td):not(th):not(form):not(label):not(img):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6):not(nav):not(section):not(article):not(header):not(footer):not(main)')) {
            if (el.shadowRoot) scanRoot(el.shadowRoot, results, seen);
        }
    }
    const results = [];
    const seen    = new WeakSet();
    scanRoot(document, results, seen);
    return JSON.stringify(results);
}"""

try:
    from manul_engine import ManulSession  # type: ignore[import]
except ImportError as _e:
    _emit_raw({
        "type": "error",
        "error": (
            f"manul-engine not installed: {_e}. "
            "Run: pip install manul-engine"
        ),
    })
    sys.exit(1)


# ── helpers ────────────────────────────────────────────────────────────────────

def _log(msg: str) -> None:
    sys.stderr.write(f"[RUNNER] {msg}\n")
    sys.stderr.flush()


def _emit(obj: dict[str, Any]) -> None:
    _emit_raw(obj)


def _build_hunt(context: str, title: str, steps: list[str]) -> str:
    """Assemble a clean .hunt file from successfully executed steps."""
    if not steps:
        return ""

    def _indent(s: str) -> str:
        # steps may already carry indentation; strip and re-indent uniformly
        return "    " + s.strip()

    body = "\n".join(_indent(s) for s in steps)
    return textwrap.dedent(f"""\
        @context: {context}
        @title: {title}

        STEP 1: Recorded actions
        {body}

        DONE.
    """).rstrip()


# ── runner class ──────────────────────────────────────────────────────────────

class ManulRunner:
    def __init__(self) -> None:
        self._session: ManulSession | None = None
        self._headless: bool = False
        self._context: str = "Manul automation"
        self._title: str = "Recorded Session"
        self._executed_steps: list[str] = []
        self._session_id: str = os.environ.get("MANUL_SESSION_ID", "").strip()

    # ── session lifecycle ──────────────────────────────────────────────────────

    async def _ensure_session(self, headless: bool) -> None:
        if self._session is not None:
            return
        self._headless = headless
        executable_path = os.environ.get("MANUL_EXECUTABLE_PATH", "").strip() or None
        _log(f"Opening browser (headless={headless}) …")
        self._session = ManulSession(
            headless=headless,
            disable_cache=True,
            executable_path=executable_path,
        )
        await self._session.__aenter__()
        _log("Browser ready.")

    async def _close_session(self) -> None:
        if self._session is not None:
            try:
                await self._session.__aexit__(None, None, None)
            except Exception as exc:  # noqa: BLE001
                _log(f"Session close error (ignored): {exc}")
            finally:
                self._session = None

    async def _scan_current_page(self) -> list[dict[str, Any]]:
        """Scan the current page; returns [] if no session or on error."""
        if self._session is None:
            return []
        try:
            raw = await self._session.page.evaluate(_SCAN_PAGE_JS)  # type: ignore[union-attr]
            return json.loads(raw)
        except Exception:  # noqa: BLE001
            return []

    def _should_capture_page_scan(self, step: str) -> bool:
        normalized = step.strip().lower()
        return normalized.startswith((
            "navigate ",
            "click ",
            "double click ",
            "right click ",
            "press enter",
        ))

    # ── method handlers ────────────────────────────────────────────────────────

    async def _handle_run_steps(self, params: dict[str, Any]) -> dict[str, Any]:
        steps: list[str] = params.get("steps") or []
        context: str = params.get("context") or self._context
        title: str = params.get("title") or self._title
        headless: bool = bool(params.get("headless", self._headless))

        if not steps:
            return {"ok": False, "error": "No steps provided."}

        await self._ensure_session(headless)
        self._context = context
        self._title = title

        results: list[dict[str, Any]] = []
        newly_succeeded: list[str] = []

        failed = False
        failure_error: str | None = None
        for step in steps:
            _log(f"Step: {step}")
            try:
                result = await self._session.run_steps(step)  # type: ignore[union-attr]
                status = getattr(result, "status", "pass")
                page_scan = await self._scan_current_page() if self._should_capture_page_scan(step) else []
                if status == "pass":
                    newly_succeeded.append(step)
                    results.append({"step": step, "status": "pass", "page_scan": page_scan})
                else:
                    # collect error info if available
                    err = getattr(result, "last_error", None) or str(result)
                    results.append({"step": step, "status": status, "error": err, "page_scan": page_scan})
                    _log(f"Step failed ({status}): {step}")
                    failed = True
                    failure_error = str(err)
                    break  # stop on first failure — like the real engine does
            except Exception as exc:  # noqa: BLE001
                page_scan = await self._scan_current_page() if self._should_capture_page_scan(step) else []
                results.append({"step": step, "status": "error", "error": str(exc), "page_scan": page_scan})
                _log(f"Step exception: {exc}")
                failed = True
                failure_error = str(exc)
                break

        # Keep the browser alive on failure so the user can inspect/retry.
        # Only an explicit reset or shutdown should close the session.

        self._executed_steps.extend(newly_succeeded)
        hunt_proposal = _build_hunt(self._context, self._title, self._executed_steps)

        pass_count = sum(1 for r in results if r["status"] == "pass")
        data = {
            "results": results,
            "pass_count": pass_count,
            "total": len(steps),
            "executed_steps": len(self._executed_steps),
            "executed_total": len(self._executed_steps),
            "hunt_proposal": hunt_proposal,
        }
        if failed:
            return {
                "ok": False,
                "error": failure_error or "One or more Manul steps failed.",
                "data": data,
            }
        return {"ok": True, "data": data}

    async def _handle_get_state(self, _params: dict[str, Any]) -> dict[str, Any]:
        try:
            import importlib.metadata as _meta
            version = _meta.version("manul-engine")
        except Exception:  # noqa: BLE001
            version = "unknown"

        return {
            "ok": True,
            "data": {
                "runner": "python",
                "engine_version": version,
                "browser_open": self._session is not None,
                "headless": self._headless,
                "session_id": self._session_id,
                "context": self._context,
                "title": self._title,
                "executed_steps": len(self._executed_steps),
                "hunt_proposal": _build_hunt(self._context, self._title, self._executed_steps),
                "status": "ready" if self._session is not None else "idle",
            },
        }

    async def _handle_propose_hunt(self, params: dict[str, Any]) -> dict[str, Any]:
        context = params.get("context") or self._context
        title = params.get("title") or self._title
        hunt = _build_hunt(context, title, self._executed_steps)
        return {"ok": True, "data": {"hunt_proposal": hunt, "hunt": hunt}}

    async def _handle_save_hunt(self, params: dict[str, Any]) -> dict[str, Any]:
        path: str = params.get("path", "").strip()
        content: str = params.get("content", "")
        if not path:
            return {"ok": False, "error": "path is required."}
        if not content:
            return {"ok": False, "error": "content is required."}

        # Workspace-jail: resolve relative to MANUL_WORKSPACE_PATH and reject escapes
        workspace_root = os.environ.get("MANUL_WORKSPACE_PATH", "").strip()
        if workspace_root:
            abs_path = os.path.normpath(os.path.join(workspace_root, path)) if not os.path.isabs(path) else os.path.normpath(path)
            real_root = os.path.realpath(workspace_root)
            real_path = os.path.realpath(os.path.dirname(abs_path))
            if not real_path.startswith(real_root + os.sep) and real_path != real_root:
                return {"ok": False, "error": f"Access denied: save path must be inside the workspace ({workspace_root})"}
        else:
            abs_path = os.path.abspath(path)

        if not abs_path.endswith(".hunt"):
            return {"ok": False, "error": "Access denied: only .hunt files may be written."}

        # Reject existing symlink files to prevent writing outside the workspace
        if os.path.islink(abs_path):
            real_file = os.path.realpath(abs_path)
            if workspace_root:
                real_root = os.path.realpath(workspace_root)
                if not real_file.startswith(real_root + os.sep) and real_file != real_root:
                    return {"ok": False, "error": f"Access denied: refusing to write through symlink to {real_file}"}

        os.makedirs(os.path.dirname(abs_path) or ".", exist_ok=True)
        with open(abs_path, "w", encoding="utf-8") as fh:
            fh.write(content)
        _log(f"Hunt saved → {abs_path}")
        return {"ok": True, "data": {"saved_path": abs_path}}

    async def _handle_scan_page(self, _params: dict[str, Any]) -> dict[str, Any]:
        if self._session is None:
            return {"ok": False, "error": "No active browser session. Use NAVIGATE first."}
        try:
            raw = await self._session.page.evaluate(_SCAN_PAGE_JS)  # type: ignore[union-attr]
            elements: list[dict[str, Any]] = json.loads(raw)
            return {"ok": True, "data": {"elements": elements, "count": len(elements)}}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    async def _handle_read_page_text(self, _params: dict[str, Any]) -> dict[str, Any]:
        if self._session is None:
            return {"ok": False, "error": "No active browser session. Use NAVIGATE first."}
        try:
            text: str = await self._session.page.evaluate("document.body.innerText")  # type: ignore[union-attr]
            return {"ok": True, "data": {"text": text}}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    async def _handle_reset(self, params: dict[str, Any]) -> dict[str, Any]:
        self._executed_steps.clear()
        self._context = params.get("context") or "Manul automation"
        self._title = params.get("title") or "Recorded Session"
        return {"ok": True, "data": {"status": "reset"}}

    async def _handle_shutdown(self, _params: dict[str, Any]) -> dict[str, Any]:
        await self._close_session()
        return {"ok": True, "data": {"status": "shutdown"}}

    # ── dispatch ───────────────────────────────────────────────────────────────

    _HANDLERS = {
        "run_steps":      "_handle_run_steps",
        "get_state":      "_handle_get_state",
        "propose_hunt":   "_handle_propose_hunt",
        "save_hunt":      "_handle_save_hunt",
        "scan_page":      "_handle_scan_page",
        "read_page_text": "_handle_read_page_text",
        "reset":          "_handle_reset",
        "shutdown":       "_handle_shutdown",
    }

    async def _process(self, msg: dict[str, Any]) -> None:
        method: str = msg.get("method", "")
        msg_id = msg.get("id")
        params: dict[str, Any] = msg.get("params") or {}

        handler_name = self._HANDLERS.get(method)
        if handler_name is None:
            _emit({"id": msg_id, "ok": False, "error": f"Unknown method: {method}"})
            return

        try:
            result = await getattr(self, handler_name)(params)
        except Exception as exc:  # noqa: BLE001
            _log(f"Handler error ({method}): {exc}")
            result = {"ok": False, "error": str(exc)}

        _emit({"id": msg_id, **result})

    # ── main loop ──────────────────────────────────────────────────────────────

    async def run(self) -> None:
        _log("Manul Python runner started.")
        _emit({"type": "ready", "version": "1.0"})

        loop = asyncio.get_running_loop()

        while True:
            try:
                line: str = await loop.run_in_executor(None, sys.stdin.readline)
            except Exception as exc:  # noqa: BLE001
                _log(f"stdin read error: {exc}")
                break

            if not line:
                _log("stdin closed, exiting.")
                break

            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"type": "error", "error": f"JSON parse error: {exc}"})
                continue

            await self._process(msg)

            if msg.get("method") == "shutdown":
                break

        await self._close_session()
        _log("Runner stopped.")


# ── entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    asyncio.run(ManulRunner().run())
