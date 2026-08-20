import { DateTime, Effect, Layer, Option } from "effect";

import {
  type EnvironmentId,
  type EnvironmentService,
  type PortClaim,
  type PortNumber,
  type PortVerdict,
  ServiceId,
  ServiceRegistryError,
  type ServiceRegistryListResult,
  type UserId,
} from "@t3tools/contracts";
import {
  decidePortAvailability,
  type EnvironmentService as SharedEnvironmentService,
  isPortInRange,
  type ManagedServiceRecord,
  PORT_CLAIM_TTL_MS,
  type PortVerdict as SharedPortVerdict,
  reconcileEnvironmentServices,
  suggestFreePort,
} from "@t3tools/shared/serviceRegistry";

import {
  EnvironmentServiceRepository,
  type EnvironmentServiceRow,
} from "../../persistence/Services/EnvironmentServices.ts";
import { isProcessAlive, type ListenerProbeResult, probeListeners } from "../listenerProbe.ts";
import { ServiceRegistry, type ServiceRegistryShape } from "../Services/ServiceRegistry.ts";

/**
 * Where a suggested port comes from when the asked-for one is taken.
 *
 * Above the privileged range and clear of the ports a developer machine hands
 * out by habit, so a suggestion is unlikely to collide with something that has
 * simply not started yet.
 */
const SUGGESTION_FROM = 4_000;
const SUGGESTION_TO = 4_100;

/**
 * The rules are shared with the browser and so are branding-free; the ids they
 * carry came out of branded rows and go straight back into branded ones.
 */
function brandService(service: SharedEnvironmentService): EnvironmentService {
  return {
    ...service,
    managedId: service.managedId === null ? null : ServiceId.make(service.managedId),
  };
}

/** How the machine gets inspected when the probe is not overridden for a test. */
export interface ServiceRegistryProbe {
  readonly listeners: () => Promise<ListenerProbeResult>;
  readonly isAlive: (pid: number) => boolean;
}

const defaultProbe: ServiceRegistryProbe = {
  listeners: probeListeners,
  isAlive: isProcessAlive,
};

/**
 * A stored row as the shared rules want it.
 *
 * `heartbeatAt` is passed in rather than copied off the row: the caller has just
 * confirmed the process exists, and that confirmation *is* the heartbeat. Using
 * the row's own value would hand the sweep a timestamp from the last time
 * anybody looked, so a service confirmed alive a millisecond ago could still be
 * swept for being stale.
 */
function toManaged(row: EnvironmentServiceRow, heartbeatAt: string): ManagedServiceRecord {
  return {
    id: row.id,
    name: row.name,
    port: row.port,
    pid: row.pid,
    command: row.command,
    startedBy: row.startedBy,
    startedAt: row.startedAt,
    heartbeatAt,
    stoppedAt: row.stoppedAt,
  };
}

/**
 * The service, built over an injectable probe.
 *
 * Exported rather than hidden behind the Layer because the probe is the one
 * part that cannot be exercised in a test without depending on what the machine
 * running the test happens to have installed and be serving.
 */
export const makeServiceRegistry = (probe: ServiceRegistryProbe = defaultProbe) =>
  Effect.gen(function* () {
    const repository = yield* EnvironmentServiceRepository;

    const storageError = (message: string) => (cause: unknown) =>
      new ServiceRegistryError({ code: "execution-failed", message, cause });

    const now = Effect.map(DateTime.now, (instant) => DateTime.formatIso(DateTime.toUtc(instant)));

    /**
     * Look at the machine, then reconcile it against what we started.
     *
     * The order matters and is why the pid check happens here rather than in a
     * background sweep: confirming a process exists is what refreshes its
     * heartbeat, so the record's liveness and the socket list are observations of
     * the same moment. A heartbeat kept up by a timer would go on asserting a
     * process is alive during the minutes between the timer and the read, which
     * is precisely the window an agent asks in.
     *
     * A pid that has gone is *stopped*, not merely un-refreshed. Waiting for the
     * TTL to clear it would leave hours of a dead service reported as running,
     * and the TTL is a backstop for the case nobody looked — not for the case we
     * looked and saw it gone.
     */
    const observe = (environmentId: EnvironmentId) =>
      Effect.gen(function* () {
        const rows = yield* repository
          .list({ environmentId })
          .pipe(Effect.mapError(storageError("Failed to read this environment's services.")));

        const timestamp = yield* now;
        const nowMs = Date.parse(timestamp);

        // Asked once per row and partitioned, rather than filtered twice. Two
        // calls could disagree — a process can exit between them — and the row
        // would then be both heartbeated and marked stopped.
        const alive: EnvironmentServiceRow[] = [];
        const gone: EnvironmentServiceRow[] = [];
        for (const row of rows) {
          if (row.stoppedAt !== null) continue;
          (probe.isAlive(row.pid) ? alive : gone).push(row);
        }

        yield* repository
          .heartbeat({ ids: alive.map((row) => row.id), heartbeatAt: timestamp })
          .pipe(Effect.mapError(storageError("Failed to refresh the service heartbeats.")));

        for (const row of gone) {
          yield* repository
            .stop({ serviceId: row.id, stoppedAt: timestamp })
            .pipe(Effect.mapError(storageError("Failed to record a stopped service.")));
        }

        const probed = yield* Effect.tryPromise({
          try: () => probe.listeners(),
          catch: (cause) =>
            new ServiceRegistryError({
              code: "execution-failed",
              message: "Failed to ask this machine what it is listening on.",
              cause,
            }),
        });

        const services = reconcileEnvironmentServices({
          managed: alive.map((row) => toManaged(row, timestamp)),
          observed: probed.listeners,
          nowMs,
          processAttribution: probed.processAttribution,
        });

        const claimRows = yield* repository
          .listClaims({ environmentId })
          .pipe(Effect.mapError(storageError("Failed to read this environment's port claims.")));

        return { services, claimRows, probed, timestamp, nowMs };
      });

    const resultOf = (observation: {
      services: ReadonlyArray<SharedEnvironmentService>;
      claimRows: ReadonlyArray<PortClaim>;
      probed: ListenerProbeResult;
      timestamp: string;
      nowMs: number;
    }): ServiceRegistryListResult => ({
      services: observation.services.map(brandService),
      // Swept on the way out as well as on the way in: a lapsed reservation
      // rendered in a browser is a port somebody will not take for no reason.
      claims: observation.claimRows.filter(
        (claim) => Date.parse(claim.expiresAt) > observation.nowMs,
      ),
      probe: {
        tool: observation.probed.tool,
        processAttribution: observation.probed.processAttribution,
        limitation: observation.probed.limitation,
      },
      observedAt: observation.timestamp,
    });

    const list: ServiceRegistryShape["list"] = (input) =>
      Effect.map(observe(input.environmentId), resultOf);

    /** Same branding pass, for the service a verdict carries. */
    const brandVerdict = (verdict: SharedPortVerdict, claimant: UserId): PortVerdict => ({
      ...verdict,
      service: verdict.service === null ? null : brandService(verdict.service),
      claim: verdict.claim === null ? null : { ...verdict.claim, claimedBy: claimant },
    });

    const checkPort: ServiceRegistryShape["checkPort"] = (input) =>
      Effect.gen(function* () {
        const observation = yield* observe(input.environmentId);
        const verdict = decidePortAvailability({
          port: input.port,
          services: observation.services,
          claims: observation.claimRows,
          nowMs: observation.nowMs,
          claimant: input.asking,
        });

        return {
          verdict: brandVerdict(verdict, input.asking),
          // Only offered when the answer was no. Suggesting an alternative to a
          // port that is already free reads as a reason not to use it.
          suggestion: verdict.free
            ? null
            : (suggestFreePort({
                from: SUGGESTION_FROM,
                to: SUGGESTION_TO,
                services: observation.services,
                claims: observation.claimRows,
                nowMs: observation.nowMs,
                claimant: input.asking,
              }) as PortNumber | null),
        };
      });

    const claimPort: ServiceRegistryShape["claimPort"] = (input) =>
      Effect.gen(function* () {
        if (!isPortInRange(input.port)) {
          return yield* new ServiceRegistryError({
            code: "invalid-port",
            message: `${input.port} is not a port.`,
          });
        }

        const observation = yield* observe(input.environmentId);
        const verdict = decidePortAvailability({
          port: input.port,
          services: observation.services,
          claims: observation.claimRows,
          nowMs: observation.nowMs,
          claimant: input.asking,
        });

        // Refused rather than taken, and returned rather than thrown: "somebody
        // else has it, here is why" is an ordinary answer to this question, and
        // the caller needs the verdict to say something useful about it.
        if (!verdict.free) {
          return { claim: null, verdict: brandVerdict(verdict, input.asking) };
        }

        const claim: PortClaim = {
          port: input.port,
          claimedBy: input.asking,
          purpose: input.purpose,
          claimedAt: observation.timestamp,
          expiresAt: new Date(
            observation.nowMs + (input.holdMs ?? PORT_CLAIM_TTL_MS),
          ).toISOString(),
        };

        yield* repository
          .upsertClaim({ ...claim, environmentId: input.environmentId })
          .pipe(Effect.mapError(storageError("Failed to record the port claim.")));

        return { claim, verdict: brandVerdict(verdict, input.asking) };
      });

    const releasePort: ServiceRegistryShape["releasePort"] = (input) =>
      repository
        .releaseClaim({
          environmentId: input.environmentId,
          port: input.port,
          claimedBy: input.asking,
        })
        .pipe(
          Effect.map((released) => ({ released })),
          Effect.mapError(storageError("Failed to release the port claim.")),
        );

    const register: ServiceRegistryShape["register"] = (input) =>
      Effect.gen(function* () {
        // A pid that is not running is refused at the door. Recording it would
        // put a dead process into the one table that grants permission to kill
        // things, and the next process to inherit that number would inherit the
        // permission with it.
        if (!probe.isAlive(input.pid)) {
          return yield* new ServiceRegistryError({
            code: "execution-failed",
            message: `There is no process ${input.pid} on this machine, so there is nothing to record.`,
          });
        }

        const timestamp = yield* now;

        yield* repository
          .register({
            id: ServiceId.make(`service:${crypto.randomUUID()}`),
            environmentId: input.environmentId,
            name: input.name,
            port: input.port,
            pid: input.pid,
            command: input.command,
            startedBy: input.asking,
            startedAt: timestamp,
            heartbeatAt: timestamp,
            stoppedAt: null,
          })
          .pipe(Effect.mapError(storageError("Failed to record the service.")));

        // Registering also releases the reservation it was taken under. The port
        // is now held by a real process, and a reservation left standing beside
        // it is a second claim on the same thing that outlives its purpose.
        yield* repository
          .releaseClaim({
            environmentId: input.environmentId,
            port: input.port,
            claimedBy: input.asking,
          })
          .pipe(Effect.mapError(storageError("Failed to clear the port claim.")));

        return yield* Effect.map(observe(input.environmentId), resultOf);
      });

    const release: ServiceRegistryShape["release"] = (input) =>
      Effect.gen(function* () {
        const found = yield* repository
          .get({ serviceId: input.serviceId })
          .pipe(Effect.mapError(storageError("Failed to read the service.")));

        if (Option.isNone(found) || found.value.environmentId !== input.environmentId) {
          return yield* new ServiceRegistryError({
            code: "service-not-found",
            message: "This environment has no record of starting that service.",
          });
        }
        // Already released is not an error. The turn that asks twice, and the
        // person clicking after a turn already did it, both mean the same thing.
        if (found.value.stoppedAt !== null) {
          return { released: false };
        }

        const timestamp = yield* now;
        yield* repository
          .stop({ serviceId: input.serviceId, stoppedAt: timestamp })
          .pipe(Effect.mapError(storageError("Failed to release the service.")));

        return { released: true };
      });

    return {
      list,
      checkPort,
      claimPort,
      releasePort,
      register,
      release,
    } satisfies ServiceRegistryShape;
  });

export const ServiceRegistryLive: Layer.Layer<
  ServiceRegistry,
  never,
  EnvironmentServiceRepository
> = Layer.effect(ServiceRegistry, makeServiceRegistry());

/** The same service reading a machine somebody else is pretending to be, for tests. */
export const makeServiceRegistryLive = (
  probe: ServiceRegistryProbe,
): Layer.Layer<ServiceRegistry, never, EnvironmentServiceRepository> =>
  Layer.effect(ServiceRegistry, makeServiceRegistry(probe));
