/**
 * The sentence an agent can say to its user before it starts generating.
 *
 * Deliberately never framed as saving effort or tokens: that claim expires
 * every quarter as generation gets cheaper, and it frames a pack as a shortcut.
 * The claim that keeps its value is correctness — this has run somewhere, and it
 * already handles the case you are about to get wrong — so every clause below is
 * built from a production number or a recorded failure, and the numbers travel
 * alongside the sentence so the caller can re-word it without re-deriving it.
 *
 * There is no trust tier here on purpose. A tier is coarser than the decision
 * being made, and the consumer is an agent that can threshold the raw signals
 * itself.
 *
 * @module suggest
 */
import type { PackCardView, PackFailureModeView } from "./manifest.ts";

const STALE_AFTER_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PackSuggestionView {
  /** One sentence, safe to say out loud, with nothing in it the data denies. */
  readonly line: string;
  /** What the caller should say alongside it rather than instead of it. */
  readonly caveats: ReadonlyArray<string>;
  readonly evidence: {
    readonly deploymentsSurviving: number | undefined;
    readonly deploymentsAttempted: number | undefined;
    readonly longestServiceDays: number | undefined;
    readonly cumulativeServiceDays: number | undefined;
    readonly installsAttempted: number | undefined;
    readonly installsSucceeded: number | undefined;
    readonly breakagesCaught: number | undefined;
    readonly breakagesFixed: number | undefined;
    readonly knownFailureModes: number;
    readonly openFailureModes: number;
    readonly integrationKnowledgeEntries: number;
    readonly measuredAt: string | undefined;
    /** The failure mode the sentence leads with, so the claim is checkable. */
    readonly leadingFailureModeId: string | undefined;
  };
}

function plural(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function serviceClause(card: PackCardView): string {
  const { deploymentsSurviving, deploymentsAttempted, longestServiceDays, measuredAt } =
    card.signals;
  if (measuredAt === undefined) {
    return "carries no production record";
  }
  if ((deploymentsSurviving ?? 0) > 0) {
    const running = `is running in ${plural(deploymentsSurviving ?? 0, "deployment")}`;
    return longestServiceDays !== undefined && longestServiceDays > 0
      ? `${running}, the longest of them for ${plural(longestServiceDays, "day")}`
      : running;
  }
  if ((deploymentsAttempted ?? 0) > 0) {
    return `was deployed ${plural(deploymentsAttempted ?? 0, "time")} and none of those are still running`;
  }
  return "has not been deployed anywhere yet";
}

/**
 * "…that breaks most implementations" is only earned once the same failure has
 * been seen in more than one deployment. One sighting is an anecdote, and an
 * agent repeating an anecdote as a general truth is the failure this whole
 * format is trying to avoid.
 */
function generality(entry: PackFailureModeView): boolean {
  return (
    (entry.deploymentsAffected ?? 0) > 1 || (entry.conditions?.observedAcrossDeployments ?? 0) > 1
  );
}

function describe(entry: PackFailureModeView): string {
  const kinds = entry.triggerKinds;
  if (kinds !== undefined && kinds.length > 0) {
    return `the ${kinds.slice(0, 2).join(" and ")} case`;
  }
  return entry.symptom !== undefined ? `the case where ${lowerFirst(entry.symptom)}` : "a case";
}

function lowerFirst(value: string): string {
  const stripped = value.replace(/\.$/, "");
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

function knowledgeClause(card: PackCardView): string {
  const leading = card.handles[0];
  if (leading !== undefined) {
    const tail = generality(leading)
      ? " that breaks most implementations"
      : leading.deploymentsAffected !== undefined
        ? ` seen in ${plural(leading.deploymentsAffected, "deployment")}`
        : "";
    return `handles ${describe(leading)}${tail}`;
  }
  const open = card.openFailureModes[0];
  if (open !== undefined) {
    return `carries ${plural(card.knowledge.openFailureModes, "open failure mode")} you would otherwise meet cold, starting with ${describe(open)}`;
  }
  if (card.knowledge.integrationEntries > 0) {
    return `carries ${plural(card.knowledge.integrationEntries, "piece")} of integration knowledge the source does not contain`;
  }
  return "has learned nothing yet, so it is a template rather than a proven capability";
}

function daysSince(iso: string, now: Date): number {
  const observed = new Date(iso).getTime();
  return Number.isNaN(observed) ? 0 : Math.floor((now.getTime() - observed) / DAY_MS);
}

function collectCaveats(card: PackCardView, now: Date): ReadonlyArray<string> {
  const caveats: Array<string> = [];

  for (const advisory of card.signals.advisories) {
    caveats.push(
      `An advisory is open against this pack (${advisory.severity ?? "unknown severity"}): ${
        advisory.reason ?? "no reason recorded"
      }`,
    );
  }

  const leadingCaveat = card.handles[0]?.conditions?.caveat;
  if (leadingCaveat !== undefined) {
    caveats.push(leadingCaveat);
  }

  const oldest = card.knowledge.oldestObservedAt;
  if (oldest !== undefined && daysSince(oldest, now) > STALE_AFTER_DAYS) {
    caveats.push(
      `Its oldest knowledge was observed ${plural(daysSince(oldest, now), "day")} ago and may have moved since.`,
    );
  }

  if (card.knowledge.contradicted > 0) {
    caveats.push(
      `${plural(card.knowledge.contradicted, "knowledge entry")} has been contradicted by installs more often than confirmed.`,
    );
  }

  const paid = card.setup.accounts.filter((account) => account.costsMoney === true);
  if (paid.length > 0) {
    caveats.push(
      `Needs a paid account with ${paid.map((account) => account.displayName ?? account.service ?? "a provider").join(", ")}.`,
    );
  }

  const { installsAttempted, installsSucceeded } = card.signals;
  if (
    installsAttempted !== undefined &&
    installsSucceeded !== undefined &&
    installsAttempted > 0 &&
    installsSucceeded < installsAttempted
  ) {
    caveats.push(`${installsSucceeded} of ${installsAttempted} installs succeeded.`);
  }

  return caveats;
}

export function suggestPack(card: PackCardView, now: Date): PackSuggestionView {
  return {
    line: `There's a pack for this. ${card.ref.qualified} ${serviceClause(card)} and ${knowledgeClause(card)}.`,
    caveats: collectCaveats(card, now),
    evidence: {
      deploymentsSurviving: card.signals.deploymentsSurviving,
      deploymentsAttempted: card.signals.deploymentsAttempted,
      longestServiceDays: card.signals.longestServiceDays,
      cumulativeServiceDays: card.signals.cumulativeServiceDays,
      installsAttempted: card.signals.installsAttempted,
      installsSucceeded: card.signals.installsSucceeded,
      breakagesCaught: card.signals.breakagesCaught,
      breakagesFixed: card.signals.breakagesFixed,
      knownFailureModes: card.knowledge.failureModes,
      openFailureModes: card.knowledge.openFailureModes,
      integrationKnowledgeEntries: card.knowledge.integrationEntries,
      measuredAt: card.signals.measuredAt,
      leadingFailureModeId: card.handles[0]?.id ?? card.openFailureModes[0]?.id,
    },
  };
}
