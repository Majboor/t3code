/**
 * What the environment commands print.
 *
 * Kept out of `cli.ts` because the wording *is* the feature here. The agent
 * driving these commands cannot see the machine; everything it will believe
 * about what is running comes from these lines. A row that reads as though the
 * app owns a process it merely observed is how somebody's production API gets
 * restarted, so the ownership word and the evidence behind it are printed on
 * every line rather than summarised in a header.
 *
 * Pure string functions on purpose — every line below is asserted in
 * `cliOutput.test.ts` without a database, a machine, or a process.
 *
 * @module environment/cliOutput
 */
import type {
  EnvironmentService,
  PortClaim,
  PortCheckResult,
  ServiceRegistryListResult,
} from "@t3tools/contracts";

/** The single word a row is scanned by. */
export function ownershipLabel(service: EnvironmentService): string {
  switch (service.ownership) {
    case "ours":
      return "ours";
    case "not-ours":
      return "not ours";
    case "unknown":
      return "UNKNOWN";
  }
}

function whereItListens(service: EnvironmentService): string {
  if (service.state === "not-listening") return "not listening yet";
  if (service.state === "displaced") return "displaced";
  if (service.address === null) return `:${service.port}`;
  return `${service.address}:${service.port}`;
}

export function formatServiceLine(service: EnvironmentService): string {
  const parts = [
    `  ${String(service.port).padEnd(6)}`,
    `${ownershipLabel(service).padEnd(9)}`,
    service.name ?? "(unnamed)",
  ];
  const detail = [
    whereItListens(service),
    service.pid === null ? null : `pid ${service.pid}`,
  ].filter((value): value is string => value !== null);
  return `${parts.join(" ")}  [${detail.join(", ")}]`;
}

/**
 * The list, split into the two things it is a list of.
 *
 * Never one table sorted by port. Sorting them together produces a single
 * column of rows that all look equally actionable, and the reader — a model
 * about to run a command — will act on the shape before it reads the words.
 */
export function formatServiceList(result: ServiceRegistryListResult): string {
  const ours = result.services.filter((service) => service.ownership === "ours");
  // `unknown` is grouped with the strangers on purpose. It is not a weaker
  // "ours", and listing it under the heading that offers a stop command would
  // make it one.
  const others = result.services.filter((service) => service.ownership !== "ours");

  const lines: string[] = [];

  lines.push(`Observed ${result.observedAt} with ${result.probe.tool}.`);
  if (result.probe.limitation.length > 0) {
    lines.push(result.probe.limitation);
  }
  lines.push("");

  lines.push(`Started by T3 (${ours.length}) — these are yours to stop or restart:`);
  if (ours.length === 0) {
    lines.push("  nothing");
  } else {
    for (const service of ours) lines.push(formatServiceLine(service));
  }

  lines.push("");
  lines.push(`Already running here (${others.length}) — NOT yours to stop:`);
  if (others.length === 0) {
    lines.push("  nothing observed");
  } else {
    for (const service of others) {
      lines.push(formatServiceLine(service));
      lines.push(`         ${service.ownershipReason}`);
    }
  }

  if (result.claims.length > 0) {
    lines.push("");
    lines.push(`Reserved, nothing listening yet (${result.claims.length}):`);
    for (const claim of result.claims) {
      lines.push(`  ${String(claim.port).padEnd(6)} ${claim.claimedBy} — ${claim.purpose}`);
    }
  }

  if (others.length > 0) {
    lines.push("");
    lines.push(
      "Nothing in the second list was started by T3. Stopping one of them stops something this workspace has no record of and cannot bring back.",
    );
  }

  return lines.join("\n");
}

export function formatPortCheck(port: number, result: PortCheckResult): string {
  const lines = [result.verdict.headline, result.verdict.suggestion];
  if (!result.verdict.free && result.suggestion !== null) {
    lines.push(
      `${result.suggestion} is free — claim it with: t3 env port claim ${result.suggestion} --purpose "<what for>"`,
    );
  }
  if (result.verdict.free) {
    lines.push(`Claim it with: t3 env port claim ${port} --purpose "<what for>"`);
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

export function formatPortClaimed(claim: PortClaim): string {
  return [
    `Reserved ${claim.port} until ${claim.expiresAt}.`,
    // Said every time. A reservation that outlives its purpose is a port nobody
    // takes for no reason, and the expiry only covers the case where the holder
    // never comes back at all.
    "It lapses on its own, so a crash cannot hold the port for good. Release it with `t3 env port release` if you end up not using it.",
  ].join("\n");
}

export function formatPortRefused(result: PortCheckResult): string {
  const lines = [result.verdict.headline, result.verdict.suggestion];
  if (result.suggestion !== null) {
    lines.push(`${result.suggestion} is free.`);
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

export function formatServiceRegistered(input: {
  readonly name: string;
  readonly port: number;
  readonly pid: number;
}): string {
  return [
    `Recorded ${input.name} on port ${input.port} as pid ${input.pid}.`,
    "T3 will report this as its own until that process exits. If you restart it, register the new pid — the old one stops being ours the moment it dies, and a port match alone will not make the replacement ours.",
  ].join("\n");
}

/** The machine-readable shape, so an agent does not have to parse the prose. */
export function serviceJson(service: EnvironmentService) {
  return {
    port: service.port,
    name: service.name,
    state: service.state,
    ownership: service.ownership,
    ownershipReason: service.ownershipReason,
    pid: service.pid,
    command: service.command,
    address: service.address,
    since: service.since,
    startedBy: service.startedBy,
    managedId: service.managedId,
    canManage: service.canManage,
  };
}
