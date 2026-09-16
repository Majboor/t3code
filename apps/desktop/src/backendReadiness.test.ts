import { describe, expect, it, vi } from "vitest";

import {
  BackendReadinessAbortedError,
  isBackendReadinessAborted,
  waitForHttpReady,
} from "./backendReadiness.ts";

describe("waitForHttpReady", () => {
  it("returns once the backend serves the requested readiness path", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3773/",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  /**
   * The case that broke every desktop development run: a backend started with
   * `--dev-url` answers `GET /` with a 302 to the dev server, the probe timed
   * out on it, and the renderer never received its bootstrap.
   */
  it("treats a redirect as ready, because the backend answered", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "/elsewhere" } }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still retries a server error, which is not an answer to this question", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries after a readiness request stalls past the per-request timeout", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("request timed out"));
              },
              { once: true },
            );
          }) as ReturnType<typeof fetch>,
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 0,
      requestTimeoutMs: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight readiness wait", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(new BackendReadinessAbortedError());
            },
            { once: true },
          );
        }) as ReturnType<typeof fetch>,
    );

    const waitPromise = waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
      signal: controller.signal,
    });

    controller.abort();

    await expect(waitPromise).rejects.toBeInstanceOf(BackendReadinessAbortedError);
  });

  it("recognizes aborted readiness errors", () => {
    expect(isBackendReadinessAborted(new BackendReadinessAbortedError())).toBe(true);
    expect(isBackendReadinessAborted(new Error("nope"))).toBe(false);
  });

  it("supports custom readiness predicates", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
      path: "/api/healthz",
      isReady: (response) => response.status === 204,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3773/api/healthz",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3773/api/healthz",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
