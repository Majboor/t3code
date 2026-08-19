import type { PackAnalytics, PackRuntime } from "@t3tools/contracts";

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
export function proposeAnalyticsStreams(
  runtime: PackRuntime,
): ReadonlyArray<AnalyticsStreamTemplate> {
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

/**
 * The streams a pack said it emits, as declarations.
 *
 * A manifest's `analytics.events` is the author describing their own telemetry:
 * the event names the code actually sends, with the properties it actually
 * attaches. Nothing else here can know that, so when it is present it beats any
 * amount of inference from the runtime shape.
 *
 * Two mappings are not one-to-one and both are deliberate:
 *
 * - A `timestamp` property becomes a string. A stream property is one of three
 *   types and none of them is a date, and a timestamp read as a number would
 *   quietly become something a chart offers to average.
 * - Properties marked `pii` are left out. The manifest flags them so redaction
 *   and retention can be applied downstream, and a stream property carries no
 *   such flag — declaring one here would strip the marking off it. These
 *   declarations are made during a deploy with nobody reading them, which is
 *   the wrong moment to decide that personal data should start being collected.
 */
export function declaredAnalyticsStreams(
  analytics: PackAnalytics | undefined,
): ReadonlyArray<AnalyticsStreamTemplate> {
  const events = analytics?.events ?? [];

  return events.map((event) => {
    const declared = event.properties ?? [];
    const carried = declared.filter((property) => !property.pii);
    const withheld = declared.length - carried.length;

    return {
      name: event.name,
      purpose: event.description,
      why:
        `The pack declares it emits ${event.name} from its ${event.source}.` +
        (withheld === 0
          ? ""
          : ` ${withheld} propert${withheld === 1 ? "y is" : "ies are"} marked as personal data and left out.`),
      properties: carried.map((property) => ({
        name: property.name,
        // A stream property is string, number or boolean; a timestamp is text.
        type: property.type === "timestamp" ? ("string" as const) : property.type,
        required: false,
      })),
    };
  });
}

/** Anything that names a server rather than a thing that runs and stops. */
const SERVING_COMMAND = /\b(serve|server|nginx|caddy|httpd|uvicorn|gunicorn|daphne|puma)\b/;

/**
 * A stream name ends up in URLs, in generated code and in chart titles, so it
 * is a slug. A deployment name is whatever somebody typed.
 */
export function toStreamSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    // The pattern requires a letter first, so a deployment called "2048" or
    // "-staging" has to lose its leading characters rather than produce a name
    // the server will refuse.
    .replace(/^[^a-z]+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  return slug.length === 0 ? "deployment" : slug;
}

/**
 * What a deployed thing should report, when there is no manifest to ask.
 *
 * Most of what gets deployed is not a published pack — a TUI, a job that
 * renders a PDF, a front end somebody just put up — and those have no
 * `analytics.events` to read. What they do have is a shape: something reachable
 * at a URL answers requests, and something with no address runs and finishes.
 * Those are different units of use and they take different properties, which is
 * the whole of the inference.
 *
 * The command only gets a say when there is no address, because a name like
 * `serve` is a weaker signal than actually being reachable.
 */
export function proposeStreamForDeployment(input: {
  readonly name: string;
  readonly url: string | null;
  readonly command?: string | undefined;
}): AnalyticsStreamTemplate {
  const slug = toStreamSlug(input.name);
  const reachable = input.url !== null && /^https?:\/\//i.test(input.url);
  const looksLikeServer = reachable || SERVING_COMMAND.test(input.command ?? "");

  if (looksLikeServer) {
    return {
      name: `${slug}.request`,
      purpose: `Requests served by ${input.name}.`,
      why: reachable
        ? `It is live at ${input.url}, so a request is the unit of use.`
        : "Its command starts a server, so a request is the unit of use.",
      properties: [...REQUEST_PROPERTIES],
    };
  }

  return {
    name: `${slug}.run`,
    purpose: `Each run of ${input.name}, and how it ended.`,
    why: "It has no address and does not start a server, so it is something that runs rather than something that answers.",
    properties: [...RUN_PROPERTIES],
  };
}

/**
 * What a pack should report, preferring what it declared over what can be
 * guessed about it. Inference is the fallback for a pack whose author said
 * nothing, not a second opinion on one who did.
 */
export function analyticsStreamsForPack(input: {
  readonly runtime: PackRuntime;
  readonly analytics?: PackAnalytics | undefined;
}): ReadonlyArray<AnalyticsStreamTemplate> {
  const declared = declaredAnalyticsStreams(input.analytics);
  return declared.length > 0 ? declared : proposeAnalyticsStreams(input.runtime);
}
