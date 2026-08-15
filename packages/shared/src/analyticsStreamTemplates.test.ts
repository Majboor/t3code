import { describe, expect, it } from "vitest";

import {
  analyticsStreamsForPack,
  declaredAnalyticsStreams,
  proposeAnalyticsStreams,
  proposeStreamForDeployment,
  toStreamSlug,
} from "./analyticsStreamTemplates.ts";

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

const analytics = (events: ReadonlyArray<Record<string, unknown>>) => ({ events }) as never;

const event = (input: Record<string, unknown>) =>
  ({
    name: "checkout.completed",
    source: "backend",
    description: "A completed checkout.",
    ...input,
  }) as never;

describe("declaredAnalyticsStreams", () => {
  it("uses the events the pack said it emits", () => {
    const declared = declaredAnalyticsStreams(
      analytics([
        event({
          properties: [
            { name: "amount", type: "number", pii: false },
            { name: "currency", type: "string", pii: false },
          ],
        }),
      ]),
    );

    expect(declared).toHaveLength(1);
    expect(declared[0]?.name).toBe("checkout.completed");
    expect(declared[0]?.purpose).toBe("A completed checkout.");
    expect(declared[0]?.properties.map((property) => property.name)).toEqual([
      "amount",
      "currency",
    ]);
  });

  it("carries a timestamp across as text, not as a number", () => {
    // A stream property is string, number or boolean. Read as a number, a
    // timestamp becomes something a chart offers to average.
    const declared = declaredAnalyticsStreams(
      analytics([event({ properties: [{ name: "occurred", type: "timestamp", pii: false }] })]),
    );

    expect(declared[0]?.properties[0]?.type).toBe("string");
  });

  it("leaves personal data out, and says that it did", () => {
    const declared = declaredAnalyticsStreams(
      analytics([
        event({
          properties: [
            { name: "amount", type: "number", pii: false },
            { name: "email", type: "string", pii: true },
          ],
        }),
      ]),
    );

    expect(declared[0]?.properties.map((property) => property.name)).toEqual(["amount"]);
    expect(declared[0]?.why).toContain("personal data");
  });

  it("proposes nothing for a pack that declared no analytics", () => {
    expect(declaredAnalyticsStreams(undefined)).toEqual([]);
  });
});

describe("analyticsStreamsForPack", () => {
  it("prefers what the author declared over what can be guessed", () => {
    const streams = analyticsStreamsForPack({
      runtime: runtime({ services: [service({})] }),
      analytics: analytics([event({})]),
    });

    expect(streams.map((stream) => stream.name)).toEqual(["checkout.completed"]);
  });

  it("falls back to inference only when the author said nothing", () => {
    const streams = analyticsStreamsForPack({
      runtime: runtime({ services: [service({})] }),
      analytics: undefined,
    });

    expect(streams.map((stream) => stream.name)).toEqual(["api.request"]);
  });
});

describe("toStreamSlug", () => {
  it("turns a name somebody typed into something a stream can be called", () => {
    expect(toStreamSlug("Staging PDF job")).toBe("staging-pdf-job");
  });

  it("drops leading characters that cannot start a stream name", () => {
    // The name has to start with a letter or the server refuses it.
    expect(toStreamSlug("2048 game")).toBe("game");
    expect(toStreamSlug("-staging-")).toBe("staging");
  });

  it("falls back rather than producing a name nothing will accept", () => {
    expect(toStreamSlug("2048")).toBe("deployment");
    expect(toStreamSlug("")).toBe("deployment");
  });
});

describe("proposeStreamForDeployment", () => {
  it("counts requests for something reachable at a URL", () => {
    const stream = proposeStreamForDeployment({
      name: "Staging",
      url: "https://staging.example.test",
    });

    expect(stream.name).toBe("staging.request");
    expect(stream.properties.map((property) => property.name)).toEqual([
      "path",
      "status",
      "duration_ms",
    ]);
    expect(stream.why).toContain("https://staging.example.test");
  });

  it("counts runs for something with no address — a job, a TUI", () => {
    const stream = proposeStreamForDeployment({ name: "Nightly PDF", url: null });

    expect(stream.name).toBe("nightly-pdf.run");
    expect(stream.properties.map((property) => property.name)).toEqual([
      "outcome",
      "duration_ms",
    ]);
  });

  it("lets the command speak only when there is no address to go on", () => {
    const fromCommand = proposeStreamForDeployment({
      name: "Api",
      url: null,
      command: "gunicorn app:main",
    });
    expect(fromCommand.name).toBe("api.request");

    // Reachable wins regardless of what the command looks like.
    const reachable = proposeStreamForDeployment({
      name: "Api",
      url: "https://api.example.test",
      command: "bun run build",
    });
    expect(reachable.name).toBe("api.request");
  });

  it("does not treat a URL that is not http as reachable", () => {
    const stream = proposeStreamForDeployment({ name: "Tui", url: "ssh://box.example.test" });
    expect(stream.name).toBe("tui.run");
  });
});
