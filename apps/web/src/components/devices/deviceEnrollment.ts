import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { parseEnrollmentPreview, type EnrollmentPreview } from "./deviceEnrollment.logic";

/**
 * The approval page's three calls, and nothing else.
 *
 * Plain HTTP rather than the environment RPC, for the same reason `/share` is:
 * the person answering has no environment connection yet — the machine they are
 * about to approve is the connection — so putting a WebSocket bootstrap in
 * front of the one screen that has to work would be putting the slowest part of
 * the app in front of the most important click. The session cookie is the only
 * state any of this needs.
 *
 * Mirrors the routes in the server's device-enrollment HTTP module; change both
 * or neither.
 */

/** `/connect?code=…` — what the desktop app puts in the URL it opens. */
export const DEVICE_ENROLLMENT_CODE_PARAM = "code";

const DEVICE_ENROLLMENT_PATH_PREFIX = "/api/devices/enrollments";

/**
 * `unknown-code` is a code the server has never heard of, which is nearly
 * always a truncated link and gets its own advice.
 * `signed-out` means the session went stale between loading the page and
 * pressing the button; the page can recover by sending them back through
 * sign-in with the code intact.
 * `refused` is the server declining a decision the page thought was still
 * available — approving something already approved, deciding on something that
 * lapsed while it was on screen. It is always followed by re-reading the
 * request, because the honest answer is whatever the status now says.
 */
export type DeviceEnrollmentFailureKind = "unknown-code" | "signed-out" | "refused" | "failed";

export class DeviceEnrollmentError extends Error {
  readonly kind: DeviceEnrollmentFailureKind;

  constructor(kind: DeviceEnrollmentFailureKind, message: string) {
    super(message);
    this.name = "DeviceEnrollmentError";
    this.kind = kind;
  }
}

function enrollmentUrl(code: string, suffix = ""): string {
  return resolvePrimaryEnvironmentHttpUrl(
    `${DEVICE_ENROLLMENT_PATH_PREFIX}/${encodeURIComponent(code)}${suffix}`,
  );
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

async function failureFor(response: Response, fallback: string): Promise<DeviceEnrollmentError> {
  const message = await readErrorMessage(response, fallback);
  if (response.status === 404) {
    return new DeviceEnrollmentError("unknown-code", message);
  }
  if (response.status === 401) {
    return new DeviceEnrollmentError("signed-out", message);
  }
  if (response.status === 403 || response.status === 409 || response.status === 410) {
    return new DeviceEnrollmentError("refused", message);
  }
  return new DeviceEnrollmentError("failed", message);
}

/**
 * What is asking to join, so a person can recognise it.
 *
 * Read on every visit and re-read after any refusal: the request can change
 * underneath this page — it can lapse, or somebody else can answer it — and the
 * screen is only worth trusting if it says what the server currently says.
 */
export async function fetchDeviceEnrollmentPreview(code: string): Promise<EnrollmentPreview> {
  const response = await fetch(enrollmentUrl(code), {
    credentials: "include",
    method: "GET",
  }).catch(() => {
    throw new DeviceEnrollmentError(
      "failed",
      "Could not reach the server to read this request. Check your connection and reload.",
    );
  });

  if (!response.ok) {
    throw await failureFor(response, "Could not read this connection request.");
  }

  const preview = parseEnrollmentPreview(await response.json().catch(() => null));
  if (preview === null) {
    throw new DeviceEnrollmentError(
      "failed",
      "The server described this request in a way this app does not understand. Reload, and update the app if it keeps happening.",
    );
  }
  return preview;
}

async function decide(code: string, suffix: "/approve" | "/deny"): Promise<void> {
  const response = await fetch(enrollmentUrl(code, suffix), {
    credentials: "include",
    method: "POST",
  }).catch(() => {
    throw new DeviceEnrollmentError(
      "failed",
      "Could not reach the server. Nothing was decided — try again.",
    );
  });

  if (!response.ok) {
    throw await failureFor(
      response,
      suffix === "/approve"
        ? "Could not connect that machine."
        : "Could not turn that request down.",
    );
  }
}

/**
 * Say yes, as whoever this browser is signed in as.
 *
 * The account is the server's to read from the session and is never sent from
 * here, which is what stops a code from being usable by anyone who merely holds
 * it: holding it gets you this page, and nothing else.
 */
export function approveDeviceEnrollment(code: string): Promise<void> {
  return decide(code, "/approve");
}

export function denyDeviceEnrollment(code: string): Promise<void> {
  return decide(code, "/deny");
}

/** The code out of the address bar, and null when there is nothing to read. */
export function readDeviceEnrollmentCodeFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get(DEVICE_ENROLLMENT_CODE_PARAM)?.trim() ?? "";
  return code.length > 0 ? code : null;
}
