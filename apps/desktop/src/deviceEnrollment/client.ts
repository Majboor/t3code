/**
 * The three enrollment calls, and the machine's description of itself.
 *
 * `fetch` is injected rather than imported so the flow can be exercised without
 * a network, matching how `backendReadiness.ts` and `cloudSync/liveShare.ts`
 * already do it here. Every call carries its own timeout: this is the first
 * place in the desktop main process that makes an outbound request on a
 * person's behalf, and a socket that hangs open with no deadline is how a
 * "connecting…" screen becomes permanent.
 *
 * @module DeviceEnrollment
 */

import {
  decodeCollectedEnrollment,
  decodeCreatedEnrollment,
  decodeEnrollmentSnapshot,
  type CollectedEnrollment,
  type CreatedEnrollment,
  type EnrollmentSnapshot,
} from "./types.ts";

export type FetchImpl = typeof globalThis.fetch;

/**
 * Long enough to survive a slow link, short enough that a wedged connection
 * becomes a retry rather than a permanent wait. The poll interval is smaller
 * than this on purpose — an unanswered request must not stack up behind itself.
 */
const REQUEST_TIMEOUT_MS = 15_000;

const ENROLLMENTS_PATH = "/api/devices/enrollments";

/**
 * Where enrollments are requested.
 *
 * There is no cloud host baked into this app today, and no config file that
 * names one, so this is the single place that decides — overridable by
 * environment, because the alternative is a constant that developers have to
 * edit and remember not to commit.
 */
export const DEFAULT_ENROLLMENT_CLOUD_BASE_URL = "https://app.logicpacks.io";

/**
 * The portal this build was published from, baked in at dist time
 * (`T3CODE_ENROLLMENT_BASE_URL` → `apps/desktop/tsdown.config.ts` `define`).
 * A download from a self-hosted portal then enrols against that portal without
 * anybody typing an address; the runtime `T3CODE_CLOUD_URL` still wins.
 */
declare const __T3_ENROLLMENT_BASE_URL__: string | undefined;
const BAKED_ENROLLMENT_BASE_URL: string | undefined =
  typeof __T3_ENROLLMENT_BASE_URL__ === "string" && __T3_ENROLLMENT_BASE_URL__.length > 0
    ? __T3_ENROLLMENT_BASE_URL__
    : undefined;

export function resolveEnrollmentCloudBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.T3CODE_CLOUD_URL?.trim() || BAKED_ENROLLMENT_BASE_URL?.trim();
  if (!configured) {
    return DEFAULT_ENROLLMENT_CLOUD_BASE_URL;
  }
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : DEFAULT_ENROLLMENT_CLOUD_BASE_URL;
  } catch {
    return DEFAULT_ENROLLMENT_CLOUD_BASE_URL;
  }
}

/**
 * The name a person will see on the approval screen.
 *
 * This is the whole reason the approval is meaningful. "Approve this machine?"
 * with nothing named is a dialog people click through, so the hostname is sent
 * — it is the one string a person reliably recognises as their own laptop.
 * Trailing `.local` is dropped because macOS appends it and "Waleeds-MacBook"
 * reads better than "Waleeds-MacBook.local".
 */
export function resolveDeviceLabel(hostname: string, fallback = "Unknown machine"): string {
  const trimmed = hostname.trim().replace(/\.local$/i, "");
  return trimmed.length > 0 ? trimmed.slice(0, 120) : fallback;
}

/** `process.platform`, normalised to the vocabulary the rest of the repo uses. */
export function resolveDevicePlatform(platform: string): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "unknown";
}

export interface EnrollmentClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchImpl;
}

/**
 * What a collect attempt meant.
 *
 * `not-ready` is separated from `failed` because it is not a failure at all —
 * it is what the server says while a person is still deciding, and treating it
 * as an error would either abandon a live enrollment or fill the logs with
 * alarming noise for the ordinary case.
 */
export type CollectOutcome =
  | { readonly outcome: "collected"; readonly credential: CollectedEnrollment }
  | { readonly outcome: "not-ready" }
  | { readonly outcome: "failed"; readonly retryable: boolean; readonly message: string };

function describeHttpFailure(status: number): string {
  if (status === 404) {
    return "This request is no longer available. Start over to connect this machine.";
  }
  if (status === 409 || status === 410) {
    return "This request was already used. Start over to connect this machine.";
  }
  if (status >= 500) {
    return "The service is not responding. Retrying.";
  }
  return `The service refused the request (${status}).`;
}

async function requestJson(
  input: {
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly fetchImpl: FetchImpl;
  },
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await input.fetchImpl(input.url, {
    method: input.method,
    signal,
    headers: {
      accept: "application/json",
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  // A body is parsed even for error statuses, because the useful part of a
  // refusal is usually in it. A response that is not JSON is not an exception
  // here — it is simply an absent body, and the status still carries meaning.
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createEnrollmentClient(options: EnrollmentClientOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  return {
    /**
     * Asks for a code. The label and platform travel with the request because
     * the approval screen has nothing else to name the machine with.
     */
    create: async (input: {
      readonly deviceLabel: string;
      readonly devicePlatform: string;
    }): Promise<CreatedEnrollment> =>
      withTimeout(async (signal) => {
        const { status, body } = await requestJson(
          {
            url: `${base}${ENROLLMENTS_PATH}`,
            method: "POST",
            body: { deviceLabel: input.deviceLabel, devicePlatform: input.devicePlatform },
            fetchImpl,
          },
          signal,
        );
        if (status !== 201 && status !== 200) {
          throw new Error(describeHttpFailure(status));
        }
        const created = decodeCreatedEnrollment(body);
        if (!created) {
          throw new Error("The service returned a request this app could not read.");
        }
        return created;
      }),

    /** Reads the current status. Returns `null` when the answer was unreadable. */
    read: async (code: string): Promise<EnrollmentSnapshot | null> =>
      withTimeout(async (signal) => {
        const { status, body } = await requestJson(
          {
            url: `${base}${ENROLLMENTS_PATH}/${encodeURIComponent(code)}`,
            method: "GET",
            fetchImpl,
          },
          signal,
        );
        // A code the server has forgotten is indistinguishable from one it
        // expired, and expired is the answer that lets the UI say something
        // true instead of retrying against a 404 until the deadline.
        if (status === 404 || status === 410) {
          return { status: "expired", ...emptySnapshotDetail } as EnrollmentSnapshot;
        }
        if (status !== 200) {
          throw new Error(describeHttpFailure(status));
        }
        return decodeEnrollmentSnapshot(body);
      }),

    /**
     * Spends the code. Succeeds exactly once by the server's design, so this is
     * called only after a status read reported `approved` — never speculatively.
     */
    collect: async (code: string): Promise<CollectOutcome> =>
      withTimeout(async (signal) => {
        const { status, body } = await requestJson(
          {
            url: `${base}${ENROLLMENTS_PATH}/${encodeURIComponent(code)}/collect`,
            method: "POST",
            fetchImpl,
          },
          signal,
        );

        if (status === 200 || status === 201) {
          const credential = decodeCollectedEnrollment(body);
          return credential
            ? { outcome: "collected", credential }
            : {
                outcome: "failed",
                retryable: false,
                message: "The service approved this machine but sent no credential.",
              };
        }

        // "Approved, but not yet" and "too early" are the shapes a server uses
        // for a poll that arrived before the click. Both mean keep waiting.
        if (status === 425 || status === 403 || status === 428) {
          return { outcome: "not-ready" };
        }

        return {
          outcome: "failed",
          retryable: status >= 500,
          message: describeHttpFailure(status),
        };
      }),
  };
}

const emptySnapshotDetail = {
  deviceLabel: null,
  devicePlatform: null,
  requestedIp: null,
  expiresAtMs: null,
} as const;

export type EnrollmentClient = ReturnType<typeof createEnrollmentClient>;
