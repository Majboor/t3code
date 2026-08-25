import { describe, expect, it } from "vitest";

import { isSoleOccupantSession, DESKTOP_BOOTSTRAP_SUBJECT } from "./Services/ServerAuth.ts";

const session = (subject: string) =>
  ({ subject, sessionId: "s", role: "client" }) as Parameters<typeof isSoleOccupantSession>[0];

const desktop = { workspaceSource: "this-server", publishedBeyondLoopback: false } as const;

describe("isSoleOccupantSession", () => {
  it("treats the bootstrap owner as the owner wherever it runs", () => {
    expect(isSoleOccupantSession(session(DESKTOP_BOOTSTRAP_SUBJECT), desktop)).toBe(true);
    expect(
      isSoleOccupantSession(session(DESKTOP_BOOTSTRAP_SUBJECT), {
        workspaceSource: "paired-environment",
        publishedBeyondLoopback: true,
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
      }),
    ).toBe(false);
  });

  it("refuses a signed-up account, which is a guest even on this machine", () => {
    expect(isSoleOccupantSession(session("supabase:abc"), desktop)).toBe(false);
  });
});
