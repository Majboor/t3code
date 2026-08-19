import { expect, it } from "@effect/vitest";
import { describe } from "vitest";

import { AnalyticsStreamId, ProjectId, type AnalyticsStream } from "@t3tools/contracts";

import type { WorkspaceOrigin } from "../deploy/cliOutput.ts";
import {
  describeStreamNameProblem,
  formatDeclaredStream,
  formatProperties,
  formatQueryResult,
  formatStreamList,
  formatUnknownStream,
  parseAnalyticsProperties,
} from "./cliOutput.ts";

const workspace: WorkspaceOrigin = { origin: "http://127.0.0.1:3773", observed: true };
const projectId = ProjectId.make("project-1");

const stream: AnalyticsStream = {
  id: AnalyticsStreamId.make("astream_1"),
  projectId,
  name: "page.view" as AnalyticsStream["name"],
  purpose: "Which pages get read" as AnalyticsStream["purpose"],
  properties: [
    {
      name: "path" as AnalyticsStream["properties"][number]["name"],
      type: "string",
      purpose: "path" as AnalyticsStream["properties"][number]["purpose"],
      required: true,
    },
    {
      name: "seconds" as AnalyticsStream["properties"][number]["name"],
      type: "number",
      purpose: "seconds" as AnalyticsStream["properties"][number]["purpose"],
      required: false,
    },
  ],
  ingestKeyName: "set" as AnalyticsStream["ingestKeyName"],
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z",
  archivedAt: null,
};

describe("describeStreamNameProblem", () => {
  it("accepts the names the contract accepts", () => {
    expect(describeStreamNameProblem("page.view")).toBeNull();
    expect(describeStreamNameProblem("signup_done-2")).toBeNull();
  });

  it("refuses a name before it becomes a decode failure halfway through a deploy", () => {
    expect(describeStreamNameProblem("Page.View")).toContain("not a usable stream name");
    expect(describeStreamNameProblem("2fast")).toContain("not a usable stream name");
    expect(describeStreamNameProblem("")).toContain("cannot be empty");
    expect(describeStreamNameProblem("x".repeat(65))).toContain("longer than 64");
  });
});

describe("parseAnalyticsProperties", () => {
  it("reads name:type:required triples", () => {
    expect(parseAnalyticsProperties("path:string:required,seconds:number")).toEqual([
      { name: "path", type: "string", purpose: "path", required: true },
      { name: "seconds", type: "number", purpose: "seconds", required: false },
    ]);
  });

  it("rejects a type a chart could do nothing with", () => {
    expect(() => parseAnalyticsProperties("path:date")).toThrow("expected string, number");
  });

  it("rejects a property name the schema would reject later", () => {
    expect(() => parseAnalyticsProperties("Path:string")).toThrow("name:type:required");
  });
});

describe("formatProperties", () => {
  it("marks which ones an event must carry", () => {
    expect(formatProperties(stream.properties)).toBe("path:string (required), seconds:number");
  });

  it("says none rather than printing an empty string", () => {
    expect(formatProperties([])).toBe("none declared");
  });
});

describe("formatDeclaredStream", () => {
  it("shows the key once and says where the stream turned up", () => {
    const output = formatDeclaredStream({ stream, ingestKey: "secret-key", workspace });
    expect(output).toContain("Ingest key (shown once): secret-key");
    expect(output).toContain("http://127.0.0.1:3773/analytics/project-1");
    // Declaring alone wires nothing, and the only route that hands a
    // deployment this key is a deploy.
    expect(output).toContain("t3 deploy run <targetId> --analytics-stream page.view");
  });
});

describe("formatStreamList", () => {
  it("says what each stream accepts and where to look at it", () => {
    const output = formatStreamList({ streams: [stream], workspace });
    expect(output).toContain("Stream");
    expect(output).toContain("path:string (required)");
    expect(output).toContain("Which pages get read");
    expect(output).toContain("http://127.0.0.1:3773/analytics/project-1");
  });

  it("names both ways to get a first stream", () => {
    const output = formatStreamList({ streams: [], workspace, projectId });
    expect(output).toContain("t3 analytics declare --project project-1");
    expect(output).toContain("t3 deploy run <targetId> --analytics-stream page.view");
  });
});

describe("formatUnknownStream", () => {
  it("lists the streams that do exist", () => {
    const output = formatUnknownStream({ requested: "pageview", streams: [stream], projectId });
    expect(output).toContain("No stream named pageview");
    expect(output).toContain("page.view");
  });

  it("offers to declare one when the project has none", () => {
    const output = formatUnknownStream({ requested: "page.view", streams: [], projectId });
    expect(output).toContain("t3 analytics declare");
  });
});

describe("formatQueryResult", () => {
  it("explains an empty stream rather than printing a bare 'no events'", () => {
    const output = formatQueryResult({
      result: { stream: stream.name, aggregate: "count", buckets: [] },
      workspace,
      projectId,
    });
    expect(output).toContain("No events on page.view yet");
    expect(output).toContain("the key its deploy injected");
  });

  it("names the grouping column so a number is readable on its own", () => {
    const output = formatQueryResult({
      result: {
        stream: stream.name,
        aggregate: "count",
        buckets: [{ group: "/", value: 12, events: 12 }],
      },
      workspace,
      projectId,
      groupBy: "path",
    });
    expect(output).toContain("count by path");
    expect(output).toContain("path");
    expect(output).toContain("12");
  });
});
