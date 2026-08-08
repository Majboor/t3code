/**
 * One envelope, whichever way it went.
 *
 * JSON is the default because the caller is a program: it gets the same
 * top-level shape for a hit, a miss and a crash, so it never has to parse prose
 * to find out which happened. In JSON mode both outcomes go to stdout, since an
 * agent that only reads stdout must still see the failure; in `--human` mode the
 * failure goes to stderr, where a person's shell expects it.
 *
 * @module output
 */
import type { CommandOutcome } from "./commands.ts";
import type { PackCliError } from "./errors.ts";

export interface RenderedOutput {
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly exitCode: number;
}

export function renderSuccess(
  command: string,
  outcome: CommandOutcome,
  human: boolean,
): RenderedOutput {
  return {
    stdout: human
      ? outcome.human
      : JSON.stringify({ ok: true, command, result: outcome.result }, null, 2),
    stderr: undefined,
    exitCode: 0,
  };
}

export function renderFailure(
  command: string,
  error: PackCliError,
  human: boolean,
): RenderedOutput {
  const body = {
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    },
  };
  return human
    ? { stdout: undefined, stderr: `${error.code}: ${error.message}`, exitCode: error.exitCode }
    : { stdout: JSON.stringify(body, null, 2), stderr: undefined, exitCode: error.exitCode };
}
