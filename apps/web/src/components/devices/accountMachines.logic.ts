import { formatRelativeTimeLabel } from "~/timestampFormat";
import { describeDevicePlatform, describeMachineLabel } from "./deviceEnrollment.logic";

/**
 * What the connected-machines list decides without asking the server.
 *
 * Kept apart from the component for the same reason the approval page's advice
 * is: the wording next to a destructive button is the thing that makes it safe
 * to press, and wording buried in JSX is wording nobody tests. A person about
 * to disconnect a machine is answering "is that the laptop I lost?", and every
 * string here exists to make that answerable.
 *
 * @module AccountMachines
 */

/** Mirrors the reply of `GET /api/devices/machines` on the server. */
export interface AccountMachine {
  readonly machineId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Whether this is the machine reading the page. Never offered a Disconnect. */
  readonly current: boolean;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads one machine out of the reply, or returns null when it is not one.
 *
 * Strict about `machineId` — it is what a Disconnect is aimed at, and aiming at
 * a malformed id is how the wrong device gets cut off — and forgiving about the
 * descriptive fields, which are nullable by design on the server. A machine
 * that reported nothing about itself still belongs on this list: an unnamed
 * machine holding a credential is the most interesting row on the page.
 */
export function parseAccountMachine(raw: unknown): AccountMachine | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const machineId = readString(source, "machineId");
  const firstSeenAt = readString(source, "firstSeenAt");
  const lastSeenAt = readString(source, "lastSeenAt");
  if (machineId === null || firstSeenAt === null || lastSeenAt === null) {
    return null;
  }
  return {
    machineId,
    label: readString(source, "label"),
    platform: readString(source, "platform"),
    firstSeenAt,
    lastSeenAt,
    current: source["current"] === true,
  };
}

/**
 * The list, with anything unreadable dropped rather than the whole reply.
 *
 * One row this build cannot parse should cost that row, not the page: a person
 * who cannot see any of their machines has no way to disconnect the one they
 * are worried about, which is worse than a list that is one short.
 */
export function parseAccountMachines(raw: unknown): ReadonlyArray<AccountMachine> {
  const machines =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["machines"] : null;
  if (!Array.isArray(machines)) {
    return [];
  }
  return machines
    .map((entry) => parseAccountMachine(entry))
    .filter((machine): machine is AccountMachine => machine !== null);
}

/**
 * The current device first, then the rest by how recently they were heard from.
 *
 * "This device" belongs at the top because it is the row a person has to
 * identify before any of the others mean anything — until they know which one
 * they are sitting at, every Disconnect is a guess.
 */
export function sortAccountMachines(
  machines: ReadonlyArray<AccountMachine>,
): ReadonlyArray<AccountMachine> {
  return [...machines].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    const byLastSeen = new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
    return Number.isNaN(byLastSeen) || byLastSeen === 0
      ? left.machineId.localeCompare(right.machineId)
      : byLastSeen;
  });
}

/** The name, the platform, and nothing invented. Reuses the approval page's
 * wording so a machine reads the same on the screen that let it in and the
 * screen that can throw it out. */
export function describeAccountMachine(machine: AccountMachine): {
  readonly title: string;
  readonly detail: string;
} {
  return {
    title: describeMachineLabel(machine.label),
    detail: describeDevicePlatform(machine.platform),
  };
}

/**
 * "Last seen", said honestly.
 *
 * The server records this when a machine registers and when it asks about
 * itself, so it is a floor and not a heartbeat. That is why the label reads
 * "Last seen …" rather than "Active …": a machine that has been quietly running
 * turns all week would be libelled by the second wording, and somebody would
 * disconnect the wrong one on the strength of it.
 */
export function formatMachineLastSeen(lastSeenAt: string): string {
  const parsed = new Date(lastSeenAt);
  if (Number.isNaN(parsed.getTime())) {
    return "Last seen at an unknown time";
  }
  return `Last seen ${formatRelativeTimeLabel(lastSeenAt)}`;
}

/**
 * What the confirmation asks, by name.
 *
 * Naming the machine in the question is the difference between a dialog that
 * makes somebody check and one they click through. The consequence is spelled
 * out because it is not obvious and not undoable: the machine keeps its files,
 * loses its access, and has to be approved again from scratch.
 */
export function describeDisconnectConfirmation(machine: AccountMachine): {
  readonly title: string;
  readonly description: string;
} {
  const name = describeMachineLabel(machine.label);
  return {
    title: `Disconnect ${name}?`,
    description: `${
      name.charAt(0).toUpperCase() + name.slice(1)
    } loses access to this account immediately — its next request is refused, wherever it is. Nothing on the machine is deleted. To use it again, connect it from the machine and approve it here.`,
  };
}
