import { describe, expect, it } from "vitest";

import {
  describeAccountMachine,
  describeDisconnectConfirmation,
  describeMachineRole,
  formatMachineLastSeen,
  parseAccountMachines,
  sortAccountMachines,
  type AccountMachine,
} from "./accountMachines.logic";

const machine = (overrides: Partial<AccountMachine> = {}): AccountMachine => ({
  machineId: "machine-1",
  label: "Ana's MacBook",
  platform: "macos",
  role: "workspace-host",
  firstSeenAt: "2026-08-01T10:00:00.000Z",
  lastSeenAt: "2026-08-16T10:00:00.000Z",
  current: false,
  ...overrides,
});

describe("parseAccountMachines", () => {
  it("keeps a machine that reported nothing about itself", () => {
    // The most interesting row on the page is a credential nobody can name.
    const parsed = parseAccountMachines({
      machines: [
        {
          machineId: "machine-anon",
          label: null,
          platform: null,
          firstSeenAt: "2026-08-01T10:00:00.000Z",
          lastSeenAt: "2026-08-16T10:00:00.000Z",
          current: false,
        },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.label).toBeNull();
    expect(describeAccountMachine(parsed[0]!).title).toBe("an unnamed machine");
  });

  it("drops only the row it cannot read, never the list", () => {
    const parsed = parseAccountMachines({
      machines: [
        { label: "No id at all", firstSeenAt: "x", lastSeenAt: "y" },
        {
          machineId: "machine-2",
          label: "Ana's MacBook",
          platform: "macos",
          firstSeenAt: "2026-08-01T10:00:00.000Z",
          lastSeenAt: "2026-08-16T10:00:00.000Z",
          current: true,
        },
      ],
    });

    // A person who can see none of their machines cannot disconnect the one
    // they are worried about, so a bad row costs itself and nothing else.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.machineId).toBe("machine-2");
    expect(parsed[0]?.current).toBe(true);
  });

  it("treats a missing or malformed reply as an empty list", () => {
    expect(parseAccountMachines(null)).toEqual([]);
    expect(parseAccountMachines({})).toEqual([]);
    expect(parseAccountMachines({ machines: "nope" })).toEqual([]);
  });

  it("never reports a machine as current on anything but an explicit true", () => {
    const parsed = parseAccountMachines({
      machines: [
        {
          machineId: "machine-3",
          firstSeenAt: "2026-08-01T10:00:00.000Z",
          lastSeenAt: "2026-08-16T10:00:00.000Z",
          current: "yes",
        },
      ],
    });

    // Guessing wrong in this direction hides the Disconnect button on a machine
    // somebody needs to cut off; guessing wrong the other way offers it on the
    // browser they are sitting in. Neither is acceptable, so only `true` counts.
    expect(parsed[0]?.current).toBe(false);
  });

  it("calls a machine a workspace unless the server clearly said runner", () => {
    const parsed = parseAccountMachines({
      machines: [
        // A reply from a server built before roles existed.
        { machineId: "old", firstSeenAt: "a", lastSeenAt: "b" },
        { machineId: "null", role: null, firstSeenAt: "a", lastSeenAt: "b" },
        // A role from a server built after this one.
        { machineId: "future", role: "quantum-toaster", firstSeenAt: "a", lastSeenAt: "b" },
        { machineId: "runner", role: "runner", firstSeenAt: "a", lastSeenAt: "b" },
      ],
    });

    // Only the explicit answer gets the exemption. Everything else lands on the
    // role that is asked for a provider account, which is what every machine on
    // this list was before the field existed.
    expect(parsed.map((entry) => entry.role)).toEqual([
      "workspace-host",
      "workspace-host",
      "workspace-host",
      "runner",
    ]);
  });
});

describe("sortAccountMachines", () => {
  it("puts the current device first, then the most recently seen", () => {
    const sorted = sortAccountMachines([
      machine({ machineId: "old", lastSeenAt: "2026-08-01T10:00:00.000Z" }),
      machine({ machineId: "recent", lastSeenAt: "2026-08-16T10:00:00.000Z" }),
      machine({ machineId: "here", lastSeenAt: "2026-07-01T10:00:00.000Z", current: true }),
    ]);

    // "This device" leads even though it is the stalest, because until somebody
    // knows which row is theirs, every other row is a guess.
    expect(sorted.map((entry) => entry.machineId)).toEqual(["here", "recent", "old"]);
  });

  it("stays stable when two machines were last seen at the same moment", () => {
    const sorted = sortAccountMachines([
      machine({ machineId: "bbb" }),
      machine({ machineId: "aaa" }),
    ]);

    expect(sorted.map((entry) => entry.machineId)).toEqual(["aaa", "bbb"]);
  });
});

describe("formatMachineLastSeen", () => {
  it("says last seen, not active", () => {
    const label = formatMachineLastSeen("2026-08-16T10:00:00.000Z");
    // The server records this on registration and on self-lookup, so it is a
    // floor. "Active" would libel a machine that has been quietly working.
    expect(label.startsWith("Last seen ")).toBe(true);
  });

  it("admits it does not know rather than inventing a time", () => {
    expect(formatMachineLastSeen("not-a-date")).toBe("Last seen at an unknown time");
  });
});

describe("describeDisconnectConfirmation", () => {
  it("names the machine and spells out what cannot be undone", () => {
    const confirmation = describeDisconnectConfirmation(machine());

    expect(confirmation.title).toBe("Disconnect Ana's MacBook (workspace)?");
    expect(confirmation.description).toContain("immediately");
    // The two facts that decide whether somebody presses it: nothing is
    // deleted, and getting back in means approving the machine again.
    expect(confirmation.description).toContain("Nothing on the machine is deleted");
    expect(confirmation.description).toContain("approve it here");
  });

  it("still asks a real question about a machine with no name", () => {
    const confirmation = describeDisconnectConfirmation(machine({ label: null }));

    expect(confirmation.title).toBe("Disconnect an unnamed machine (workspace)?");
    expect(confirmation.description.startsWith("An unnamed machine")).toBe(true);
  });

  it("tells the truth about a runner, which is a different truth", () => {
    const confirmation = describeDisconnectConfirmation(
      machine({ label: "The deploy box", role: "runner" }),
    );

    // Two machines on this list can share a name and a platform and still be a
    // laptop and a deploy box, so the role is in the title where it gets read.
    expect(confirmation.title).toBe("Disconnect The deploy box (runner)?");
    // And the consequence genuinely differs: nothing on a laptop stops, while a
    // runner keeps serving something nobody here can reach any more. Promising
    // "nothing is deleted" here would be answering the wrong worry.
    expect(confirmation.description).toContain("keeps running");
    expect(confirmation.description).not.toContain("Nothing on the machine is deleted");
  });
});

describe("describeMachineRole", () => {
  it("names both roles in words a person did not have to learn", () => {
    expect(describeMachineRole("workspace-host").badge).toBe("Workspace");
    expect(describeMachineRole("runner").badge).toBe("Runner");
  });

  it("says what a runner does not do, which is the whole reason it exists", () => {
    expect(describeMachineRole("runner").detail).toMatch(/no turn executes here/i);
  });
});
