/**
 * Reading `ss -lntpH`, once.
 *
 * Two very different callers ask this machine what it is listening on, and both
 * of them run the same command with the same flags: the runtime probe in
 * `apps/server/src/environment/listenerProbe.ts`, which wants every socket so
 * the service registry can say who owns what, and the installer's port-collision
 * rule in `scripts/lib/environment-install.ts`, which wants one question
 * answered before it binds. They disagree about what to *do* with a row and they
 * always will — see below — but they cannot be allowed to disagree about how to
 * read one, because the traps in this output are specific, quiet, and identical
 * for both.
 *
 * The trap that matters: every listening row carries a *peer* column as well as
 * a local one, and on a listener the peer column is `0.0.0.0:*`. It has a colon
 * in it and digits around it, so anything that scans a whole row for something
 * port-shaped reports a collision on every box that has any listener at all.
 * The local address is therefore taken by position — three fields after the
 * state — and nothing else on the line is allowed to contribute an address.
 *
 * What deliberately does *not* live here is normalisation, because the two
 * callers need different normalisations and each one is pinned by its own
 * downstream rule:
 *
 *   - the probe folds `*`, `[::]` and `::` into `0.0.0.0`, because
 *     `@t3tools/shared/serviceRegistry` ranks addresses by exposure and three
 *     spellings of "reachable from anywhere" would be three bugs;
 *   - the installer keeps `::` as `ss` printed it, because its wildcard set is
 *     the `bind(2)` collision rule and because the awk in
 *     `infra/install/t3-environment.sh` — which is the copy that actually runs
 *     on a bare VPS, where no runtime exists to import any of this — prints the
 *     address the same way.
 *
 * So: lexing is a fact about the tool and is shared; normalisation is policy and
 * stays with the policy. The shell's third copy of the lexing cannot import
 * anything, and is held to this one by an executing drift check in
 * `scripts/lib/environment-install.test.ts` rather than by a comment.
 *
 * @module SsOutput
 */

/** `-lntpH` only ever prints `LISTEN`; `UNCONN` is how the same output spells UDP. */
export type SsSocketState = "LISTEN" | "UNCONN";

/** One row of `ss` output, split but not yet interpreted. */
export interface SsRow {
  readonly state: SsSocketState;
  /** The local address column, exactly as `ss` printed it. Brackets and all. */
  readonly local: string;
  /**
   * The process column, rejoined, or the empty string when `ss` printed none.
   *
   * Empty is the ordinary case rather than a fault: without `-p`, or with `-p`
   * and no privilege, `ss` simply omits the column. That is a null holder, not a
   * missing row.
   */
  readonly users: string;
}

const PID = /pid=(\d+)/;
const PROCESS_NAME = /\(\("([^"]+)"/;

/**
 * The rows of an `ss` listing, headers and noise dropped.
 *
 * The state column is *located* rather than assumed to be first. `-H` suppresses
 * the header on current builds and not on older ones, and `ss` invoked with a
 * protocol filter prints a leading `Netid` column that shifts everything right
 * by one. Searching for the state and counting from there survives both; a row
 * with no state column at all is a header or a fragment and is dropped, which is
 * how the header is skipped without matching on its text.
 */
export function parseSsRows(stdout: string): ReadonlyArray<SsRow> {
  const rows: Array<SsRow> = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const fields = line.split(/\s+/);
    const stateIndex = fields.findIndex((field) => field === "LISTEN" || field === "UNCONN");
    if (stateIndex === -1) {
      continue;
    }

    const local = fields[stateIndex + 3];
    if (local === undefined) {
      continue;
    }

    rows.push({
      state: fields[stateIndex] === "UNCONN" ? "UNCONN" : "LISTEN",
      local,
      // Everything after the peer column. Taken as a slice rather than as the
      // whole line so that a pid never gets read out of an address.
      users: fields.slice(stateIndex + 5).join(" "),
    });
  }

  return rows;
}

/**
 * The holding pid, or null.
 *
 * Null is an answer and not a gap: `ss` without the privilege to see other
 * users' processes prints no holder, and inventing one is how somebody else's
 * service gets treated as ours.
 */
export function ssRowPid(users: string): number | null {
  const match = PID.exec(users);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The holding process's name, or null on the same terms as `ssRowPid`. */
export function ssRowProcessName(users: string): string | null {
  const match = PROCESS_NAME.exec(users);
  return match === null ? null : (match[1] ?? null);
}
