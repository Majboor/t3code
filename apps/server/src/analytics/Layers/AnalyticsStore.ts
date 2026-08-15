import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Effect, Layer, Option } from "effect";

import {
  AnalyticsEventId,
  type AnalyticsProperty,
  type AnalyticsQueryBucket,
  AnalyticsStreamId,
  type AnalyticsValue,
} from "@t3tools/contracts";

import {
  AnalyticsError,
  AnalyticsStore,
  type AnalyticsStoreShape,
} from "../Services/AnalyticsStore.ts";
import { AnalyticsRepository } from "../../persistence/Services/Analytics.ts";

/** Long enough that guessing is not a strategy, short enough to paste. */
const INGEST_KEY_BYTES = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/**
 * The key is stored as a digest, so a leaked database does not hand out write
 * access to every deployment. Compared in constant time because the comparison
 * happens on an unauthenticated path.
 */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function keyMatches(candidate: string, storedDigest: string): boolean {
  const left = Buffer.from(hashKey(candidate), "hex");
  const right = Buffer.from(storedDigest, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks an event against what the stream declared. Undeclared properties are
 * refused rather than dropped: silently discarding them makes a chart that is
 * quietly missing data, which is worse than an error at the point of writing.
 */
export function validateProperties(
  declared: ReadonlyArray<AnalyticsProperty>,
  received: Readonly<Record<string, AnalyticsValue>>,
): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const byName = new Map(declared.map((property) => [property.name, property]));

  for (const [name, value] of Object.entries(received)) {
    const property = byName.get(name);
    if (!property) {
      return { ok: false, why: `${name} was not declared on this stream` };
    }
    if (typeof value !== property.type) {
      return { ok: false, why: `${name} should be a ${property.type}, got ${typeof value}` };
    }
  }

  for (const property of declared) {
    if (property.required && !(property.name in received)) {
      return { ok: false, why: `${property.name} is required and was not sent` };
    }
  }

  return { ok: true };
}

/**
 * Rolls events into buckets. Kept as plain arithmetic over rows rather than SQL
 * so the behaviour is testable without a database, and so grouping by a JSON
 * property does not become a query the storage engine has to understand.
 */
export function aggregate(
  events: ReadonlyArray<{ readonly properties: Readonly<Record<string, AnalyticsValue>> }>,
  options: {
    readonly aggregate: "count" | "sum" | "avg" | "min" | "max";
    readonly valueProperty?: string | undefined;
    readonly groupBy?: string | undefined;
  },
): ReadonlyArray<AnalyticsQueryBucket> {
  const groups = new Map<string | null, number[]>();

  for (const event of events) {
    const key =
      options.groupBy === undefined ? null : String(event.properties[options.groupBy] ?? "");
    const numbers = groups.get(key) ?? [];
    if (options.aggregate === "count") {
      numbers.push(1);
    } else {
      const raw =
        options.valueProperty === undefined ? undefined : event.properties[options.valueProperty];
      // A row missing the value simply does not contribute; it is still counted
      // as an event, which is why `events` and `value` are reported separately.
      if (typeof raw === "number") numbers.push(raw);
    }
    groups.set(key, numbers);
  }

  const buckets: AnalyticsQueryBucket[] = [];
  for (const [group, numbers] of groups) {
    const total = numbers.reduce((sum, value) => sum + value, 0);
    let value = 0;
    switch (options.aggregate) {
      case "count":
        value = numbers.length;
        break;
      case "sum":
        value = total;
        break;
      case "avg":
        value = numbers.length === 0 ? 0 : total / numbers.length;
        break;
      case "min":
        value = numbers.length === 0 ? 0 : Math.min(...numbers);
        break;
      case "max":
        value = numbers.length === 0 ? 0 : Math.max(...numbers);
        break;
    }
    buckets.push({ group, value, events: numbers.length });
  }

  return buckets.toSorted((left, right) => right.value - left.value);
}

const makeAnalyticsStore = Effect.gen(function* () {
  const repository = yield* AnalyticsRepository;

  const storageFailed = (message: string) => (cause: unknown) =>
    new AnalyticsError({ code: "storage-failed", message, cause });

  const declareStream: AnalyticsStoreShape["declareStream"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .findStream({ projectId: input.projectId, name: input.name })
        .pipe(Effect.mapError(storageFailed("Failed to read analytics streams.")));
      if (Option.isSome(existing)) {
        return yield* new AnalyticsError({
          code: "stream-already-declared",
          message: `${input.name} is already declared on this project.`,
        });
      }

      const ingestKey = randomBytes(INGEST_KEY_BYTES).toString("base64url");
      const timestamp = nowIso();
      const stream = {
        id: AnalyticsStreamId.make(newId("astream")),
        projectId: input.projectId,
        name: input.name,
        purpose: input.purpose,
        properties: input.properties,
        // The digest lives where a name is expected: the column is what the
        // deployment's key is checked against, and nothing reads it back out.
        ingestKeyName: hashKey(ingestKey),
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      };

      yield* repository
        .upsertStream(stream)
        .pipe(Effect.mapError(storageFailed("Failed to store the analytics stream.")));

      return { stream, ingestKey };
    });

  const reissueIngestKey: AnalyticsStoreShape["reissueIngestKey"] = (input) =>
    Effect.gen(function* () {
      const found = yield* repository
        .findStream({ projectId: input.projectId, name: input.stream })
        .pipe(Effect.mapError(storageFailed("Failed to read the analytics stream.")));
      if (Option.isNone(found)) {
        return yield* new AnalyticsError({
          code: "stream-not-found",
          message: `No stream named ${input.stream} on this project.`,
        });
      }

      const ingestKey = randomBytes(INGEST_KEY_BYTES).toString("base64url");
      const stream = {
        ...found.value,
        ingestKeyName: hashKey(ingestKey),
        updatedAt: nowIso(),
      };

      yield* repository
        .upsertStream(stream)
        .pipe(Effect.mapError(storageFailed("Failed to store the analytics stream.")));

      return { stream, ingestKey };
    });

  const listStreams: AnalyticsStoreShape["listStreams"] = (input) =>
    repository.listStreams(input).pipe(
      Effect.mapError(storageFailed("Failed to list analytics streams.")),
      // The digest never leaves the server, so callers see that a key exists
      // and nothing they could authenticate with.
      Effect.map((streams) => ({
        streams: streams.map((stream) => ({ ...stream, ingestKeyName: "set" })),
      })),
    );

  const record: AnalyticsStoreShape["record"] = (input) =>
    Effect.gen(function* () {
      const found = yield* repository
        .findStream({ projectId: input.projectId, name: input.stream })
        .pipe(Effect.mapError(storageFailed("Failed to read the analytics stream.")));
      if (Option.isNone(found)) {
        return yield* new AnalyticsError({
          code: "stream-not-found",
          message: `No stream named ${input.stream} on this project.`,
        });
      }
      const stream = found.value;

      if (!keyMatches(input.ingestKey, stream.ingestKeyName)) {
        return yield* new AnalyticsError({
          code: "invalid-key",
          message: "That ingest key does not open this stream.",
        });
      }

      const valid = validateProperties(stream.properties, input.properties);
      if (!valid.ok) {
        return yield* new AnalyticsError({ code: "invalid-properties", message: valid.why });
      }

      const receivedAt = nowIso();
      const eventId = AnalyticsEventId.make(newId("aevent"));
      yield* repository
        .appendEvent({
          id: eventId,
          streamId: stream.id,
          projectId: stream.projectId,
          occurredAt: input.occurredAt ?? receivedAt,
          receivedAt,
          properties: input.properties,
        })
        .pipe(Effect.mapError(storageFailed("Failed to store the analytics event.")));

      return { eventId };
    });

  const query: AnalyticsStoreShape["query"] = (input) =>
    Effect.gen(function* () {
      const found = yield* repository
        .findStream({ projectId: input.projectId, name: input.stream })
        .pipe(Effect.mapError(storageFailed("Failed to read the analytics stream.")));
      if (Option.isNone(found)) {
        return yield* new AnalyticsError({
          code: "stream-not-found",
          message: `No stream named ${input.stream} on this project.`,
        });
      }
      const stream = found.value;

      if (input.aggregate !== "count") {
        const property = stream.properties.find((entry) => entry.name === input.valueProperty);
        if (!property) {
          return yield* new AnalyticsError({
            code: "invalid-query",
            message: `${input.aggregate} needs a declared property to work on.`,
          });
        }
        if (property.type !== "number") {
          return yield* new AnalyticsError({
            code: "invalid-query",
            message: `${property.name} is a ${property.type}, so ${input.aggregate} means nothing over it.`,
          });
        }
      }

      if (input.groupBy !== undefined && !stream.properties.some((e) => e.name === input.groupBy)) {
        return yield* new AnalyticsError({
          code: "invalid-query",
          message: `${input.groupBy} was never declared, so nothing can be grouped by it.`,
        });
      }

      const events = yield* repository
        .readEvents({
          streamId: stream.id,
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.until === undefined ? {} : { until: input.until }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(Effect.mapError(storageFailed("Failed to read analytics events.")));

      return {
        stream: input.stream,
        aggregate: input.aggregate,
        buckets: aggregate(events, {
          aggregate: input.aggregate,
          valueProperty: input.valueProperty,
          groupBy: input.groupBy,
        }),
      };
    });

  return {
    declareStream,
    reissueIngestKey,
    listStreams,
    record,
    query,
  } satisfies AnalyticsStoreShape;
});

export const AnalyticsStoreLive = Layer.effect(AnalyticsStore, makeAnalyticsStore);
