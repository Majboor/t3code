import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AnalyticsStoreLive, aggregate, validateProperties } from "./AnalyticsStore.ts";
import { AnalyticsStore } from "../Services/AnalyticsStore.ts";
import { AnalyticsRepositoryLive } from "../../persistence/Layers/Analytics.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";

const projectId = ProjectId.make("project-analytics");

function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-analytics-"));
  return AnalyticsStoreLive.pipe(
    Layer.provide(AnalyticsRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(path.join(tempDir, "analytics.sqlite"))),
    Layer.provideMerge(NodeServices.layer),
  );
}

const pageView = {
  projectId,
  name: "page.view" as never,
  purpose: "Which pages get read",
  properties: [
    { name: "path" as never, type: "string" as const, purpose: "The page", required: true },
    { name: "seconds" as never, type: "number" as const, purpose: "Dwell", required: false },
  ],
};

describe("validateProperties", () => {
  it("refuses a property nobody declared rather than dropping it", () => {
    const result = validateProperties(pageView.properties, {
      path: "/a",
      sneaky: "value",
    } as never);
    assert.strictEqual(result.ok, false);
    assert.include(result.ok === false ? result.why : "", "sneaky");
  });

  it("refuses a value of the wrong type", () => {
    const result = validateProperties(pageView.properties, { path: 12 } as never);
    assert.strictEqual(result.ok, false);
    assert.include(result.ok === false ? result.why : "", "should be a string");
  });

  it("refuses an event missing something required", () => {
    const result = validateProperties(pageView.properties, { seconds: 3 } as never);
    assert.strictEqual(result.ok, false);
    assert.include(result.ok === false ? result.why : "", "required");
  });

  it("accepts a declared event without its optional properties", () => {
    assert.strictEqual(validateProperties(pageView.properties, { path: "/a" } as never).ok, true);
  });
});

describe("aggregate", () => {
  const events = [
    { properties: { path: "/a", seconds: 10 } },
    { properties: { path: "/a", seconds: 20 } },
    { properties: { path: "/b", seconds: 4 } },
  ] as never[];

  it("counts into one bucket when nothing groups it", () => {
    const buckets = aggregate(events, { aggregate: "count" });
    assert.deepStrictEqual(buckets, [{ group: null, value: 3, events: 3 }]);
  });

  it("splits by the grouping property, largest first", () => {
    const buckets = aggregate(events, { aggregate: "count", groupBy: "path" });
    assert.deepStrictEqual(
      buckets.map((bucket) => [bucket.group, bucket.value]),
      [
        ["/a", 2],
        ["/b", 1],
      ],
    );
  });

  it("sums and averages the value property per group", () => {
    const summed = aggregate(events, {
      aggregate: "sum",
      valueProperty: "seconds",
      groupBy: "path",
    });
    assert.strictEqual(summed.find((bucket) => bucket.group === "/a")?.value, 30);

    const averaged = aggregate(events, {
      aggregate: "avg",
      valueProperty: "seconds",
      groupBy: "path",
    });
    assert.strictEqual(averaged.find((bucket) => bucket.group === "/a")?.value, 15);
  });

  it("ignores rows with no number to add, rather than counting them as zero", () => {
    const mixed = [{ properties: { path: "/a", seconds: 10 } }, { properties: { path: "/a" } }];
    const averaged = aggregate(mixed as never[], { aggregate: "avg", valueProperty: "seconds" });
    // Averaging over one real number, not two — a missing value is absent, not 0.
    assert.strictEqual(averaged[0]?.value, 10);
  });
});

describe("the analytics store", () => {
  it.effect("hands back an ingest key once and never repeats it", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      const declared = yield* analytics.declareStream(pageView);
      assert.ok(declared.ingestKey.length > 20);

      const listed = yield* analytics.listStreams({ projectId });
      assert.strictEqual(listed.streams.length, 1);
      // Whatever a reader gets back, it must not be usable as a key.
      assert.notStrictEqual(listed.streams[0]?.ingestKeyName, declared.ingestKey);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a second stream with the same name on one project", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      yield* analytics.declareStream(pageView);
      const error = yield* Effect.flip(analytics.declareStream(pageView));
      assert.strictEqual(error.code, "stream-already-declared");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("records an event and answers a question about it", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      const { ingestKey } = yield* analytics.declareStream(pageView);

      for (const [pagePath, seconds] of [
        ["/a", 10],
        ["/a", 20],
        ["/b", 5],
      ] as const) {
        yield* analytics.record({
          projectId,
          stream: "page.view" as never,
          ingestKey,
          properties: { path: pagePath, seconds },
        });
      }

      const counted = yield* analytics.query({
        projectId,
        stream: "page.view" as never,
        aggregate: "count",
        groupBy: "path" as never,
      });
      assert.deepStrictEqual(
        counted.buckets.map((bucket) => [bucket.group, bucket.value]),
        [
          ["/a", 2],
          ["/b", 1],
        ],
      );

      const dwell = yield* analytics.query({
        projectId,
        stream: "page.view" as never,
        aggregate: "sum",
        valueProperty: "seconds" as never,
        groupBy: "path" as never,
      });
      assert.strictEqual(dwell.buckets.find((bucket) => bucket.group === "/a")?.value, 30);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("turns away an event whose key does not open the stream", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      yield* analytics.declareStream(pageView);

      const error = yield* Effect.flip(
        analytics.record({
          projectId,
          stream: "page.view" as never,
          ingestKey: "not-the-key",
          properties: { path: "/a" },
        }),
      );
      assert.strictEqual(error.code, "invalid-key");

      // And nothing was written despite the attempt.
      const counted = yield* analytics.query({
        projectId,
        stream: "page.view" as never,
        aggregate: "count",
      });
      assert.strictEqual(counted.buckets[0]?.value ?? 0, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("accepts events posted with a reissued key", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      yield* analytics.declareStream(pageView);

      // Every redeploy that wires analytics takes this path — the stream is
      // already declared, so the deploy reissues rather than declares. The key
      // handed back has to be the one the stream now answers to; when the
      // digest was not written, this was a 403 on every event forever after
      // the first deploy.
      const reissued = yield* analytics.reissueIngestKey({
        projectId,
        stream: "page.view" as never,
      });

      yield* analytics.record({
        projectId,
        stream: "page.view" as never,
        ingestKey: reissued.ingestKey,
        properties: { path: "/a" },
      });

      const counted = yield* analytics.query({
        projectId,
        stream: "page.view" as never,
        aggregate: "count",
      });
      assert.strictEqual(counted.buckets[0]?.value ?? 0, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("stops the key a reissue replaced from writing any more", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      const declared = yield* analytics.declareStream(pageView);
      yield* analytics.reissueIngestKey({ projectId, stream: "page.view" as never });

      // The other half of the same guarantee: rotating has to actually retire
      // the old key, or a replaced deployment keeps writing to the stream.
      const error = yield* Effect.flip(
        analytics.record({
          projectId,
          stream: "page.view" as never,
          ingestKey: declared.ingestKey,
          properties: { path: "/a" },
        }),
      );
      assert.strictEqual(error.code, "invalid-key");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses to sum something that was declared as text", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      yield* analytics.declareStream(pageView);

      const error = yield* Effect.flip(
        analytics.query({
          projectId,
          stream: "page.view" as never,
          aggregate: "sum",
          valueProperty: "path" as never,
        }),
      );
      assert.strictEqual(error.code, "invalid-query");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses to group by something nobody declared", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsStore;
      yield* analytics.declareStream(pageView);

      const error = yield* Effect.flip(
        analytics.query({
          projectId,
          stream: "page.view" as never,
          aggregate: "count",
          groupBy: "referrer" as never,
        }),
      );
      assert.strictEqual(error.code, "invalid-query");
    }).pipe(Effect.provide(makeLayer())),
  );
});
