import { describe, expect, it } from "vitest";

import { parseSsRows, ssRowPid, ssRowProcessName } from "./ssOutput.ts";

/**
 * The rows below are copied out of real `ss` output, spacing included, because
 * every bug this module has ever had came from column alignment rather than
 * from the fields themselves.
 */
const LISTING = [
  'LISTEN 0      4096   127.0.0.1:3773       0.0.0.0:*    users:(("bun",pid=1042,fd=21))',
  'LISTEN 0      511      0.0.0.0:80          0.0.0.0:*    users:(("apache2",pid=812,fd=4))',
  'LISTEN 0      4096        [::]:22             [::]:*    users:(("sshd",pid=655,fd=4))',
].join("\n");

describe("parseSsRows", () => {
  it("takes the local address and leaves the peer column alone", () => {
    // The trap the whole module exists for: the peer column is `0.0.0.0:*` on
    // every listening row, so anything that scans a row for something
    // port-shaped finds a match on a box that is merely running something.
    expect(parseSsRows(LISTING).map((row) => row.local)).toEqual([
      "127.0.0.1:3773",
      "0.0.0.0:80",
      "[::]:22",
    ]);
  });

  it("keeps the address exactly as ss printed it", () => {
    // Normalisation belongs to the caller, and the two callers need different
    // ones. Folding `[::]` into anything here would take that choice away.
    expect(parseSsRows(LISTING)[2]?.local).toBe("[::]:22");
  });

  it("carries the process column and nothing before it", () => {
    expect(parseSsRows(LISTING)[0]?.users).toBe('users:(("bun",pid=1042,fd=21))');
  });

  it("reports an empty process column rather than dropping the row", () => {
    // `ss` without `-p`, or with `-p` and no privilege. The socket is still
    // there; only its holder is unknown, and that is an answer.
    const rows = parseSsRows("LISTEN 0 4096 0.0.0.0:3773 0.0.0.0:*");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.users).toBe("");
  });

  it("marks an UNCONN row, which is how this output spells UDP", () => {
    const rows = parseSsRows('UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:(("dhclient",pid=5,fd=6))');
    expect(rows[0]?.state).toBe("UNCONN");
  });

  it("skips a header row without matching on its wording", () => {
    // `-H` suppresses it on current builds and not on older ones. A header has
    // no state column, which is a cheaper and more durable test than looking
    // for the word "State".
    const rows = parseSsRows(
      ["State  Recv-Q Send-Q Local Address:Port  Peer Address:Port", "", LISTING].join("\n"),
    );
    expect(rows).toHaveLength(3);
  });

  it("survives a leading Netid column by locating the state rather than counting", () => {
    // `ss` prints Netid first when it is not filtered to one protocol, which
    // shifts every column right by one.
    const rows = parseSsRows(
      'tcp   LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))',
    );
    expect(rows[0]?.local).toBe("0.0.0.0:80");
    expect(rows[0]?.users).toBe('users:(("nginx",pid=812,fd=6))');
  });

  it("returns nothing for empty output", () => {
    expect(parseSsRows("")).toEqual([]);
  });
});

describe("ssRowPid", () => {
  it("reads the holding pid", () => {
    expect(ssRowPid('users:(("bun",pid=1042,fd=21))')).toBe(1042);
  });

  it("is null when there is no holder to name", () => {
    expect(ssRowPid("")).toBeNull();
  });

  it("refuses pid 0, which is not a process anybody started", () => {
    expect(ssRowPid('users:(("weird",pid=0,fd=1))')).toBeNull();
  });
});

describe("ssRowProcessName", () => {
  it("reads the holding process's name", () => {
    expect(ssRowProcessName('users:(("apache2",pid=812,fd=4))')).toBe("apache2");
  });

  it("is null when there is no holder to name", () => {
    expect(ssRowProcessName("")).toBeNull();
  });
});
