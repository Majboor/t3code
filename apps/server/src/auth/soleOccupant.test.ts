import { describe, expect, it } from "vitest";

import { isSoleOccupantSession, DESKTOP_BOOTSTRAP_SUBJECT } from "./Services/ServerAuth.ts";

const session = (subject: string) =>
  ({ subject, sessionId: "s", role: "client" }) as Parameters<typeof isSoleOccupantSession>[0];

const desktop = {
  workspaceSource: "this-server",
  publishedBeyondLoopback: false,
  localAccountCount: 1,
} as const;

describe("isSoleOccupantSession", () => {
  it("treats the bootstrap owner as the owner wherever it runs", () => {
    expect(isSoleOccupantSession(session(DESKTOP_BOOTSTRAP_SUBJECT), desktop)).toBe(true);
    expect(
      isSoleOccupantSession(session(DESKTOP_BOOTSTRAP_SUBJECT), {
        workspaceSource: "paired-environment",
        publishedBeyondLoopback: true,
        localAccountCount: 12,
      }),
    ).toBe(true);
  });

  it("counts a local account on a desktop install as the owner", () => {
    expect(isSoleOccupantSession(session("local-user:local:abc"), desktop)).toBe(true);
  });

  // The two that matter: either one alone would hand a stranger the machine.
  it("refuses once anything in front of the server carries strangers here", () => {
    expect(
      isSoleOccupantSession(session("local-user:local:abc"), {
        ...desktop,
        publishedBeyondLoopback: true,
      }),
    ).toBe(false);
  });

  it("refuses on a server that only holds accounts", () => {
    expect(
      isSoleOccupantSession(session("local-user:local:abc"), {
        workspaceSource: "paired-environment",
        publishedBeyondLoopback: false,
        localAccountCount: 1,
      }),
    ).toBe(false);
  });

  it("refuses a signed-up account, which is a guest even on this machine", () => {
    expect(isSoleOccupantSession(session("supabase:abc"), desktop)).toBe(false);
  });

  // The case the predicate used to get wrong, and the reason it now asks how
  // many accounts exist. `publishedBeyondLoopback` is false by default, so on
  // an ordinary dev server with local password auth BOTH of these accounts
  // read as the machine's owner: tenant filtering skipped, permission checks
  // returning immediately, and each of them seeing and writing the other's
  // projects.
  it("refuses every local account once a second one can sign in", () => {
    const shared = { ...desktop, localAccountCount: 2 } as const;
    expect(isSoleOccupantSession(session("local-user:local:abc"), shared)).toBe(false);
    expect(isSoleOccupantSession(session("local-user:local:def"), shared)).toBe(false);
  });

  // An unreadable count arrives here as Infinity from both call sites. It has
  // to land on "guest": the alternative is that a failing database promotes
  // whoever asks next to the owner of every path on the machine.
  it("refuses when the account count could not be read", () => {
    expect(
      isSoleOccupantSession(session("local-user:local:abc"), {
        ...desktop,
        localAccountCount: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  // The allowance this whole predicate exists for must survive the new check:
  // one person on their own desktop is still the owner of their own machine.
  it("still treats the lone desktop account as the owner", () => {
    expect(
      isSoleOccupantSession(session("local-user:local:abc"), {
        ...desktop,
        localAccountCount: 1,
      }),
    ).toBe(true);
  });
});
