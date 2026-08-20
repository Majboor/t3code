/**
 * The rules governing a machine joining someone's account.
 *
 * Pure and total, because this is the decision that decides whose laptop ends
 * up inside whose workspace. A mistake here is not a broken screen; it is
 * somebody else's machine holding a session for your projects. Keeping it
 * separate from HTTP means the rules can be stated once and tested exhaustively
 * rather than inferred from the order of checks in a route handler.
 *
 * The flow it describes: the app makes a code and opens the browser. The person
 * is already signed in there, so they approve in a context that already proves
 * who they are — nothing is typed, and no secret travels in the download.
 *
 * @module DeviceEnrollment
 */

/**
 * `collected` is deliberately distinct from `approved`. Approval says a person
 * consented; collection says the credential has been handed over, and it may
 * happen exactly once. Folding them together makes a replayed poll indefinitely
 * re-issue access to whoever asks with the code.
 */
export type EnrollmentStatus = "pending" | "approved" | "collected" | "denied" | "expired";

export interface EnrollmentRecord {
  readonly status: EnrollmentStatus;
  /** Epoch millis. Compared against an explicit `nowMs` so time is an input. */
  readonly expiresAtMs: number;
  /** Set when a person approves; the account the machine will be attached to. */
  readonly approvedByUserId: string | null;
}

export type EnrollmentAction =
  | { readonly type: "approve"; readonly byUserId: string }
  | { readonly type: "deny" }
  | { readonly type: "collect" };

export type EnrollmentDecision =
  | { readonly outcome: "accept"; readonly next: EnrollmentRecord }
  | { readonly outcome: "reject"; readonly reason: EnrollmentRejection };

export type EnrollmentRejection =
  | "expired"
  | "already-approved"
  | "already-collected"
  | "denied"
  | "not-approved";

/**
 * Whether this enrollment has run out of time, evaluated before anything else.
 *
 * Expiry is checked against the record rather than trusted from its status,
 * because nothing sweeps the table on a timer: a row sits at `pending` long
 * after it stopped being usable, and a status-only test would happily approve
 * a code from last week.
 */
function hasExpired(record: EnrollmentRecord, nowMs: number): boolean {
  return nowMs >= record.expiresAtMs;
}

/**
 * Applies an action to an enrollment, or explains why it cannot apply.
 *
 * Every terminal state stays terminal. In particular a denial is never
 * reconsidered — if someone rejects a machine they did not recognise, a second
 * attempt with the same code must not succeed, or the refusal meant nothing.
 */
export function decideEnrollment(input: {
  readonly record: EnrollmentRecord;
  readonly action: EnrollmentAction;
  readonly nowMs: number;
}): EnrollmentDecision {
  const { record, action, nowMs } = input;

  if (record.status === "denied") {
    return { outcome: "reject", reason: "denied" };
  }
  if (record.status === "collected") {
    return { outcome: "reject", reason: "already-collected" };
  }
  if (record.status === "expired" || hasExpired(record, nowMs)) {
    return { outcome: "reject", reason: "expired" };
  }

  switch (action.type) {
    case "approve": {
      // Re-approval is refused rather than ignored. Two approvals mean two
      // people clicked, and the second one is a signal worth surfacing, not a
      // no-op to swallow.
      if (record.status === "approved") {
        return { outcome: "reject", reason: "already-approved" };
      }
      return {
        outcome: "accept",
        next: { ...record, status: "approved", approvedByUserId: action.byUserId },
      };
    }
    case "deny": {
      return {
        outcome: "accept",
        next: { ...record, status: "denied", approvedByUserId: null },
      };
    }
    case "collect": {
      // The polling app reaches here constantly while a person decides. That is
      // not an error, and it must not be recorded as one — it is the ordinary
      // shape of the flow.
      if (record.status !== "approved") {
        return { outcome: "reject", reason: "not-approved" };
      }
      return { outcome: "accept", next: { ...record, status: "collected" } };
    }
  }
}
