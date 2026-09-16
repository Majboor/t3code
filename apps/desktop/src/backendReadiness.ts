export interface WaitForHttpReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly path?: string;
  readonly isReady?: (response: Response) => boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

export class BackendReadinessAbortedError extends Error {
  constructor() {
    super("Backend readiness wait was aborted.");
    this.name = "BackendReadinessAbortedError";
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new BackendReadinessAbortedError());
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new BackendReadinessAbortedError());
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isBackendReadinessAborted(error: unknown): error is BackendReadinessAbortedError {
  return error instanceof BackendReadinessAbortedError;
}

/** Answered, but from somewhere else. Still an answer. */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export async function waitForHttpReady(
  baseUrl: string,
  options?: WaitForHttpReadyOptions,
): Promise<void> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const readinessPath = options?.path ?? "/";
  /**
   * A redirect is an answer, so it means ready.
   *
   * The question this probe asks is "is the backend up and serving", and
   * anything that came back over HTTP has already answered it — the loop below
   * only retries on a thrown request, which is what "not up yet" actually looks
   * like. Requiring 2xx made a redirect indistinguishable from a dead socket.
   *
   * That is not hypothetical. A backend started with `--dev-url` answers `GET /`
   * with a 302 to the dev server, which is every desktop development run: the
   * probe timed out after 60s, the bootstrap never completed, and the renderer
   * fell back to whatever `VITE_WS_URL` happened to say — a different server, or
   * none — where its token meant nothing and every socket got a 401. The visible
   * symptom was a window that loaded and then hung on the first action.
   *
   * `redirect: "manual"` above is what makes this readable rather than followed,
   * and it was already there; only the verdict was wrong.
   */
  const isReady =
    options?.isReady ?? ((response: Response) => response.ok || isRedirect(response.status));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw new BackendReadinessAbortedError();
    }

    const requestController = new AbortController();
    const requestTimeout = setTimeout(() => {
      requestController.abort();
    }, requestTimeoutMs);
    const abortRequest = () => {
      requestController.abort();
    };
    signal?.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetchImpl(new URL(readinessPath, baseUrl).toString(), {
        redirect: "manual",
        signal: requestController.signal,
      });
      if (isReady(response)) {
        return;
      }
    } catch (error) {
      if (isBackendReadinessAborted(error)) {
        throw error;
      }
      if (signal?.aborted) {
        throw new BackendReadinessAbortedError();
      }
      // Retry until the backend becomes reachable or the deadline expires.
    } finally {
      clearTimeout(requestTimeout);
      signal?.removeEventListener("abort", abortRequest);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for backend readiness at ${baseUrl}.`);
    }

    await delay(intervalMs, signal);
  }
}
