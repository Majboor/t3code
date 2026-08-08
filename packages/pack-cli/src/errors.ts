/**
 * Every failure leaves through here, so the exit code and the JSON body cannot
 * drift apart: the agent reading stdout and the shell reading `$?` are told the
 * same thing about the same failure.
 *
 * @module errors
 */

export type PackCliErrorCode =
  | "usage"
  | "pack-not-found"
  | "manifest-not-found"
  | "manifest-invalid"
  | "format-version-unsupported"
  | "not-publishable"
  | "version-exists"
  | "registry-unavailable"
  | "io-failed";

/**
 * Distinct exits rather than a blanket 1, because the caller's next move
 * differs per class: a usage error is fixed by rewriting the command, a
 * not-found by widening the search, a not-publishable by editing the pack.
 */
const EXIT_CODES: Record<PackCliErrorCode, number> = {
  usage: 2,
  "pack-not-found": 3,
  "manifest-not-found": 3,
  "manifest-invalid": 4,
  "format-version-unsupported": 4,
  "not-publishable": 5,
  "version-exists": 6,
  "registry-unavailable": 7,
  "io-failed": 7,
};

export class PackCliError extends Error {
  readonly code: PackCliErrorCode;
  /** Machine-readable context: the paths, issues or ids behind the message. */
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: PackCliErrorCode,
    message: string,
    detail?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "PackCliError";
    this.code = code;
    this.detail = detail;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function isPackCliError(cause: unknown): cause is PackCliError {
  return cause instanceof PackCliError;
}

/** Anything thrown from below becomes a structured failure with an exit code. */
export function toPackCliError(cause: unknown): PackCliError {
  if (isPackCliError(cause)) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new PackCliError("io-failed", message);
}
