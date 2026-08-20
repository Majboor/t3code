import { formatExpiresInLabel } from "~/timestampFormat";

/**
 * Everything the machine-approval page decides without asking the server.
 *
 * The page's job is to let one person answer one question — "is this my
 * machine?" — and the only thing that makes that question answerable is the
 * detail printed next to it. So the naming of a machine and the advice for
 * every state it can be found in live here, stated once and testable, rather
 * than scattered through JSX where a state gets forgotten and falls through to
 * whatever the last branch happened to say.
 *
 * @module DeviceEnrollment
 */

/** Mirrors `EnrollmentStatus` in `apps/server/src/deviceEnrollment/decideEnrollment.ts`. */
export type EnrollmentStatus = "pending" | "approved" | "collected" | "denied" | "expired";

/**
 * The statuses, plus the one answer that is not a status: a code the server has
 * never heard of. It is separate because the advice is different — every status
 * describes something that happened to a real request, and this one says the
 * request is not there at all.
 */
export type EnrollmentOutcome = EnrollmentStatus | "unknown-code";

export interface EnrollmentPreview {
  readonly status: EnrollmentStatus;
  readonly deviceLabel: string | null;
  readonly devicePlatform: string | null;
  readonly requestedIp: string | null;
  /** Epoch millis, as the enrollment API returns it. */
  readonly expiresAtMs: number;
}

export type EnrollmentTone = "decide" | "positive" | "warning" | "dead";

export interface EnrollmentAdvice {
  readonly tone: EnrollmentTone;
  /** One line, in the heading slot. */
  readonly title: string;
  /** What is true right now. */
  readonly detail: string;
  /** What to do about it. Different for every outcome, because it is. */
  readonly advice: string;
  /** Whether Connect can still do anything. */
  readonly canApprove: boolean;
  /**
   * Whether Deny can still do anything.
   *
   * True for `approved` as well as `pending`, and that is deliberate rather
   * than generous: the server lets a denial land on an approved-but-uncollected
   * request, so a person who finds a machine already approved and does not
   * recognise it can still stop it before it takes its session. Hiding the
   * button would take away the only useful thing left to do.
   */
  readonly canDeny: boolean;
}

/**
 * What to say about a request, for each state it can be found in.
 *
 * Each answer names a different next step, because they are different
 * situations. "This expired, start again on the machine" is a shrug; "somebody
 * already approved this" is worth a second look at who has your password.
 */
export function describeEnrollmentOutcome(outcome: EnrollmentOutcome): EnrollmentAdvice {
  switch (outcome) {
    case "pending":
      return {
        tone: "decide",
        title: "Connect this machine?",
        detail:
          "A machine asked to join your account and is waiting on your answer. Approving it gives it a session that can open your projects, run commands in them, and read anything they can reach.",
        advice:
          "Connect it only if the details below are the machine in front of you. If you did not just start the app somewhere, deny it — nothing is granted until you press a button.",
        canApprove: true,
        canDeny: true,
      };
    case "approved":
      return {
        tone: "warning",
        title: "This request was already approved",
        detail:
          "Somebody has already said yes to this code — you in another tab, or anyone else signed in to this account. The machine has not picked up its session yet.",
        advice:
          "If that was you, there is nothing left to do: the machine will connect on its own within a few seconds. If it was not, deny it now — a session that has not been collected can still be stopped.",
        canApprove: false,
        canDeny: true,
      };
    case "collected":
      return {
        tone: "positive",
        title: "This machine is already connected",
        detail:
          "The request was approved and the machine has taken its session. A code can only be handed over once, so this link has done its work and cannot do anything else.",
        advice:
          "If you do not recognise the machine, do not come back here — the code is spent. Revoke its session under Settings → Connections, which is the only thing that actually cuts it off.",
        canApprove: false,
        canDeny: false,
      };
    case "denied":
      return {
        tone: "dead",
        title: "This request was turned down",
        detail:
          "Somebody denied this code, and a denial is final — the same code cannot be approved afterwards, or refusing it would have meant nothing.",
        advice:
          "If the refusal was a mistake, start again on the machine: launch the app and ask to connect, which makes a fresh request for you to approve.",
        canApprove: false,
        canDeny: false,
      };
    case "expired":
      return {
        tone: "dead",
        title: "This request has expired",
        detail:
          "Requests are deliberately short-lived, so a code left in a chat log or a browser tab stops being worth anything within minutes. Nobody approved or denied this one in time.",
        advice:
          "Start again on the machine: launch the app and ask to connect. It makes a new code and opens this page again.",
        canApprove: false,
        canDeny: false,
      };
    case "unknown-code":
      return {
        tone: "dead",
        title: "We do not recognise this code",
        detail:
          "There is no request with this code. Usually the link was cut short on its way here — copied out of a terminal that wrapped it, or pasted without its last few characters.",
        advice:
          "Rather than retyping it, start again on the machine: launch the app and ask to connect, and let it open this page itself.",
        canApprove: false,
        canDeny: false,
      };
  }
}

/**
 * What to call a machine that did not tell us its name.
 *
 * Never an empty row. A blank where the name should be reads as a page that
 * failed to load, and a person shrugs and approves anyway; "an unnamed machine"
 * is a fact about the request, and a slightly alarming one.
 */
export function describeMachineLabel(label: string | null | undefined): string {
  const trimmed = label?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "an unnamed machine";
}

/**
 * The platform in the words a person uses, not the words Node uses. Anything
 * unrecognised is shown as it arrived rather than dropped — an odd string is
 * still evidence about what is asking.
 */
export function describeDevicePlatform(platform: string | null | undefined): string {
  const trimmed = platform?.trim() ?? "";
  if (trimmed.length === 0) {
    return "Platform not reported";
  }
  switch (trimmed.toLowerCase()) {
    case "darwin":
    case "mac":
    case "macos":
      return "macOS";
    case "win32":
    case "win":
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return trimmed;
  }
}

/** The address the request came from, or an honest note that we do not have it. */
export function describeRequestedIp(ip: string | null | undefined): string {
  const trimmed = ip?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Address not recorded";
}

/**
 * How long the request has left, from epoch millis rather than an ISO string.
 *
 * A missing or unparseable deadline says so instead of rendering "Expired" — we
 * do not know that it has, and telling somebody to start over when the request
 * is still live wastes a trip to the other machine.
 */
export function formatEnrollmentTimeLeft(expiresAtMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(expiresAtMs)) {
    return "Expiry unknown";
  }
  return formatExpiresInLabel(new Date(expiresAtMs).toISOString(), nowMs);
}

/**
 * Whether a preview that says `pending` has quietly run out while this page was
 * open.
 *
 * Asked of the deadline rather than the status for the same reason the server
 * asks it that way: nothing sweeps expired requests, so a row sits at `pending`
 * long after it stopped being usable. A page that trusts the status offers a
 * Connect button that the server will refuse.
 */
export function readEnrollmentOutcome(
  preview: EnrollmentPreview,
  nowMs: number = Date.now(),
): EnrollmentOutcome {
  if (
    preview.status === "pending" &&
    Number.isFinite(preview.expiresAtMs) &&
    nowMs >= preview.expiresAtMs
  ) {
    return "expired";
  }
  return preview.status;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ENROLLMENT_STATUSES: ReadonlySet<string> = new Set<EnrollmentStatus>([
  "pending",
  "approved",
  "collected",
  "denied",
  "expired",
]);

/**
 * Reads the preview reply into the shape the page draws, or returns null when
 * it is not one.
 *
 * Defensive about the three descriptive fields because they are nullable on the
 * server — unknown is a better answer than refusing to enroll — and strict
 * about the status, because a status this build does not know is not something
 * to render an approval button next to.
 */
export function parseEnrollmentPreview(raw: unknown): EnrollmentPreview | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const status = source["status"];
  if (typeof status !== "string" || !ENROLLMENT_STATUSES.has(status)) {
    return null;
  }
  const expiresAtMs = source["expiresAtMs"];
  return {
    status: status as EnrollmentStatus,
    deviceLabel: readString(source, "deviceLabel"),
    devicePlatform: readString(source, "devicePlatform"),
    requestedIp: readString(source, "requestedIp"),
    expiresAtMs: typeof expiresAtMs === "number" ? expiresAtMs : Number.NaN,
  };
}
