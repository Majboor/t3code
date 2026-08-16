import { describe, expect, it } from "vitest";

import type { AnalyticsQueryResult, Deployment } from "@t3tools/contracts";

import {
  describeLoad,
  orderDeployments,
  summariseLoad,
  totalEvents,
  type DeploymentLoad,
} from "./deploymentLoad.logic";

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "deployment:1",
    projectId: "project:1",
    targetId: "deploy-target:1",
    name: "docs",
    url: "https://example.trycloudflare.com",
    status: "live",
    lastRunId: null,
    analyticsStreamIds: ["stream:reads"],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  } as Deployment;
}

const READS = { id: "stream:reads", name: "pdf.page_read" } as never;

describe("totalEvents", () => {
  it("adds the buckets up rather than reading the first", () => {
    const result = {
      stream: "pdf.page_read",
      aggregate: "count",
      buckets: [
        { group: "Cover", value: 1, events: 1 },
        { group: "Why it broke", value: 2, events: 2 },
      ],
    } as AnalyticsQueryResult;
    expect(totalEvents(result)).toBe(3);
  });

  it("is zero for a stream nothing has reached", () => {
    expect(
      totalEvents({ stream: "s", aggregate: "count", buckets: [] } as AnalyticsQueryResult),
    ).toBe(0);
  });
});

describe("summariseLoad", () => {
  it("sums the counts of every stream a deployment reports to", () => {
    const live = deployment({ analyticsStreamIds: ["stream:reads", "stream:hits"] as never });
    const [load] = summariseLoad(
      [live],
      [READS, { id: "stream:hits", name: "page.hit" } as never],
      new Map([
        ["pdf.page_read", 3],
        ["page.hit", 4],
      ]),
    );
    expect(load?.events).toBe(7);
    expect(load?.streamNames).toEqual(["pdf.page_read", "page.hit"]);
  });

  it("reports null, not zero, when a deployment reports to no stream", () => {
    const [load] = summariseLoad([deployment({ analyticsStreamIds: [] })], [READS], new Map());
    expect(load?.events).toBeNull();
  });

  it("keeps a real zero distinct from an unmeasurable one", () => {
    const [load] = summariseLoad([deployment()], [READS], new Map([["pdf.page_read", 0]]));
    expect(load?.events).toBe(0);
  });

  it("counts a stream that no longer resolves as dangling and not as load", () => {
    const [load] = summariseLoad(
      [deployment({ analyticsStreamIds: ["stream:gone"] as never })],
      [READS],
      new Map([["pdf.page_read", 9]]),
    );
    expect(load?.dangling).toBe(1);
    expect(load?.events).toBeNull();
  });
});

describe("describeLoad", () => {
  const base = summariseLoad([deployment()], [READS], new Map([["pdf.page_read", 5]]))[0];

  it("names the count when there is traffic", () => {
    expect(describeLoad(base as DeploymentLoad)).toBe("5 events reported");
  });

  it("uses the singular for one event", () => {
    const [one] = summariseLoad([deployment()], [READS], new Map([["pdf.page_read", 1]]));
    expect(describeLoad(one as DeploymentLoad)).toBe("1 event reported");
  });

  it("says nothing has arrived rather than printing a bare zero", () => {
    const [none] = summariseLoad([deployment()], [READS], new Map([["pdf.page_read", 0]]));
    expect(describeLoad(none as DeploymentLoad)).toBe("No traffic reported yet");
  });

  it("explains an unwired deployment instead of calling it idle", () => {
    const [unwired] = summariseLoad([deployment({ analyticsStreamIds: [] })], [READS], new Map());
    expect(describeLoad(unwired as DeploymentLoad)).toBe(
      "Not wired to analytics, so it cannot report load",
    );
  });

  it("distinguishes a stream that was archived out from under it", () => {
    const [dangling] = summariseLoad(
      [deployment({ analyticsStreamIds: ["stream:gone"] as never })],
      [READS],
      new Map(),
    );
    expect(describeLoad(dangling as DeploymentLoad)).toBe(
      "Reports to a stream that no longer exists",
    );
  });
});

describe("orderDeployments", () => {
  it("puts live deployments above stopped ones", () => {
    const loads = summariseLoad(
      [
        deployment({ id: "deployment:stopped" as never, status: "stopped" }),
        deployment({ id: "deployment:live" as never, status: "live" }),
      ],
      [READS],
      new Map(),
    );
    expect(orderDeployments(loads).map((load) => load.deployment.id)).toEqual([
      "deployment:live",
      "deployment:stopped",
    ]);
  });

  it("breaks ties on the most recently updated", () => {
    const loads = summariseLoad(
      [
        deployment({ id: "deployment:old" as never, updatedAt: "2026-08-01T00:00:00.000Z" }),
        deployment({ id: "deployment:new" as never, updatedAt: "2026-08-14T00:00:00.000Z" }),
      ],
      [READS],
      new Map(),
    );
    expect(orderDeployments(loads).map((load) => load.deployment.id)).toEqual([
      "deployment:new",
      "deployment:old",
    ]);
  });
});
