import type { PackRuntime } from "@t3tools/contracts";

/**
 * A stream worth opening for an app, ready to hand to `analytics.streams.declare`.
 *
 * `why` is not decoration. Somebody is being asked to accept a stream they did
 * not write, and "because the pack exposes an HTTP service publicly" is the
 * difference between agreeing and clicking past it.
 */
export interface AnalyticsStreamTemplate {
  readonly name: string;
  readonly purpose: string;
  readonly why: string;
  readonly properties: ReadonlyArray<{
    readonly name: string;
    readonly type: "string" | "number" | "boolean";
    readonly required: boolean;
  }>;
}

const REQUEST_PROPERTIES = [
  { name: "path", type: "string", required: true },
  { name: "status", type: "number", required: true },
  { name: "duration_ms", type: "number", required: false },
] as const;

const HEALTH_PROPERTIES = [
  { name: "healthy", type: "boolean", required: true },
  { name: "duration_ms", type: "number", required: false },
] as const;

const RUN_PROPERTIES = [
  { name: "outcome", type: "string", required: true },
  { name: "duration_ms", type: "number", required: false },
] as const;

/**
 * Proposes the streams an app could report, from what it already declares.
 *
 * It reads the manifest rather than the source. A proposal drawn from what a
 * pack says about itself — this service is public, it answers on this health
 * path, it is a terminal program — can be shown next to the reason it was
 * proposed and is the same every time. Guessing from source would produce a
 * different set on a rename and could not explain itself.
 *
 * Deliberately small. Three or four streams somebody will actually read beat
 * twenty that get declared once and never queried, and every one of these has
 * an obvious first question it answers.
 */
export function proposeAnalyticsStreams(runtime: PackRuntime): ReadonlyArray<AnalyticsStreamTemplate> {
  const services = runtime.services ?? [];
  const templates: AnalyticsStreamTemplate[] = [];

  const reachable = services.filter((service) => service.exposure !== "loopback");
  for (const service of reachable) {
    if (service.protocol !== "http" && service.protocol !== "https") {
      continue;
    }
    templates.push({
      name: `${service.id}.request`,
      purpose: `Requests served by ${service.title}.`,
      why: `${service.title} answers ${service.protocol.toUpperCase()} and is reachable (${service.exposure}).`,
      properties: [...REQUEST_PROPERTIES],
    });
    if (service.healthPath !== undefined) {
      templates.push({
        name: `${service.id}.health`,
        purpose: `Health checks against ${service.healthPath}.`,
        why: `${service.title} declares a health path, so it can already say whether it is up.`,
        properties: [...HEALTH_PROPERTIES],
      });
    }
  }

  // A terminal program has no request to count, but it still starts and either
  // finishes or does not, which is the only thing anybody asks of one.
  if (templates.length === 0 && runtime.commands.start !== undefined) {
    templates.push({
      name: "run.completed",
      purpose: "Each run of the program, and how it ended.",
      why: "It declares a start command but no reachable service, so a run is the unit of use.",
      properties: [...RUN_PROPERTIES],
    });
  }

  return templates;
}
