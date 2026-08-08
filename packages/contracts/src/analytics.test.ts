import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  AnalyticsDeclareStreamInput,
  AnalyticsName,
  AnalyticsQueryInput,
  AnalyticsRecordInput,
} from "./analytics.ts";

const decodeName = Schema.decodeUnknownEffect(AnalyticsName);
const decodeDeclare = Schema.decodeUnknownEffect(AnalyticsDeclareStreamInput);
const decodeRecord = Schema.decodeUnknownEffect(AnalyticsRecordInput);
const decodeQuery = Schema.decodeUnknownEffect(AnalyticsQueryInput);

describe("AnalyticsName", () => {
  it.effect("accepts the slug shape a chart title and a URL can both carry", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeName("page.view"), "page.view");
      assert.strictEqual(yield* decodeName("pdf_page_read"), "pdf_page_read");
    }),
  );

  it.effect("refuses names that would need escaping downstream", () =>
    Effect.gen(function* () {
      // flip succeeds only when the decode failed, so a name that slipped
      // through fails this test rather than passing quietly.
      for (const bad of ["Page.View", "9lives", "has space", "trailing/slash", ""]) {
        yield* Effect.flip(decodeName(bad));
      }
    }),
  );
});

describe("declaring a stream", () => {
  it.effect("carries the properties a later chart is allowed to reference", () =>
    Effect.gen(function* () {
      const declared = yield* decodeDeclare({
        projectId: "project-1",
        name: "page.view",
        purpose: "Which pages get read",
        properties: [
          { name: "path", type: "string", purpose: "The page", required: true },
          { name: "seconds", type: "number", purpose: "Time on page", required: false },
        ],
      });
      assert.strictEqual(declared.properties.length, 2);
      assert.strictEqual(declared.properties[0]?.required, true);
    }),
  );

  it.effect("refuses a property type a chart could not draw", () =>
    Effect.gen(function* () {
      yield* Effect.flip(
        decodeDeclare({
          projectId: "project-1",
          name: "page.view",
          purpose: "Which pages get read",
          properties: [{ name: "blob", type: "object", purpose: "anything", required: false }],
        }),
      );
    }),
  );
});

describe("recording", () => {
  it.effect("takes the three value types a deployment can send", () =>
    Effect.gen(function* () {
      const recorded = yield* decodeRecord({
        stream: "page.view",
        ingestKey: "secret-value",
        properties: { path: "/about", seconds: 12.5, bounced: false },
      });
      assert.strictEqual(recorded.properties["seconds"], 12.5);
      assert.strictEqual(recorded.properties["bounced"], false);
    }),
  );

  it.effect("lets a deployment say when it happened, and copes when it does not", () =>
    Effect.gen(function* () {
      const withTime = yield* decodeRecord({
        stream: "page.view",
        ingestKey: "secret-value",
        occurredAt: "2026-08-09T01:00:00.000Z",
        properties: {},
      });
      assert.strictEqual(withTime.occurredAt, "2026-08-09T01:00:00.000Z");

      const withoutTime = yield* decodeRecord({
        stream: "page.view",
        ingestKey: "secret-value",
        properties: {},
      });
      assert.strictEqual(withoutTime.occurredAt, undefined);
    }),
  );
});

describe("querying", () => {
  it.effect("keeps grouping optional, so one bucket can cover everything", () =>
    Effect.gen(function* () {
      const query = yield* decodeQuery({
        projectId: "project-1",
        stream: "page.view",
        aggregate: "count",
      });
      assert.strictEqual(query.groupBy, undefined);
      assert.strictEqual(query.valueProperty, undefined);
    }),
  );

  it.effect("refuses an aggregate nobody defined", () =>
    Effect.gen(function* () {
      yield* Effect.flip(
        decodeQuery({ projectId: "project-1", stream: "page.view", aggregate: "median" }),
      );
    }),
  );
});
