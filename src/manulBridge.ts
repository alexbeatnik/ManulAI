/**
 * ManulBridge — thin HTTP client for ManulEngine backend.
 *
 * ManulMcpServer exposes ManulEngine at http://127.0.0.1:8000 (default).
 * This module calls that API directly so ManulAI can use all Manul tools
 * without spawning a separate process.
 *
 * The API contract mirrors ManulApiClient from ManulMcpServer.
 */

export interface ManulBridgeOptions {
  readonly apiBaseUrl: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
}

export interface ManulApiResult {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: unknown;
  readonly error?: string;
}

export class ManulBridge {
  public constructor(private readonly options: ManulBridgeOptions) {}

  public async runStep(step: string): Promise<ManulApiResult> {
    return this.request('/run-step', 'POST', { step });
  }

  public async runSteps(steps: string[], context?: string, title?: string): Promise<ManulApiResult> {
    return this.request('/run-steps', 'POST', {
      steps,
      ...(context !== undefined ? { context } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  }

  public async getState(): Promise<ManulApiResult> {
    return this.request('/state', 'GET');
  }

  public async scanPage(): Promise<ManulApiResult> {
    return this.request('/scan-page', 'POST', {});
  }

  public async readPageText(): Promise<ManulApiResult> {
    return this.request('/read-page-text', 'POST', {});
  }

  public async saveHunt(filePath: string, content: string): Promise<ManulApiResult> {
    return this.request('/save-hunt', 'POST', { path: filePath, content });
  }

  public async reset(context?: string, title?: string): Promise<ManulApiResult> {
    return this.request('/reset', 'POST', {
      ...(context !== undefined ? { context } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  }

  private async request(urlPath: string, method: string, body?: unknown): Promise<ManulApiResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const url = `${this.options.apiBaseUrl}${urlPath}`;

    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          sessionId: this.options.sessionId,
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);
      let data: unknown;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        data = await response.json() as unknown;
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        const errMsg = typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).error === 'string'
          ? (data as Record<string, unknown>).error as string
          : response.statusText || 'ManulEngine request failed.';
        return { ok: false, status: response.status, error: errMsg };
      }

      return { ok: true, status: response.status, data };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, status: 408, error: `ManulEngine request to ${urlPath} timed out.` };
      }
      const msg = error instanceof Error ? error.message : 'Unknown ManulBridge error.';
      return { ok: false, status: 0, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  }
}
