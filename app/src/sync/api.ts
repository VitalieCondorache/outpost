import {
  API_ROUTES,
  type PullResponse,
  type SyncRequest,
  type SyncResponse,
} from '@outpost/shared';

export interface SyncApi {
  push(request: SyncRequest): Promise<SyncResponse>;
  pull(since: number): Promise<PullResponse>;
  reset(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface HttpSyncApiOptions {
  /**
   * Origin of the API. Defaults to a same-origin path so dev/preview and the
   * Docker Compose stack can rely on the reverse proxy instead of CORS.
   */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Thin HTTP client: no retries, no caching — the engine owns those policies. */
export class HttpSyncApi implements SyncApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpSyncApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  push(request: SyncRequest): Promise<SyncResponse> {
    return this.request<SyncResponse>(API_ROUTES.sync, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  pull(since: number): Promise<PullResponse> {
    return this.request<PullResponse>(`${API_ROUTES.notes}?since=${encodeURIComponent(since)}`);
  }

  async reset(): Promise<void> {
    await this.request(API_ROUTES.reset, { method: 'POST' });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted
        ? `request timed out after ${this.timeoutMs}ms`
        : describeNetworkError(error);
      throw new ApiError(reason);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new ApiError(
        `request failed with ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error)
    return error.message === '' ? 'network request failed' : error.message;
  return 'network request failed';
}
