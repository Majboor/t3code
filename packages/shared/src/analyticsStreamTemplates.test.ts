import { describe, expect, it } from "vitest";

import { proposeAnalyticsStreams } from "./analyticsStreamTemplates.ts";

const runtime = (input: Record<string, unknown>) =>
  ({ target: "node", commands: {}, ...input }) as never;

const service = (input: Record<string, unknown>) =>
  ({
    id: "api",
    title: "API",
    protocol: "http",
    binding: { type: "dynamic" },
    exposure: "public",
    ...input,
  }) as never;

describe("proposeAnalyticsStreams", () => {
  it("proposes requests for a service somebody can reach", () => {
    const proposed = proposeAnalyticsStreams(runtime({ services: [service({})] }));
    expect(proposed.map((entry) => entry.name)).toEqual(["api.request"]);
    expect(proposed[0]?.properties.map((property) => property.name)).toEqual([
      "path",
      "status",
      "duration_ms",
    ]);
  });

  it("adds health only where the app said how to check it", () => {
    const withPath = proposeAnalyticsStreams(
      runtime({ services: [service({ healthPath: "/healthz" })] }),
    );
    expect(withPath.map((entry) => entry.name)).toEqual(["api.request", "api.health"]);
  });

  it("leaves a loopback service alone, since nobody outside calls it", () => {
    expect(proposeAnalyticsStreams(runtime({ services: [service({ exposure: "loopback" })] })))
      .toEqual([]);
  });

  it("ignores a protocol that has no requests to count", () => {
    expect(proposeAnalyticsStreams(runtime({ services: [service({ protocol: "tcp" })] }))).toEqual(
      [],
    );
  });

  it("counts runs for a terminal program, which serves nothing", () => {
    const proposed = proposeAnalyticsStreams(
      runtime({ commands: { start: { command: "python main.py" } } }),
    );
    expect(proposed.map((entry) => entry.name)).toEqual(["run.completed"]);
  });

  it("proposes nothing for a library, which neither serves nor runs", () => {
    expect(proposeAnalyticsStreams(runtime({}))).toEqual([]);
  });

  it("says why each stream was proposed, because somebody has to agree to it", () => {
    const proposed = proposeAnalyticsStreams(
      runtime({ services: [service({ healthPath: "/healthz" })] }),
    );
    for (const entry of proposed) {
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });
});
