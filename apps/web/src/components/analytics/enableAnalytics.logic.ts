/**
 * Asking for a thing that is already live to start reporting.
 *
 * This is deliberately not about packs. Most of what gets deployed is not a
 * published pack — a TUI, a job that renders a PDF, a front end somebody put up
 * — and all of them can report. What the prompt needs is a deployment and a
 * stream worth opening; where the stream came from (a manifest the author wrote,
 * or the shape of what was deployed) is the caller's problem, not this one's.
 *
 * @module components/analytics/enableAnalytics.logic
 */
import type { AnalyticsStreamTemplate } from "@t3tools/shared/analyticsStreamTemplates";

export interface EnableAnalyticsSubject {
  readonly name: string;
  readonly url: string | null;
  /** How many streams it already reports to. */
  readonly reportsToCount: number;
}

/**
 * What to ask an agent for when somebody wants a live deployment to report.
 *
 * It only makes sense once something has been deployed — there is no point
 * describing how to report from a thing that does not exist yet — and it exists
 * as its own prompt because the two halves have to happen together and neither
 * is obvious alone: the code has to send the event, and the *deploy* has to
 * declare the stream, because the ingest key is minted into a deploy and cannot
 * be fetched afterwards. Somebody who only does the first half ends up with an
 * app posting into nothing.
 *
 * The proposed properties are a starting point, not a specification. The
 * declaration has to match what the code actually sends, and the code is the
 * thing that knows.
 */
export function buildEnableAnalyticsPrompt(input: {
  /** What this is about — a pack's qualified name, or just the deployment. */
  readonly subject: string;
  readonly stream: AnalyticsStreamTemplate | null;
  readonly deployment: EnableAnalyticsSubject | null;
}): string | null {
  const { deployment, stream } = input;
  if (deployment === null || stream === null) {
    return null;
  }

  const where = deployment.url === null ? "" : ` It is live at ${deployment.url}.`;
  const naming =
    input.subject === deployment.name
      ? `the ${deployment.name} deployment`
      : `the ${deployment.name} deployment of ${input.subject}`;

  const lines = [
    deployment.reportsToCount > 0
      ? `Change what ${naming} reports.`
      : `Make ${naming} report what it does.`,
    "",
    deployment.reportsToCount > 0
      ? `It already reports to ${deployment.reportsToCount} stream${
          deployment.reportsToCount === 1 ? "" : "s"
        }.${where}`
      : `Nothing it does is recorded yet.${where}`,
  ];

  const properties = stream.properties
    .map((property) => `${property.name} (${property.type})`)
    .join(", ");
  lines.push(
    "",
    `Report a \`${stream.name}\` stream — ${stream.purpose} ${stream.why}`,
    properties.length === 0
      ? "It has no properties proposed, so work out what is worth recording with each event."
      : `Proposed properties: ${properties}.`,
  );

  lines.push(
    "",
    "Both halves have to happen, and in this order:",
    "1. Add the reporting to the code, so it posts the event when the thing actually happens.",
    // The ordering is not a preference. A key that cannot be fetched later means
    // declaring has to be part of a deploy, so the code must be ready first.
    `2. Redeploy asking for the \`${stream.name}\` stream, so the ingest key is minted into the deploy. It cannot be fetched afterwards, so a deploy that does not ask for it produces something that can never report.`,
    "",
    "Tell me if the proposed properties are wrong for what the code actually sends — the declaration should follow the events, not the other way round.",
  );

  return lines.join("\n");
}
