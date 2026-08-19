/**
 * What the analytics commands print, and how their one awkward flag is parsed.
 *
 * Analytics is reachable only if something declared a stream and something
 * handed a deployment a key for it, and both of those happen in a CLI command
 * whose output used to be two lines. The point of this module is that after
 * running one of them you know what exists, what it will accept, and which page
 * it turned up on.
 *
 * @module analytics/cliOutput
 */
import type { AnalyticsQueryResult, AnalyticsStream } from "@t3tools/contracts";

import { renderDetails, renderTable, formatInstant } from "../deploy/cliOutput.ts";
import type { WorkspaceOrigin } from "../deploy/cliOutput.ts";

/** A property as the flag spells it, before the schema brands it. */
export interface ParsedAnalyticsProperty {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly purpose: string;
  readonly required: boolean;
}

const analyticsPage = (workspace: WorkspaceOrigin, projectId: string): string =>
  `${workspace.origin.replace(/\/+$/, "")}/analytics/${encodeURIComponent(projectId)}`;

/**
 * The same rule `AnalyticsName` enforces, checked before anything is written.
 *
 * Duplicated deliberately: the schema rejects a bad name deep inside a declare
 * or a deploy, where it surfaces as a decode failure naming a branded type. A
 * stream name is the first thing a person types and the easiest to get wrong.
 */
export function describeStreamNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A stream name cannot be empty.";
  if (trimmed.length > 64) return `'${trimmed}' is longer than 64 characters.`;
  if (!/^[a-z][a-z0-9_.-]*$/.test(trimmed)) {
    return `'${trimmed}' is not a usable stream name. Use lowercase letters, digits, dot, dash or underscore, starting with a letter — for example page.view.`;
  }
  return null;
}

/**
 * Properties as `name:type:required` triples, so declaring a stream stays one
 * command. The shape is the point of the contract, so it cannot be optional.
 */
export function parseAnalyticsProperties(raw: string): ReadonlyArray<ParsedAnalyticsProperty> {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name = "", type = "string", required = "false"] = entry.split(":");
      if (type !== "string" && type !== "number" && type !== "boolean") {
        throw new Error(`${name} has type ${type}; expected string, number or boolean.`);
      }
      const nameProblem = describeStreamNameProblem(name);
      if (nameProblem !== null) {
        throw new Error(`${nameProblem} Properties are written name:type:required.`);
      }
      return {
        name,
        type,
        purpose: name,
        required: required === "true" || required === "required",
      };
    });
}

export function formatProperties(
  properties: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
  }>,
): string {
  if (properties.length === 0) return "none declared";
  return properties
    .map((property) => `${property.name}:${property.type}${property.required ? " (required)" : ""}`)
    .join(", ");
}

export function formatDeclaredStream(input: {
  readonly stream: AnalyticsStream;
  readonly ingestKey: string;
  readonly workspace: WorkspaceOrigin;
}): string {
  const projectId = input.stream.projectId as string;
  return [
    `Declared ${input.stream.name} (${input.stream.id}) on ${projectId}.`,
    renderDetails([
      ["Accepts", formatProperties(input.stream.properties)],
      ["Purpose", input.stream.purpose],
    ]),
    "",
    // Unchanged wording on the key line: it is the one line people are told to
    // look for, and it is shown exactly once because nothing can reproduce it.
    `Ingest key (shown once): ${input.ingestKey}`,
    "",
    `Analytics page: ${analyticsPage(input.workspace, projectId)}`,
    `Nothing reports to it yet. A deployment can only be handed this key at deploy time: t3 deploy run <targetId> --analytics-stream ${input.stream.name}`,
  ].join("\n");
}

export function formatStreamList(input: {
  readonly streams: ReadonlyArray<AnalyticsStream>;
  readonly workspace: WorkspaceOrigin;
  readonly projectId?: string | undefined;
}): string {
  if (input.streams.length === 0) {
    return [
      "No streams declared.",
      "",
      "A stream is declared either on its own, or by the deploy that will report to it:",
      `  t3 analytics declare --project ${input.projectId ?? "<projectId>"} --name page.view --purpose 'Which pages get read' --properties path:string:required`,
      "  t3 deploy run <targetId> --analytics-stream page.view",
    ].join("\n");
  }

  const rows = input.streams.map((stream) => [
    stream.name,
    formatProperties(stream.properties),
    formatInstant(stream.createdAt),
    stream.purpose,
  ]);
  const projectIds = [...new Set(input.streams.map((stream) => stream.projectId as string))];

  return [
    renderTable(["Stream", "Properties", "Declared", "Purpose"], rows),
    "",
    ...projectIds.map(
      (projectId) => `Analytics page: ${analyticsPage(input.workspace, projectId)}`,
    ),
  ].join("\n");
}

export function analyticsStreamJson(stream: AnalyticsStream): Record<string, unknown> {
  return {
    id: stream.id,
    projectId: stream.projectId,
    name: stream.name,
    purpose: stream.purpose,
    properties: stream.properties,
    createdAt: stream.createdAt,
    updatedAt: stream.updatedAt,
  };
}

export function formatUnknownStream(input: {
  readonly requested: string;
  readonly streams: ReadonlyArray<AnalyticsStream>;
  readonly projectId: string;
}): string {
  if (input.streams.length === 0) {
    return `No stream named ${input.requested} on ${input.projectId}, and this project has none at all. Declare one with \`t3 analytics declare\`, or let a deploy declare it: t3 deploy run <targetId> --analytics-stream ${input.requested}`;
  }
  return [
    `No stream named ${input.requested} on ${input.projectId}.`,
    "",
    "This project has these:",
    ...input.streams.map((stream) => `  ${stream.name}  ${formatProperties(stream.properties)}`),
  ].join("\n");
}

export function formatQueryResult(input: {
  readonly result: AnalyticsQueryResult;
  readonly workspace: WorkspaceOrigin;
  readonly projectId: string;
  readonly groupBy?: string | undefined;
}): string {
  const link = `Analytics page: ${analyticsPage(input.workspace, input.projectId)}`;
  if (input.result.buckets.length === 0) {
    return [
      `No events on ${input.result.stream} yet.`,
      "",
      "A stream stays empty until a deployment posts to it with the key its deploy injected.",
      link,
    ].join("\n");
  }

  const rows = input.result.buckets.map((bucket) => [
    bucket.group ?? "all",
    String(bucket.value),
    String(bucket.events),
  ]);
  return [
    `${input.result.stream} — ${input.result.aggregate}${input.groupBy === undefined ? "" : ` by ${input.groupBy}`}`,
    renderTable([input.groupBy ?? "Group", "Value", "Events"], rows),
    "",
    link,
  ].join("\n");
}
