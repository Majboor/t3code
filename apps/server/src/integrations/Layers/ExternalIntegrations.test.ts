import { it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { UserId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ExternalConnectionRepositoryLive } from "../../persistence/Layers/ExternalConnections.ts";
import { ExternalConnectionRepository } from "../../persistence/Services/ExternalConnections.ts";
import { ExternalIntegrations } from "../Services/ExternalIntegrations.ts";
import { ExternalIntegrationsLive } from "./ExternalIntegrations.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const userId = UserId.make("user-cloudflare-analytics-test");

// `provideMerge` (not `provide`) so the test body can reach `ExternalConnectionRepository`
// directly to seed a connection row, the same way DeployService.test.ts merges
// AnalyticsStoreLive/DeploymentRegistryLive in to read back what a run wrote.
const TestLayer = ExternalIntegrationsLive.pipe(
  Layer.provideMerge(ExternalConnectionRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
);

const seedCloudflareConnection = Effect.gen(function* () {
  const repo = yield* ExternalConnectionRepository;
  const now = DateTime.toUtc(yield* DateTime.now);
  yield* repo.upsert({
    userId,
    provider: "cloudflare",
    accessToken: "test-cf-token",
    refreshToken: null,
    expiresAt: null,
    accountId: "acct-1",
    accountLabel: "Test Account",
    scope: null,
    createdAt: now,
    updatedAt: now,
  });
});

describe("ExternalIntegrationsLive.cloudflareZoneAnalytics", () => {
  it.layer(TestLayer)("with a connected Cloudflare account", (it) => {
    it.effect("reads requests, unique visitors and bandwidth off Cloudflare's dashboard response", () =>
      Effect.gen(function* () {
        yield* seedCloudflareConnection;

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              result: {
                totals: {
                  requests: { all: 1234 },
                  uniques: { all: 567 },
                  bandwidth: { all: 89_012_345 },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );

        const integrations = yield* ExternalIntegrations;
        const result = yield* integrations.cloudflareZoneAnalytics(userId, "zone-1");

        expect(result).toEqual({ requests: 1234, uniqueVisitors: 567, bandwidthBytes: 89_012_345 });
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("/zones/zone-1/analytics/dashboard");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-cf-token");
      }),
    );

    it.effect("defaults missing totals to zero rather than throwing", () =>
      Effect.gen(function* () {
        yield* seedCloudflareConnection;

        vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ success: true, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

        const integrations = yield* ExternalIntegrations;
        const result = yield* integrations.cloudflareZoneAnalytics(userId, "zone-1");

        expect(result).toEqual({ requests: 0, uniqueVisitors: 0, bandwidthBytes: 0 });
      }),
    );
  });
});
