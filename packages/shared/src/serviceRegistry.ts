/**
 * What is running on a machine, and which of it we are allowed to touch.
 *
 * An agent handed a shell has no idea what the machine is already doing. It
 * picks a port, finds it taken, picks another; or worse, it finds a stale
 * process in its way and kills it — and the process was somebody's production
 * API that had nothing to do with the task. The user's own VPS runs unrelated
 * services next to the ones T3 deploys, and "the agent stopped one of those" is
 * the mistake that is never forgiven.
 *
 * The registry answers that with two facts that look alike and are not:
 *
 * 1. **What we started.** A record written at spawn: this command, this pid,
 *    this port, on somebody's behalf. It is the only thing that licenses the
 *    agent to stop or restart something.
 * 2. **What is listening.** A probe of the machine's sockets. It is a fact about
 *    the world, and says nothing about who owns anything.
 *
 * Merging them is the whole failure. A port match is not identity: our dev
 * server dies, something else binds 3000, and a registry that correlates by port
 * alone now reports somebody else's process as ours and hands the agent
 * permission to kill it. So correlation here is by **process**, and a port that
 * cannot be attributed to a process comes back `unknown` rather than being
 * rounded to whichever answer is convenient. `unknown` never becomes `ours`.
 *
 * Everything is time-swept on read rather than by a timer, for the reason
 * `filePresence` is: the answer is a function of *now*, the server can be
 * restarted or killed between writes, and a "running" that never clears is a
 * worse guide than an empty list. Both ends apply the same deadline — the
 * browser because a page open for an hour would otherwise draw an hour-old
 * claim, the server because it must decide before it lets anything start.
 *
 * @module ServiceRegistry
 */

// ── ports ───────────────────────────────────────────────────────────────────

export const MIN_PORT = 1;
export const MAX_PORT = 65_535;

/** Ports below this need privilege to bind and are almost never ours to take. */
export const PRIVILEGED_PORT_CEILING = 1_024;

export function isPortInRange(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

// ── the two facts ───────────────────────────────────────────────────────────

/**
 * A socket the machine reported as listening.
 *
 * `pid` and `processName` are nullable because they genuinely are unknowable on
 * some machines: `netstat` on macOS will not name the process behind a socket
 * without privilege, a container sees its own namespace only, and the last-resort
 * probe — trying to bind the port — proves a port is taken and nothing else.
 * A null here is the honest answer and must survive all the way to the reader.
 */
export interface ObservedListener {
  readonly port: number;
  /** `127.0.0.1` is reachable only from the machine; `0.0.0.0` / `::` are not. */
  readonly address: string;
  readonly protocol: "tcp" | "udp";
  readonly pid: number | null;
  readonly processName: string | null;
}

/**
 * Something this app started and therefore may manage.
 *
 * `pid` is not optional. A record without one could never be told apart from a
 * port coincidence, which is the confusion this whole module exists to prevent.
 *
 * `heartbeatAt` is refreshed by whoever last confirmed the process still exists,
 * not on a schedule. It is the backstop for the case no in-process supervisor
 * covers: T3 itself was killed, the child outlived it or did not, and on the
 * next read nobody has looked in a while.
 */
export interface ManagedServiceRecord {
  readonly id: string;
  readonly name: string;
  readonly port: number;
  readonly pid: number;
  readonly command: string;
  /** The account that asked for it. Agents run on somebody's behalf, never their own. */
  readonly startedBy: string;
  /** ISO-8601, and the answer to "since when". */
  readonly startedAt: string;
  /** ISO-8601. The last time anything confirmed this process was alive. */
  readonly heartbeatAt: string;
  /** Set when we stopped it on purpose. A stopped record is never live again. */
  readonly stoppedAt: string | null;
}

/**
 * How long a start record outlives the last confirmation of its process.
 *
 * Generous compared to a presence heartbeat because the thing being tracked is
 * meant to run for days: a service nobody has asked about since yesterday is
 * usually still serving. It is a backstop against a registry full of ghosts
 * after a crash, not a liveness check — the liveness check is looking at the pid,
 * and it happens on every read.
 */
export const MANAGED_SERVICE_TTL_MS = 6 * 60 * 60 * 1_000;

/** How long a port reservation stands before it stops meaning anything. */
export const PORT_CLAIM_TTL_MS = 10 * 60 * 1_000;

export interface ServiceRegistryTtl {
  readonly managedMs?: number;
  readonly claimMs?: number;
}

/**
 * A reservation taken before starting something, so two turns racing for the
 * same port collide here instead of in the process table.
 *
 * It carries its own `expiresAt` rather than deriving one from a constant. A
 * claim is a promise about the future made at a particular moment, and the
 * length of that promise belongs to the claim: a build that takes twenty minutes
 * and a dev server that binds in a second should not share a deadline.
 */
export interface PortClaim {
  readonly port: number;
  /** The account holding it. */
  readonly claimedBy: string;
  /** What it is being held for, in words a stranger can act on. */
  readonly purpose: string;
  readonly claimedAt: string;
  /** ISO-8601. A claim with no deadline is a leak, so there is no null here. */
  readonly expiresAt: string;
}

function parsedMs(iso: string): number | null {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/**
 * Whether a start record is still worth believing.
 *
 * An unparseable timestamp is treated as dead rather than live. Everywhere else
 * in this module the safe direction is "we do not own it", and a record we
 * cannot date is a record we cannot vouch for.
 */
export function isManagedServiceLive(
  record: ManagedServiceRecord,
  nowMs: number,
  ttl?: ServiceRegistryTtl,
): boolean {
  if (record.stoppedAt !== null) return false;
  const heartbeat = parsedMs(record.heartbeatAt);
  if (heartbeat === null) return false;
  // A heartbeat slightly in the future is skew between two clocks, not a lie.
  return nowMs - heartbeat <= (ttl?.managedMs ?? MANAGED_SERVICE_TTL_MS);
}

/** The start records still standing, stale ones dropped. */
export function liveManagedServices(
  records: ReadonlyArray<ManagedServiceRecord>,
  nowMs: number,
  ttl?: ServiceRegistryTtl,
): ReadonlyArray<ManagedServiceRecord> {
  return records.filter((record) => isManagedServiceLive(record, nowMs, ttl));
}

export function isPortClaimLive(claim: PortClaim, nowMs: number): boolean {
  const expires = parsedMs(claim.expiresAt);
  if (expires === null) return false;
  return nowMs < expires;
}

/** The reservations still standing, expired ones dropped. */
export function livePortClaims(
  claims: ReadonlyArray<PortClaim>,
  nowMs: number,
): ReadonlyArray<PortClaim> {
  return claims.filter((claim) => isPortClaimLive(claim, nowMs));
}

// ── the reconciled view ─────────────────────────────────────────────────────

/**
 * Who started this.
 *
 * Three values and not two, because the third is the one that keeps the agent
 * honest. `unknown` means the machine would not say which process holds the
 * port; it is not a weaker `not-ours` and it is emphatically not a hedged
 * `ours`. Nothing may be stopped on an `unknown`.
 */
export type ServiceOwnership =
  /** We started this process and it is still that process. */
  | "ours"
  /** A process is here and it is not one we started. */
  | "not-ours"
  /** The machine would not say. Treat as somebody else's. */
  | "unknown";

export type ServiceState =
  /** Something is bound to the port right now. */
  | "listening"
  /** We started something for this port and nothing is listening there yet. */
  | "not-listening"
  /** We started something for this port and a different process holds it. */
  | "displaced";

export interface EnvironmentService {
  readonly port: number;
  /** The name we gave it, else the process name, else nothing worth printing. */
  readonly name: string | null;
  readonly state: ServiceState;
  readonly ownership: ServiceOwnership;
  /**
   * The evidence, in one sentence. Carried rather than recomputed because the
   * reader — a person or an agent about to kill something — needs to see why the
   * verdict is what it is, and "unknown" with no reason invites a guess.
   */
  readonly ownershipReason: string;
  readonly pid: number | null;
  readonly command: string | null;
  readonly address: string | null;
  /** ISO-8601, and only ever for something we started. Nothing else has a start we saw. */
  readonly since: string | null;
  readonly startedBy: string | null;
  readonly managedId: string | null;
  /**
   * Whether stopping or restarting this is permitted. Derived, never stored, and
   * true for exactly one ownership value.
   */
  readonly canManage: boolean;
}

function serviceOf(entry: Omit<EnvironmentService, "canManage">): EnvironmentService {
  return { ...entry, canManage: entry.ownership === "ours" };
}

/**
 * One listener per port and process, so a service bound to both IPv4 and IPv6
 * is one row rather than two.
 *
 * The address kept is the most exposed one: `0.0.0.0` and `127.0.0.1` are very
 * different facts about who can reach a thing, and the reader must not be told
 * the reassuring half of a pair.
 */
function exposureRank(address: string): number {
  if (address === "0.0.0.0" || address === "::" || address === "*") return 0;
  if (address.startsWith("127.") || address === "::1" || address === "localhost") return 2;
  return 1;
}

function dedupeListeners(
  listeners: ReadonlyArray<ObservedListener>,
): ReadonlyArray<ObservedListener> {
  const best = new Map<string, ObservedListener>();
  for (const listener of listeners) {
    const key = `${listener.protocol}:${listener.port}:${listener.pid ?? "?"}`;
    const existing = best.get(key);
    if (!existing || exposureRank(listener.address) < exposureRank(existing.address)) {
      best.set(key, listener);
    }
  }
  return [...best.values()];
}

/** Ours first at a contested port. */
function ownershipRank(service: EnvironmentService): number {
  return service.ownership === "ours" ? 0 : 1;
}

export interface ReconcileEnvironmentInput {
  /** Every start record, live or not; the sweep happens here. */
  readonly managed: ReadonlyArray<ManagedServiceRecord>;
  readonly observed: ReadonlyArray<ObservedListener>;
  readonly nowMs: number;
  /**
   * Whether the probe that produced `observed` is capable of naming processes
   * at all.
   *
   * It changes what a null pid means, and therefore what may be said about a
   * port. From a probe that can see processes, a null pid is one socket the
   * caller lacked privilege for. From a probe that cannot — a bind test, a
   * `netstat` without root — every pid is null and no port anywhere can be
   * attributed. Both end at `unknown`; passing the flag is what stops the
   * second case being mistaken for a machine running nothing of ours.
   */
  readonly processAttribution: boolean;
  readonly ttl?: ServiceRegistryTtl;
}

/**
 * Everything running here, with each row saying how much of it we actually know.
 *
 * The correlation is by pid and never by port. That is the single rule the rest
 * of this file exists to serve: a start record says "we launched pid 4821 to
 * serve 3000", and the only thing that makes the listener on 3000 ours is that
 * it *is* pid 4821. If 3000 answers from pid 9102, we produce two rows — our
 * service, displaced and no longer serving, and a stranger's process that must
 * not be touched — because that is two true statements, and the single merged
 * row a port join would produce is a false one that reads as permission.
 */
export function reconcileEnvironmentServices(
  input: ReconcileEnvironmentInput,
): ReadonlyArray<EnvironmentService> {
  const managed = liveManagedServices(input.managed, input.nowMs, input.ttl);
  const listeners = dedupeListeners(input.observed);
  const ourPids = new Set(managed.map((record) => record.pid));

  const claimedListeners = new Set<ObservedListener>();
  const services: EnvironmentService[] = [];

  for (const record of managed) {
    const onPort = listeners.filter((listener) => listener.port === record.port);
    const mine = onPort.find((listener) => listener.pid === record.pid);

    if (mine) {
      claimedListeners.add(mine);
      services.push(
        serviceOf({
          port: record.port,
          name: record.name,
          state: "listening",
          ownership: "ours",
          ownershipReason: `pid ${record.pid} is the process T3 started for this port.`,
          pid: record.pid,
          command: record.command,
          address: mine.address,
          since: record.startedAt,
          startedBy: record.startedBy,
          managedId: record.id,
        }),
      );
      continue;
    }

    // Something is here, but nothing on this machine will say whether it is the
    // process we started. Our own record is the reason we suspect it is, and a
    // suspicion is not an ownership claim.
    const anonymous = onPort.filter((listener) => listener.pid === null);
    if (anonymous.length > 0) {
      for (const listener of anonymous) claimedListeners.add(listener);
      const first = anonymous[0]!;
      services.push(
        serviceOf({
          port: record.port,
          name: record.name,
          state: "listening",
          ownership: "unknown",
          ownershipReason: input.processAttribution
            ? `Something is listening on ${record.port}, but this machine would not say which process, so it cannot be confirmed as the pid ${record.pid} T3 started.`
            : `Something is listening on ${record.port}. Nothing available here can name the process behind a socket, so this may be the pid ${record.pid} T3 started or whatever replaced it.`,
          pid: null,
          command: record.command,
          address: first.address,
          since: record.startedAt,
          startedBy: record.startedBy,
          managedId: record.id,
        }),
      );
      continue;
    }

    if (onPort.length > 0) {
      // Our process is not the one serving. Both halves get said: the port is
      // somebody else's now, and the thing we started is no longer doing its job.
      services.push(
        serviceOf({
          port: record.port,
          name: record.name,
          state: "displaced",
          ownership: "ours",
          ownershipReason: `T3 started pid ${record.pid} for this port, but another process holds it now.`,
          pid: record.pid,
          command: record.command,
          address: null,
          since: record.startedAt,
          startedBy: record.startedBy,
          managedId: record.id,
        }),
      );
      continue;
    }

    services.push(
      serviceOf({
        port: record.port,
        name: record.name,
        state: "not-listening",
        ownership: "ours",
        ownershipReason: `T3 started pid ${record.pid} for this port; nothing is listening there yet.`,
        pid: record.pid,
        command: record.command,
        address: null,
        since: record.startedAt,
        startedBy: record.startedBy,
        managedId: record.id,
      }),
    );
  }

  for (const listener of listeners) {
    if (claimedListeners.has(listener)) continue;

    const pid = listener.pid;

    if (pid === null) {
      services.push(
        serviceOf({
          port: listener.port,
          name: listener.processName,
          state: "listening",
          ownership: "unknown",
          ownershipReason: input.processAttribution
            ? "This machine would not say which process holds this port."
            : "Nothing available here can name the process behind a socket, so who holds this port is unknown.",
          pid: null,
          command: null,
          address: listener.address,
          // We did not see it start, so we do not know when it did. A first-seen
          // timestamp would read as an age, and be wrong by however long the
          // machine was up before anybody looked.
          since: null,
          startedBy: null,
          managedId: null,
        }),
      );
      continue;
    }

    // A process we started, on a port we did not write down. One command can
    // bind several — a dev server and its HMR socket, an app and its metrics
    // port — and the extra ones are as much ours as the recorded one. The
    // evidence is the same evidence: the pid.
    const owner = ourPids.has(pid) ? managed.find((record) => record.pid === pid) : undefined;
    if (owner) {
      services.push(
        serviceOf({
          port: listener.port,
          name: owner.name,
          state: "listening",
          ownership: "ours",
          ownershipReason: `pid ${pid} is the process T3 started for ${owner.name}, which also listens here.`,
          pid,
          command: owner.command,
          address: listener.address,
          since: owner.startedAt,
          startedBy: owner.startedBy,
          managedId: owner.id,
        }),
      );
      continue;
    }

    // A pid we can see and did not start is not ours. That conclusion rests on
    // our records being complete, and when they are not the error lands on the
    // safe side: we decline to manage something we did in fact start, rather
    // than claiming something we did not.
    services.push(
      serviceOf({
        port: listener.port,
        name: listener.processName,
        state: "listening",
        ownership: "not-ours",
        ownershipReason: `pid ${pid}${listener.processName === null ? "" : ` (${listener.processName})`} holds this port and is not a process T3 started.`,
        pid,
        command: null,
        address: listener.address,
        since: null,
        startedBy: null,
        managedId: null,
      }),
    );
  }

  return services.toSorted((left, right) => {
    if (left.port !== right.port) return left.port - right.port;
    // Ours first at a contested port, so the displaced record is read before the
    // stranger that took its place.
    return ownershipRank(left) - ownershipRank(right);
  });
}

// ── may I have this port ────────────────────────────────────────────────────

export type PortAvailability =
  /** Nothing listening, nothing reserved. */
  | "free"
  /** A listener is here now. */
  | "in-use"
  /** Nothing listening, but somebody else has reserved it. */
  | "claimed"
  /** Nothing listening, and the reservation is the asker's own. */
  | "held"
  /** Not a port. */
  | "out-of-range";

export interface PortVerdict {
  readonly port: number;
  readonly availability: PortAvailability;
  /** Whether starting something here is safe. The one field a caller may branch on. */
  readonly free: boolean;
  readonly headline: string;
  readonly suggestion: string;
  /** What is on the port, when something is. */
  readonly service: EnvironmentService | null;
  readonly claim: PortClaim | null;
}

export interface DecidePortInput {
  readonly port: number;
  /** Already reconciled — this decision does not re-derive ownership. */
  readonly services: ReadonlyArray<EnvironmentService>;
  /** Every claim, live or not; expiry is applied here. */
  readonly claims: ReadonlyArray<PortClaim>;
  readonly nowMs: number;
  /** The account asking, so its own reservation does not read as somebody else's. */
  readonly claimant?: string;
}

/**
 * Whether a port can be taken, and what to say if not.
 *
 * A listener outranks a reservation because it is the stronger fact: a claim is
 * a statement about intent and a bound socket is a statement about the world.
 * Both are reported, but the answer is driven by what is actually there.
 */
export function decidePortAvailability(input: DecidePortInput): PortVerdict {
  const { port } = input;

  if (!isPortInRange(port)) {
    return {
      port,
      availability: "out-of-range",
      free: false,
      headline: `${port} is not a port.`,
      suggestion: `Ports run from ${MIN_PORT} to ${MAX_PORT}.`,
      service: null,
      claim: null,
    };
  }

  const claim = livePortClaims(input.claims, input.nowMs).find((entry) => entry.port === port);
  const occupant = input.services.find(
    (service) => service.port === port && service.state === "listening",
  );

  if (occupant) {
    return {
      port,
      availability: "in-use",
      free: false,
      headline:
        occupant.ownership === "ours"
          ? `${port} is served by ${occupant.name ?? "a service"}, which T3 started.`
          : `${port} is taken by something T3 did not start.`,
      suggestion:
        occupant.ownership === "ours"
          ? "Restart or stop it through T3 if that is what you meant; otherwise pick another port."
          : `${occupant.ownershipReason} Pick another port. Do not stop it — nothing here knows what depends on it.`,
      service: occupant,
      claim: claim ?? null,
    };
  }

  if (claim) {
    const mine = input.claimant !== undefined && claim.claimedBy === input.claimant;
    return {
      port,
      availability: mine ? "held" : "claimed",
      // A reservation you hold yourself is exactly what you asked for, so it is
      // not an obstacle. Somebody else's is.
      free: mine,
      headline: mine
        ? `${port} is reserved for you: ${claim.purpose}.`
        : `${port} is reserved by ${claim.claimedBy}: ${claim.purpose}.`,
      suggestion: mine
        ? "Nothing is listening there yet. Start what you reserved it for."
        : `The reservation lapses at ${claim.expiresAt} if nothing takes it. Pick another port rather than racing for this one.`,
      service: null,
      claim,
    };
  }

  // Nothing here, but a port under 1024 is not free in any useful sense: binding
  // it needs privilege, and the things that live down there are the ones nobody
  // expects to move.
  if (port < PRIVILEGED_PORT_CEILING) {
    return {
      port,
      availability: "free",
      free: true,
      headline: `Nothing is listening on ${port}.`,
      suggestion: `${port} is a privileged port — binding it needs root, and it is usually reserved for a system service. Prefer something above ${PRIVILEGED_PORT_CEILING}.`,
      service: null,
      claim: null,
    };
  }

  return {
    port,
    availability: "free",
    free: true,
    headline: `Nothing is listening on ${port} and nobody has reserved it.`,
    suggestion: "Claim it before you start, so a turn running alongside you does not take it too.",
    service: null,
    claim: null,
  };
}

/**
 * The first port in a range nothing is using and nobody has reserved.
 *
 * Offered because "pick another port" is useless advice on a machine whose
 * occupied ports the asker cannot see. Returns null rather than a fallback when
 * the range is full: a suggestion that is not actually free is worse than no
 * suggestion, since the caller will act on it.
 */
export function suggestFreePort(input: {
  readonly from: number;
  readonly to: number;
  readonly services: ReadonlyArray<EnvironmentService>;
  readonly claims: ReadonlyArray<PortClaim>;
  readonly nowMs: number;
  readonly claimant?: string;
}): number | null {
  for (let port = input.from; port <= input.to; port += 1) {
    const verdict = decidePortAvailability({
      port,
      services: input.services,
      claims: input.claims,
      nowMs: input.nowMs,
      ...(input.claimant === undefined ? {} : { claimant: input.claimant }),
    });
    // A port held by the asker is free to them, and would be a strange thing to
    // suggest as the next one to take, so it is skipped rather than offered.
    if (verdict.availability === "free") return port;
  }
  return null;
}
