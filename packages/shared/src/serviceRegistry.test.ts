import { describe, expect, it } from "vitest";

import {
  decidePortAvailability,
  isManagedServiceLive,
  isPortClaimLive,
  isPortInRange,
  liveManagedServices,
  livePortClaims,
  MANAGED_SERVICE_TTL_MS,
  MAX_PORT,
  type ManagedServiceRecord,
  type ObservedListener,
  type PortClaim,
  reconcileEnvironmentServices,
  suggestFreePort,
} from "./serviceRegistry.ts";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function record(overrides: Partial<ManagedServiceRecord> = {}): ManagedServiceRecord {
  return {
    id: "svc-1",
    name: "hello",
    port: 3000,
    pid: 4821,
    command: "bun run dev",
    startedBy: "user-1",
    startedAt: iso(-60_000),
    heartbeatAt: iso(-1_000),
    stoppedAt: null,
    ...overrides,
  };
}

function listener(overrides: Partial<ObservedListener> = {}): ObservedListener {
  return {
    port: 3000,
    address: "0.0.0.0",
    protocol: "tcp",
    pid: 4821,
    processName: "bun",
    ...overrides,
  };
}

function claim(overrides: Partial<PortClaim> = {}): PortClaim {
  return {
    port: 4000,
    claimedBy: "user-1",
    purpose: "the new admin server",
    claimedAt: iso(-1_000),
    expiresAt: iso(60_000),
    ...overrides,
  };
}

function reconcile(input: {
  managed?: ReadonlyArray<ManagedServiceRecord>;
  observed?: ReadonlyArray<ObservedListener>;
  processAttribution?: boolean;
  nowMs?: number;
}) {
  return reconcileEnvironmentServices({
    managed: input.managed ?? [],
    observed: input.observed ?? [],
    nowMs: input.nowMs ?? NOW,
    processAttribution: input.processAttribution ?? true,
  });
}

describe("isPortInRange", () => {
  it.each([
    [0, false],
    [1, true],
    [80, true],
    [65_535, true],
    [65_536, false],
    [-1, false],
    [3000.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])("%s -> %s", (port, expected) => {
    expect(isPortInRange(port)).toBe(expected);
  });
});

describe("isManagedServiceLive", () => {
  it("believes a record whose heartbeat is inside the window", () => {
    expect(isManagedServiceLive(record({ heartbeatAt: iso(-1_000) }), NOW)).toBe(true);
  });

  it("drops a record whose heartbeat has aged past the TTL", () => {
    expect(
      isManagedServiceLive(record({ heartbeatAt: iso(-MANAGED_SERVICE_TTL_MS - 1) }), NOW),
    ).toBe(false);
  });

  it("keeps a record exactly on the deadline", () => {
    expect(isManagedServiceLive(record({ heartbeatAt: iso(-MANAGED_SERVICE_TTL_MS) }), NOW)).toBe(
      true,
    );
  });

  it("tolerates a heartbeat from the future, which is clock skew and not a lie", () => {
    expect(isManagedServiceLive(record({ heartbeatAt: iso(5_000) }), NOW)).toBe(true);
  });

  it("never believes a record we stopped on purpose", () => {
    expect(isManagedServiceLive(record({ stoppedAt: iso(-500) }), NOW)).toBe(false);
  });

  it("treats an undateable record as dead rather than live", () => {
    expect(isManagedServiceLive(record({ heartbeatAt: "not a date" }), NOW)).toBe(false);
  });

  it("honours an overridden TTL", () => {
    const older = record({ heartbeatAt: iso(-5_000) });
    expect(isManagedServiceLive(older, NOW, { managedMs: 1_000 })).toBe(false);
    expect(isManagedServiceLive(older, NOW, { managedMs: 10_000 })).toBe(true);
  });
});

describe("liveManagedServices", () => {
  it("sweeps on read", () => {
    const live = record({ id: "live" });
    const stale = record({ id: "stale", heartbeatAt: iso(-MANAGED_SERVICE_TTL_MS - 1) });
    expect(liveManagedServices([live, stale], NOW).map((entry) => entry.id)).toEqual(["live"]);
  });
});

describe("isPortClaimLive", () => {
  it("stands until its deadline", () => {
    expect(isPortClaimLive(claim({ expiresAt: iso(1) }), NOW)).toBe(true);
  });

  it("lapses at the deadline rather than after it", () => {
    expect(isPortClaimLive(claim({ expiresAt: iso(0) }), NOW)).toBe(false);
  });

  it("is dead once expired", () => {
    expect(isPortClaimLive(claim({ expiresAt: iso(-1) }), NOW)).toBe(false);
  });

  it("treats an undateable deadline as expired", () => {
    expect(isPortClaimLive(claim({ expiresAt: "soon" }), NOW)).toBe(false);
  });
});

describe("livePortClaims", () => {
  it("drops the lapsed ones", () => {
    const good = claim({ port: 4000 });
    const gone = claim({ port: 4001, expiresAt: iso(-1) });
    expect(livePortClaims([good, gone], NOW).map((entry) => entry.port)).toEqual([4000]);
  });
});

describe("reconcileEnvironmentServices — what we started", () => {
  it("calls a listener ours when the pid is the one we launched", () => {
    const [service] = reconcile({ managed: [record()], observed: [listener()] });
    expect(service).toMatchObject({
      port: 3000,
      name: "hello",
      state: "listening",
      ownership: "ours",
      canManage: true,
      pid: 4821,
      command: "bun run dev",
      startedBy: "user-1",
      managedId: "svc-1",
    });
    expect(service?.since).toBe(iso(-60_000));
  });

  it("says not-listening when our process is recorded but nothing is bound", () => {
    const [service] = reconcile({ managed: [record()], observed: [] });
    expect(service).toMatchObject({ state: "not-listening", ownership: "ours", canManage: true });
    expect(service?.address).toBeNull();
  });

  it("never reports a swept record as running", () => {
    expect(
      reconcile({
        managed: [record({ heartbeatAt: iso(-MANAGED_SERVICE_TTL_MS - 1) })],
        observed: [],
      }),
    ).toEqual([]);
  });

  it("forgets a record we stopped, even while its port still answers", () => {
    const services = reconcile({
      managed: [record({ stoppedAt: iso(-500) })],
      observed: [listener({ pid: 9102, processName: "gunicorn" })],
    });
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ ownership: "not-ours", canManage: false, pid: 9102 });
  });

  it("claims a second port bound by the same process we started", () => {
    const services = reconcile({
      managed: [record()],
      observed: [listener(), listener({ port: 3001, address: "127.0.0.1" })],
    });
    expect(services.map((service) => [service.port, service.ownership])).toEqual([
      [3000, "ours"],
      [3001, "ours"],
    ]);
    expect(services[1]?.managedId).toBe("svc-1");
    expect(services[1]?.ownershipReason).toContain("also listens here");
  });
});

describe("reconcileEnvironmentServices — what somebody else started", () => {
  it("refuses to manage an unrecorded process", () => {
    const [service] = reconcile({
      observed: [listener({ port: 5432, pid: 812, processName: "postgres" })],
    });
    expect(service).toMatchObject({
      port: 5432,
      name: "postgres",
      ownership: "not-ours",
      canManage: false,
    });
    expect(service?.ownershipReason).toContain("not a process T3 started");
  });

  it("does not invent an age for something it did not watch start", () => {
    const [service] = reconcile({ observed: [listener({ port: 5432, pid: 812 })] });
    expect(service?.since).toBeNull();
    expect(service?.startedBy).toBeNull();
    expect(service?.managedId).toBeNull();
  });
});

describe("reconcileEnvironmentServices — the port is not the identity", () => {
  it("splits our displaced record from the stranger that took its port", () => {
    const services = reconcile({
      managed: [record()],
      observed: [listener({ pid: 9102, processName: "gunicorn" })],
    });

    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({
      port: 3000,
      state: "displaced",
      ownership: "ours",
      pid: 4821,
      canManage: true,
    });
    expect(services[1]).toMatchObject({
      port: 3000,
      state: "listening",
      ownership: "not-ours",
      pid: 9102,
      canManage: false,
    });
  });

  it("never merges a port match into a single ours row", () => {
    const services = reconcile({
      managed: [record()],
      observed: [listener({ pid: 9102 })],
    });
    const ours = services.filter((service) => service.ownership === "ours");
    expect(ours).toHaveLength(1);
    expect(ours[0]?.state).not.toBe("listening");
  });
});

describe("reconcileEnvironmentServices — unknown never becomes ours", () => {
  it("says unknown when the socket has no pid, even with a record for that port", () => {
    const [service] = reconcile({
      managed: [record()],
      observed: [listener({ pid: null, processName: null })],
    });
    expect(service).toMatchObject({ ownership: "unknown", canManage: false, pid: null });
    expect(service?.ownershipReason).toContain("cannot be confirmed");
  });

  it("explains differently when no probe on the machine can name processes at all", () => {
    const [service] = reconcile({
      managed: [record()],
      observed: [listener({ pid: null, processName: null })],
      processAttribution: false,
    });
    expect(service?.ownership).toBe("unknown");
    expect(service?.ownershipReason).toContain("Nothing available here can name the process");
  });

  it("says unknown for an anonymous socket nobody recorded", () => {
    const [service] = reconcile({
      observed: [listener({ port: 8080, pid: null, processName: null })],
    });
    expect(service).toMatchObject({ port: 8080, ownership: "unknown", canManage: false });
  });

  it("leaves nothing manageable when the machine can see no pids at all", () => {
    const services = reconcile({
      managed: [record()],
      observed: [
        listener({ pid: null, processName: null }),
        listener({ port: 5432, pid: null, processName: null }),
      ],
      processAttribution: false,
    });
    expect(services.every((service) => service.canManage === false)).toBe(true);
  });
});

describe("reconcileEnvironmentServices — shape of the answer", () => {
  it("folds a dual-stack bind into one row and keeps the exposed address", () => {
    const services = reconcile({
      managed: [record()],
      observed: [listener({ address: "127.0.0.1" }), listener({ address: "0.0.0.0" })],
    });
    expect(services).toHaveLength(1);
    expect(services[0]?.address).toBe("0.0.0.0");
  });

  it("keeps loopback when loopback is all there is", () => {
    const [service] = reconcile({ managed: [record()], observed: [listener({ address: "::1" })] });
    expect(service?.address).toBe("::1");
  });

  it("orders by port, ours first at a contested one", () => {
    const services = reconcile({
      managed: [record({ port: 3000 }), record({ id: "svc-2", name: "api", port: 9000, pid: 77 })],
      observed: [
        listener({ port: 9000, pid: 77 }),
        listener({ port: 3000, pid: 9102 }),
        listener({ port: 5432, pid: 812, processName: "postgres" }),
      ],
    });
    expect(services.map((service) => [service.port, service.ownership])).toEqual([
      [3000, "ours"],
      [3000, "not-ours"],
      [5432, "not-ours"],
      [9000, "ours"],
    ]);
  });

  it("canManage is true for exactly the ours rows and nothing else", () => {
    const services = reconcile({
      managed: [record()],
      observed: [
        listener(),
        listener({ port: 5432, pid: 812 }),
        listener({ port: 8080, pid: null, processName: null }),
      ],
    });
    for (const service of services) {
      expect(service.canManage).toBe(service.ownership === "ours");
    }
  });

  it("reports an empty machine as empty rather than guessing", () => {
    expect(reconcile({})).toEqual([]);
  });
});

describe("decidePortAvailability", () => {
  const services = reconcileEnvironmentServices({
    managed: [record()],
    observed: [listener(), listener({ port: 5432, pid: 812, processName: "postgres" })],
    nowMs: NOW,
    processAttribution: true,
  });

  it("refuses a port that is not a port", () => {
    const verdict = decidePortAvailability({ port: 0, services, claims: [], nowMs: NOW });
    expect(verdict).toMatchObject({ availability: "out-of-range", free: false });
    expect(verdict.suggestion).toContain(String(MAX_PORT));
  });

  it("refuses one above the range too", () => {
    expect(
      decidePortAvailability({ port: 70_000, services, claims: [], nowMs: NOW }).availability,
    ).toBe("out-of-range");
  });

  it("reports our own service without telling the caller to leave it alone", () => {
    const verdict = decidePortAvailability({ port: 3000, services, claims: [], nowMs: NOW });
    expect(verdict).toMatchObject({ availability: "in-use", free: false });
    expect(verdict.headline).toContain("hello");
    expect(verdict.suggestion).toContain("Restart or stop it through T3");
  });

  it("tells the caller not to touch somebody else's", () => {
    const verdict = decidePortAvailability({ port: 5432, services, claims: [], nowMs: NOW });
    expect(verdict).toMatchObject({ availability: "in-use", free: false });
    expect(verdict.suggestion).toContain("Do not stop it");
    expect(verdict.service?.pid).toBe(812);
  });

  it("lets a listener outrank a reservation, and still reports both", () => {
    const verdict = decidePortAvailability({
      port: 5432,
      services,
      claims: [claim({ port: 5432, claimedBy: "user-2" })],
      nowMs: NOW,
    });
    expect(verdict.availability).toBe("in-use");
    expect(verdict.claim?.claimedBy).toBe("user-2");
  });

  it("blocks on somebody else's live reservation", () => {
    const verdict = decidePortAvailability({
      port: 4000,
      services,
      claims: [claim({ claimedBy: "user-2" })],
      nowMs: NOW,
      claimant: "user-1",
    });
    expect(verdict).toMatchObject({ availability: "claimed", free: false });
    expect(verdict.headline).toContain("user-2");
    expect(verdict.suggestion).toContain("Pick another port");
  });

  it("treats the asker's own reservation as free", () => {
    const verdict = decidePortAvailability({
      port: 4000,
      services,
      claims: [claim({ claimedBy: "user-1" })],
      nowMs: NOW,
      claimant: "user-1",
    });
    expect(verdict).toMatchObject({ availability: "held", free: true });
    expect(verdict.headline).toContain("reserved for you");
  });

  it("reads a reservation with no named asker as somebody else's", () => {
    expect(
      decidePortAvailability({ port: 4000, services, claims: [claim()], nowMs: NOW }).availability,
    ).toBe("claimed");
  });

  it("ignores a lapsed reservation entirely", () => {
    const verdict = decidePortAvailability({
      port: 4000,
      services,
      claims: [claim({ claimedBy: "user-2", expiresAt: iso(-1) })],
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ availability: "free", free: true, claim: null });
  });

  it("calls a quiet high port free and says to claim it", () => {
    const verdict = decidePortAvailability({ port: 4100, services, claims: [], nowMs: NOW });
    expect(verdict).toMatchObject({ availability: "free", free: true });
    expect(verdict.suggestion).toContain("Claim it before you start");
  });

  it("warns about a privileged port even when nothing is on it", () => {
    const verdict = decidePortAvailability({ port: 80, services, claims: [], nowMs: NOW });
    expect(verdict).toMatchObject({ availability: "free", free: true });
    expect(verdict.suggestion).toContain("privileged port");
  });

  it("does not call a port free while something we cannot identify holds it", () => {
    const anonymous = reconcileEnvironmentServices({
      managed: [],
      observed: [listener({ port: 9999, pid: null, processName: null })],
      nowMs: NOW,
      processAttribution: false,
    });
    const verdict = decidePortAvailability({
      port: 9999,
      services: anonymous,
      claims: [],
      nowMs: NOW,
    });
    expect(verdict.free).toBe(false);
    expect(verdict.service?.ownership).toBe("unknown");
  });

  it("does not treat a displaced record as an occupant of its old port", () => {
    const displaced = reconcileEnvironmentServices({
      managed: [record({ port: 7000 })],
      observed: [],
      nowMs: NOW,
      processAttribution: true,
    });
    expect(
      decidePortAvailability({ port: 7000, services: displaced, claims: [], nowMs: NOW }).free,
    ).toBe(true);
  });
});

describe("suggestFreePort", () => {
  const services = reconcileEnvironmentServices({
    managed: [record({ port: 3000 })],
    observed: [listener({ port: 3000 }), listener({ port: 3001, pid: 812, processName: "nginx" })],
    nowMs: NOW,
    processAttribution: true,
  });

  it("skips what is listening and what is reserved", () => {
    expect(
      suggestFreePort({
        from: 3000,
        to: 3010,
        services,
        claims: [claim({ port: 3002, claimedBy: "user-2" })],
        nowMs: NOW,
      }),
    ).toBe(3003);
  });

  it("skips the asker's own reservation rather than offering it back", () => {
    expect(
      suggestFreePort({
        from: 3002,
        to: 3010,
        services,
        claims: [claim({ port: 3002, claimedBy: "user-1" })],
        nowMs: NOW,
        claimant: "user-1",
      }),
    ).toBe(3003);
  });

  it("returns null rather than a port that is not actually free", () => {
    expect(suggestFreePort({ from: 3000, to: 3001, services, claims: [], nowMs: NOW })).toBeNull();
  });

  it("reuses a port whose reservation has lapsed", () => {
    expect(
      suggestFreePort({
        from: 3002,
        to: 3002,
        services,
        claims: [claim({ port: 3002, claimedBy: "user-2", expiresAt: iso(-1) })],
        nowMs: NOW,
      }),
    ).toBe(3002);
  });
});
