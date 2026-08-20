/**
 * The wire shapes of the device-enrollment endpoints, and total decoders for them.
 *
 * Everything crossing the network is decoded rather than cast. This is the one
 * flow in the desktop app where the main process holds an account credential,
 * and it runs before there is any UI to complain to — so a response that does
 * not look the way it should has to become a visible failure with a retry
 * button, never a thrown exception during startup or a `spinner` waiting on a
 * field that was never there.
 *
 * The decoders are deliberately permissive about *extra* fields and strict about
 * the ones they read. The server side of this contract is being written
 * alongside it; tolerating additions is what stops the two from having to land
 * in the same commit, while refusing a missing code or an empty credential is
 * what stops a half-built response from being stored as a session.
 *
 * @module DeviceEnrollment
 */

/** Mirrors `apps/server/src/deviceEnrollment/decideEnrollment.ts`. */
export type EnrollmentStatus = "pending" | "approved" | "collected" | "denied" | "expired";

const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  "pending",
  "approved",
  "collected",
  "denied",
  "expired",
];

/** `POST /api/devices/enrollments` → `201`. */
export interface CreatedEnrollment {
  readonly code: string;
  readonly expiresAtMs: number;
  readonly approveUrl: string;
}

/** `GET /api/devices/enrollments/:code`. */
export interface EnrollmentSnapshot {
  readonly status: EnrollmentStatus;
  readonly deviceLabel: string | null;
  readonly devicePlatform: string | null;
  readonly requestedIp: string | null;
  readonly expiresAtMs: number | null;
}

/**
 * `POST /api/devices/enrollments/:code/collect` → the session credential.
 *
 * Only the credential itself is required. The rest describes where to point it,
 * and every one of those has a sane local answer if the server does not say —
 * whereas a missing credential means there is nothing to store and the flow has
 * not actually succeeded, however encouraging the status code was.
 */
export interface CollectedEnrollment {
  readonly sessionToken: string;
  readonly environmentId: string | null;
  readonly label: string | null;
  readonly httpBaseUrl: string | null;
  readonly wsBaseUrl: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Epoch millis, accepted as a number or as the string a JSON encoder that fears
 * large integers might produce. Rejected when it is not finite: `NaN` compared
 * against a clock is false in both directions, which would make an enrollment
 * that can neither expire nor be used.
 */
function asEpochMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asEnrollmentStatus(value: unknown): EnrollmentStatus | null {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ENROLLMENT_STATUSES.find((status) => status === candidate) ?? null;
}

/**
 * Only `http(s)` URLs are accepted for the approval page.
 *
 * This string is handed to `shell.openExternal`, which will hand anything it is
 * given to the operating system — including `file:` and whatever custom scheme
 * some other installed application registered. A compromised or simply wrong
 * server response must not become arbitrary local launch.
 */
export function asExternalHttpUrl(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function decodeCreatedEnrollment(value: unknown): CreatedEnrollment | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const code = asNonEmptyString(record.code);
  const expiresAtMs = asEpochMs(record.expiresAtMs);
  const approveUrl = asExternalHttpUrl(record.approveUrl);
  if (!code || expiresAtMs === null || !approveUrl) {
    return null;
  }

  return { code, expiresAtMs, approveUrl };
}

export function decodeEnrollmentSnapshot(value: unknown): EnrollmentSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const status = asEnrollmentStatus(record.status);
  if (!status) {
    return null;
  }

  return {
    status,
    deviceLabel: asNonEmptyString(record.deviceLabel),
    devicePlatform: asNonEmptyString(record.devicePlatform),
    requestedIp: asNonEmptyString(record.requestedIp),
    expiresAtMs: asEpochMs(record.expiresAtMs),
  };
}

/**
 * Reads the credential out of a collect response.
 *
 * `sessionToken` is the name the rest of this codebase already uses for a bearer
 * session (`AuthBearerBootstrapResult`), so it is read first. The aliases exist
 * because this decoder was written against a route that did not exist yet;
 * accepting the obvious synonyms costs three lines and removes a class of
 * "connected successfully, stored nothing" bug that would only show up as a
 * mysterious signed-out app on the next launch.
 */
export function decodeCollectedEnrollment(value: unknown): CollectedEnrollment | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const sessionToken =
    asNonEmptyString(record.sessionToken) ??
    asNonEmptyString(record.credential) ??
    asNonEmptyString(record.bearerToken) ??
    asNonEmptyString(record.token);
  if (!sessionToken) {
    return null;
  }

  return {
    sessionToken,
    environmentId: asNonEmptyString(record.environmentId),
    label: asNonEmptyString(record.label),
    httpBaseUrl: asExternalHttpUrl(record.httpBaseUrl),
    wsBaseUrl: asNonEmptyString(record.wsBaseUrl),
  };
}
