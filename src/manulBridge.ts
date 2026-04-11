/**
 * ManulBridge — subprocess bridge to ManulEngine Python API.
 *
 * ManulAI spawns a long-lived Python process (media/manul_bridge_api.py)
 * that owns the Playwright browser session.  Communication is via
 * newline-delimited JSON on stdin/stdout.
 *
 * The Python script uses ManulSession from manul-engine and keeps the
 * browser alive between tool calls so session state is preserved.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ManulBridgeOptions {
  /** Absolute path to the Python executable that has manul-engine installed. */
  readonly pythonPath: string;
  /** Absolute path to media/manul_bridge_api.py bundled with the extension. */
  readonly scriptPath: string;
  /** Working directory for the subprocess (usually workspace root). */
  readonly workspaceRoot: string;
  /** Opaque session identifier forwarded to the runner for correlation/debugging. */
  readonly sessionId: string;
  /** false = show browser window (default); true = headless. */
  readonly headless: boolean;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
}

export interface ManulApiResult {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: unknown;
  readonly error?: string;
}

export class ManulBridge {
  private proc?: cp.ChildProcess;
  private readonly pending = new Map<string, {
    resolve: (r: ManulApiResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private reqIdCounter = 0;
  private lineBuffer = '';

  public constructor(private readonly options: ManulBridgeOptions) {}

  private resolvePendingRequests(error: string, status = 0): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, status, error });
    }
    this.pending.clear();
  }

  // ── Subprocess lifecycle ─────────────────────────────────────────────

  private ensureProc(): cp.ChildProcess {
    if (this.proc && !this.proc.killed) {
      return this.proc;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MANUL_HEADLESS: this.options.headless ? '1' : '0',
      MANUL_WORKSPACE_PATH: this.options.workspaceRoot,
      MANUL_SESSION_ID: this.options.sessionId,
    };

    this.proc = cp.spawn(this.options.pythonPath, [this.options.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.options.workspaceRoot,
    });

    this.lineBuffer = '';

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      let nl: number;
      while ((nl = this.lineBuffer.indexOf('\n')) >= 0) {
        const line = this.lineBuffer.slice(0, nl).trim();
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        if (!line) { continue; }
        try {
          const msg = JSON.parse(line) as {
            id: string; ok: boolean; data?: unknown; error?: string;
          };
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            entry.resolve({
              ok: msg.ok,
              status: msg.ok ? 200 : 500,
              data: msg.data,
              error: msg.error,
            });
          }
        } catch {
          // non-JSON debug line from Python — ignore
        }
      }
    });

    this.proc.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.resolvePendingRequests(`ManulEngine subprocess error: ${message}`);
      this.proc = undefined;
    });

    this.proc.on('exit', () => {
      this.resolvePendingRequests('ManulEngine subprocess exited unexpectedly.');
      this.proc = undefined;
    });

    return this.proc;
  }

  // ── Request helper ──────────────────────────────────────────────────

  /**
   * Sends a request using the manul_runner.py protocol:
   *   {"id": "N", "method": "<name>", "params": {...}}
   */
  private async request(method: string, params?: Record<string, unknown>): Promise<ManulApiResult> {
    let proc: cp.ChildProcess;
    try {
      proc = this.ensureProc();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, error: `Failed to start ManulEngine subprocess: ${msg}` };
    }

    if (!proc.stdin || proc.killed) {
      return { ok: false, status: 0, error: 'ManulEngine subprocess stdin is not available.' };
    }

    const id = String(++this.reqIdCounter);
    const payload = JSON.stringify({ id, method, params: params ?? {} });

    return new Promise<ManulApiResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          status: 408,
          error: `ManulEngine '${method}' timed out after ${this.options.timeoutMs / 1000}s.`,
        });
      }, this.options.timeoutMs);

      this.pending.set(id, { resolve, timer });
      proc.stdin!.write(payload + '\n');
    });
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Run a single DSL step string. */
  public async runStep(step: string): Promise<ManulApiResult> {
    return this.request('run_steps', { steps: [step], headless: this.options.headless });
  }

  /** Run multiple DSL step strings. */
  public async runSteps(steps: string[], context?: string, title?: string): Promise<ManulApiResult> {
    return this.request('run_steps', {
      steps,
      context: context ?? '',
      title: title ?? '',
      headless: this.options.headless,
    });
  }

  /** Reset session state (clears executed_steps, optionally updates context/title). Browser stays open. */
  public async reset(context?: string, title?: string): Promise<ManulApiResult> {
    return this.request('reset', {
      context: context ?? '',
      title: title ?? '',
    });
  }

  /** Get current browser state (url, title, engine_version, etc.). */
  public async getState(): Promise<ManulApiResult> {
    return this.request('get_state');
  }

  /** Return structured element list from the current page. */
  public async scanPage(): Promise<ManulApiResult> {
    return this.request('scan_page');
  }

  /** Return the raw text of the current page. */
  public async readPageText(): Promise<ManulApiResult> {
    return this.request('read_page_text');
  }

  /** Save a hunt file to disk (workspace-jailed in the runner). */
  public async saveHunt(filePath: string, content: string): Promise<ManulApiResult> {
    return this.request('save_hunt', { path: filePath, content });
  }

  /** Return a hunt file proposal reconstructed from executed steps so far. */
  public async proposeHunt(context?: string, title?: string): Promise<ManulApiResult> {
    return this.request('propose_hunt', {
      context: context ?? '',
      title: title ?? '',
    });
  }

  /** Gracefully shut down the subprocess, then kill it if needed. */
  public dispose(): void {
    if (this.proc && !this.proc.killed) {
      void this.request('shutdown').catch(() => {
        /* best-effort */
      });
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      setTimeout(() => {
        try { this.proc?.kill(); } catch { /* ignore */ }
      }, 1500);
    }
    this.proc = undefined;
  }
}

// ── Helper exported for ManulAiChatProvider ─────────────────────────────

/**
 * Resolves the best Python executable that has manul-engine installed.
 *
 * Priority:
 *   1. Workspace virtualenv / .venv
 *   2. pipx manul-engine virtualenv
 *   3. System Python launcher fallback
 */
export function resolveManulPython(workspaceRoot: string): string {
  const candidates = process.platform === 'win32'
    ? [
      path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe'),
      path.join(workspaceRoot, 'venv', 'Scripts', 'python.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'pipx', 'venvs', 'manul-engine', 'Scripts', 'python.exe'),
      path.join(os.homedir(), '.local', 'pipx', 'venvs', 'manul-engine', 'Scripts', 'python.exe'),
    ]
    : [
      path.join(workspaceRoot, '.venv', 'bin', 'python3'),
      path.join(workspaceRoot, 'venv', 'bin', 'python3'),
      path.join(os.homedir(), '.local', 'share', 'pipx', 'venvs', 'manul-engine', 'bin', 'python3'),
    ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { return p; }
    } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
