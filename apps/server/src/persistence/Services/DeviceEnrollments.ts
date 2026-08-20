import * as Crypto from "node:crypto";

import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type {
  EnrollmentAction,
  EnrollmentRejection,
  EnrollmentStatus,
} from "../../deviceEnrollment/decideEnrollment.ts";
import type { DeviceEnrollmentRepositoryError } from "../Errors.ts";

/**
 * Bytes of entropy behind an enrollment code.
 *
 * This is not an identifier, it is the only thing standing between a stranger
 * and a session on somebody's account: whoever presents the code at
 * `/collect` after approval gets handed a credential. 32 bytes is 256 bits,
 * which puts an offline or online search past any budget, and matches what a
 * share link already uses for the same reason. A uuid would be 122 bits with
 * published structure, and — worse — would look like every other id in the
 * logs and get treated as safe to print.
 */
const DEVICE_ENROLLMENT_CODE_BYTES = 32;

/**
 * base64url, so the code survives the URL it is about to be pasted into.
 *
 * The approve link is `/connect?code=<code>`; percent-encoding would turn one
 * character into three in an address bar a person may be reading off a second
 * screen, and would put a decode step between the URL and a primary-key probe.
 *
 * `Crypto.randomBytes` and nothing else — the same call the pairing
 * credentials and share tokens make. Not `Math.random`, not a uuid, not a hash
 * of anything the caller already knows.
 */
export function generateDeviceEnrollmentCode(): string {
  return Crypto.randomBytes(DEVICE_ENROLLMENT_CODE_BYTES).toString("base64url");
}

/**
 * What actually gets stored, and the only thing a lookup compares.
 *
 * Plain SHA-256 with no salt and no stretching, deliberately: the input is 256
 * bits of uniform randomness, so there is no dictionary to build and nothing a
 * work factor would buy. What it does buy is that a database somebody can read
 * — a backup, a support session, an operator with `sqlite3` — contains no
 * working codes for machines still waiting to be approved.
 *
 * Hex rather than base64url because this value is a primary key that gets
 * compared for equality forever, and one canonical spelling per digest is
 * worth more here than eleven saved characters.
 */
export function hashDeviceEnrollmentCode(code: string): string {
  return Crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * One enrollment row, in primitives only — the same reasoning as
 * `Services/ShareLinks.ts`.
 *
 * `status` stays `Schema.String` rather than the `EnrollmentStatus` union that
 * `decideEnrollment` speaks, because a decode failure on read is far worse than
 * a mismatch above it: a newer binary that learns a fifth state would write
 * rows this one refuses to load, and the refusal would land on the
 * unauthenticated preview route as a hard 500 for a caller who did nothing
 * wrong. The repository narrows on the way into the state machine instead, and
 * fails closed when it cannot.
 *
 * The code itself is absent by construction. Nothing that reads a row can leak
 * a credential, because no row has ever held one.
 */
export const DeviceEnrollmentRecord = Schema.Struct({
  codeHash: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  /** Epoch millis, so expiry is an integer comparison and never a string one. */
  expiresAtMs: Schema.Number,
  approvedAt: Schema.NullOr(Schema.String),
  approvedByUserId: Schema.NullOr(Schema.String),
  /** The approver's session subject; see migration 058 for why both are kept. */
  approvedBySubject: Schema.NullOr(Schema.String),
  approvedByRole: Schema.NullOr(Schema.String),
  /**
   * What the approver said this machine is *for* — see migration 062. A plain
   * string and not the `MachineRole` union, for the reason `status` above is
   * one: a row written by a binary that knows a third role must still load
   * here. `resolveMachineRole` narrows it, and narrows anything it does not
   * recognise to the role that asks for a provider account.
   */
  machineRole: Schema.NullOr(Schema.String),
  collectedAt: Schema.NullOr(Schema.String),
  deviceLabel: Schema.NullOr(Schema.String),
  devicePlatform: Schema.NullOr(Schema.String),
  requestedIp: Schema.NullOr(Schema.String),
});
export type DeviceEnrollmentRecord = typeof DeviceEnrollmentRecord.Type;

export const CreateDeviceEnrollmentInput = Schema.Struct({
  createdAt: Schema.String,
  expiresAtMs: Schema.Number,
  deviceLabel: Schema.NullOr(Schema.String),
  devicePlatform: Schema.NullOr(Schema.String),
  requestedIp: Schema.NullOr(Schema.String),
});
export type CreateDeviceEnrollmentInput = typeof CreateDeviceEnrollmentInput.Type;

/**
 * The one moment the raw code exists outside the caller's machine.
 *
 * Returned, never stored and never returned again: every later read of this
 * enrollment goes through `codeHash`. A caller that loses it has to start a new
 * enrollment, which is the correct outcome — the alternative is a route that
 * can re-issue a credential to whoever asks.
 */
export interface CreatedDeviceEnrollment {
  readonly code: string;
  readonly codeHash: string;
  readonly expiresAtMs: number;
}

export const GetDeviceEnrollmentByCodeInput = Schema.Struct({
  code: Schema.String,
});
export type GetDeviceEnrollmentByCodeInput = typeof GetDeviceEnrollmentByCodeInput.Type;

export const ListDeviceEnrollmentsApprovedByInput = Schema.Struct({
  approvedByUserId: Schema.String,
});
export type ListDeviceEnrollmentsApprovedByInput = typeof ListDeviceEnrollmentsApprovedByInput.Type;

/**
 * An action to apply, with time and identity supplied by the caller.
 *
 * `nowMs` is an input rather than something the repository reads, because
 * `decideEnrollment` was written to be tested against explicit clocks and the
 * repository has no business introducing a second, hidden one.
 */
export interface ApplyDeviceEnrollmentTransitionInput {
  readonly code: string;
  readonly action: EnrollmentAction;
  readonly nowMs: number;
  /** ISO, for the `approved_at` / `collected_at` columns, which are text. */
  readonly nowIso: string;
  /** Who approved, in both the forms the rest of the system needs. Approve only. */
  readonly approvedByUserId?: string;
  readonly approvedBySubject?: string;
  readonly approvedByRole?: string;
  /**
   * What the machine is for, as the approver answered it. Approve only, and
   * omitted means the question was not answered — which is `workspace-host`,
   * because that is what every machine connected before the question existed
   * is. The column is left `NULL` rather than filled in with that default, so
   * "not asked" stays distinguishable from "asked, and they chose the host".
   */
  readonly machineRole?: string;
}

/**
 * `not-found` is separate from every rejection on purpose.
 *
 * A code that was never issued and a code that has already been collected are
 * different facts, and only the caller can decide whether to tell them apart —
 * the HTTP layer above deliberately does not.
 */
export type DeviceEnrollmentTransition =
  | { readonly outcome: "not-found" }
  | { readonly outcome: "accept"; readonly record: DeviceEnrollmentRecord }
  | { readonly outcome: "reject"; readonly reason: EnrollmentRejection };

export interface DeviceEnrollmentRepositoryShape {
  /** Mints the code, stores only its digest, and hands the code back once. */
  readonly create: (
    input: CreateDeviceEnrollmentInput,
  ) => Effect.Effect<CreatedDeviceEnrollment, DeviceEnrollmentRepositoryError>;
  readonly getByCode: (
    input: GetDeviceEnrollmentByCodeInput,
  ) => Effect.Effect<Option.Option<DeviceEnrollmentRecord>, DeviceEnrollmentRepositoryError>;
  /**
   * Applies an action by asking `decideEnrollment` and writing what it says.
   * The rules are not restated here, and must never be: a second copy of them
   * is a second answer to "may this machine in".
   */
  readonly applyTransition: (
    input: ApplyDeviceEnrollmentTransitionInput,
  ) => Effect.Effect<DeviceEnrollmentTransition, DeviceEnrollmentRepositoryError>;
  readonly listApprovedBy: (
    input: ListDeviceEnrollmentsApprovedByInput,
  ) => Effect.Effect<ReadonlyArray<DeviceEnrollmentRecord>, DeviceEnrollmentRepositoryError>;
}

export class DeviceEnrollmentRepository extends Context.Service<
  DeviceEnrollmentRepository,
  DeviceEnrollmentRepositoryShape
>()("t3/persistence/Services/DeviceEnrollments/DeviceEnrollmentRepository") {}

/**
 * The stored status, narrowed to something the state machine can be asked
 * about, failing closed when it cannot.
 *
 * An unrecognised status is treated as `expired`, which is the only rejection
 * that closes every door without claiming something untrue about a person's
 * intent: `denied` would report a refusal nobody made, and anything else would
 * let an action through on a row this binary does not understand.
 */
export function toEnrollmentStatus(status: string): EnrollmentStatus {
  switch (status) {
    case "pending":
    case "approved":
    case "collected":
    case "denied":
    case "expired":
      return status;
    default:
      return "expired";
  }
}
