import type {
  PackConditionAxis,
  PackConditions,
  PackFailureMode,
  PackIntegration,
  PackIntegrationTarget,
  PackKnowledge,
  PackRequirements,
  PackScarRecord,
} from "@t3tools/contracts";

import type { PackVisibilityScope } from "./packDetailSource";

const MONTH_NAMES: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const AXIS_LABELS: Record<PackConditionAxis, string> = {
  "account-tier": "account tier",
  region: "region",
  "console-version": "console version",
  "api-version": "API version",
  "sdk-version": "SDK version",
  "runtime-version": "runtime version",
  plan: "plan",
  locale: "locale",
  "deployment-target": "deployment target",
};

export const PACK_INTEGRATION_TARGET_LABELS: Record<PackIntegrationTarget, string> = {
  generic: "Any agent",
  t3: "T3",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  windsurf: "Windsurf",
  lovable: "Lovable",
  replit: "Replit",
  v0: "v0",
  bolt: "Bolt",
};

function formatList(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  const head = values.slice(0, -1).join(", ");
  return `${head} and ${values.at(-1) ?? ""}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export function pluralize(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

/**
 * Rendered in UTC rather than in the reader's zone: an observation that slid
 * into the previous month because the reader sits west of the meridian would
 * misdate the very thing the caveat is about.
 */
export function formatObservedMonth(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${MONTH_NAMES[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`;
}

export function formatObservedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`;
}

export interface PackConditionsDescription {
  /** What was recorded: when, and along which axes it was narrowed. */
  readonly observed: string;
  /** What was not, which is the half that decides whether it holds for you. */
  readonly untested: string;
}

/**
 * The conditions a single claim held under, said out loud. Knowledge correct on
 * a standard-tier US account can be wrong on another tier, in another region or
 * against an older console, and that path is in nobody's test environment — so
 * the caveat is rendered beside every claim rather than once at the top.
 */
export function describeConditions(conditions: PackConditions): PackConditionsDescription {
  const narrowings: string[] = [];
  if (conditions.accountTier !== undefined) {
    narrowings.push(`on ${conditions.accountTier}-tier`);
  }
  if (conditions.regions !== undefined && conditions.regions.length > 0) {
    narrowings.push(`in ${formatList([...conditions.regions])}`);
  }
  if (conditions.consoleVersion !== undefined) {
    narrowings.push(`against console ${conditions.consoleVersion}`);
  }
  if (conditions.apiVersion !== undefined) {
    narrowings.push(`against API ${conditions.apiVersion}`);
  }
  for (const entry of conditions.other ?? []) {
    narrowings.push(`${AXIS_LABELS[entry.axis]} ${entry.value}`);
  }

  const head = [`Observed in ${formatObservedMonth(conditions.observedAt)}`, ...narrowings].join(
    ", ",
  );
  const across = conditions.observedAcrossDeployments;
  const observed =
    across === undefined
      ? `${head}.`
      : across === 1
        ? `${head}, in one deployment — an anecdote so far.`
        : `${head}, across ${across} deployments.`;

  const untestedAxes = conditions.untestedAxes ?? [];
  if (untestedAxes.length > 0) {
    const labels = formatList(untestedAxes.map((axis) => AXIS_LABELS[axis]));
    const verb = untestedAxes.length === 1 ? "was" : "were";
    return { observed, untested: `${capitalize(labels)} ${verb} never varied — yours may differ.` };
  }

  return {
    observed,
    untested:
      narrowings.length === 0
        ? "No account tier, region or console version was recorded, so there is nothing to compare yours against."
        : "Only what is listed was recorded. Any axis not named here is unknown, so yours may differ.",
  };
}

export interface PackScarRecordDescription {
  readonly hasProduction: boolean;
  readonly headline: string;
}

/**
 * Raw counts with their denominators, never a rate and never a badge. A pack
 * that has run nowhere says so in the first line, because "no breakages" and
 * "no deployments" are opposite claims and an absent record reads like the
 * good one.
 */
export function describeScarRecord(record: PackScarRecord): PackScarRecordDescription {
  if (record.installsAttempted === 0 && record.deploymentsAttempted === 0) {
    return {
      hasProduction: false,
      headline:
        "Nothing has run behind this yet. No installs, no deployments, nothing caught. Everything it claims is untested, and it should be read differently from a pack that has been through production.",
    };
  }

  return {
    hasProduction: true,
    headline: [
      `${record.deploymentsSurviving} of ${pluralize(record.deploymentsAttempted, "deployment")} still running`,
      `${pluralize(record.cumulativeServiceDays, "deployment-day")}`,
      `${pluralize(record.breakagesCaught, "breakage")} caught, ${record.breakagesFixed} fixed`,
    ].join(" · "),
  };
}

/**
 * The same judgement in one clause, for the top of the page. A pack with no
 * production behind it has to say so where the name is, not further down where
 * it would read as equivalent to one that has some.
 */
export function describeScarRecordBrief(record: PackScarRecord): string {
  const { hasProduction } = describeScarRecord(record);
  return hasProduction
    ? `${record.deploymentsSurviving} of ${pluralize(record.deploymentsAttempted, "deployment")} still running`
    : "Nothing has run behind this yet";
}

export interface PackVisibilityDescription {
  readonly label: string;
  readonly detail: string;
}

export const PACK_VISIBILITY_DESCRIPTIONS: Record<PackVisibilityScope, PackVisibilityDescription> =
  {
    workspace: {
      label: "This workspace",
      detail: "Private to the workspace it was cut from. Nobody outside it can find or install it.",
    },
    tenant: {
      label: "This tenant",
      detail: "Anyone inside this tenant can find and install it. Nobody outside it can.",
    },
    organization: {
      label: "Your organization",
      detail: "Anyone in your organization can find and install it. Nobody outside it can.",
    },
    unlisted: {
      label: "Anyone with the link",
      detail: "Installable by anyone holding the link, and absent from search.",
    },
    public: {
      label: "The marketplace",
      detail: "Findable and installable by anyone.",
    },
  };

/**
 * Wider means more people. Ordered so the control can tell an act of publishing
 * apart from an act of withdrawal and say the right consequence for each.
 */
const VISIBILITY_WIDTH: Record<PackVisibilityScope, number> = {
  workspace: 0,
  organization: 1,
  tenant: 1,
  unlisted: 2,
  public: 3,
};

/** The scopes the control offers, narrowest first. */
export const PACK_VISIBILITY_CHOICES: readonly PackVisibilityScope[] = [
  "workspace",
  "organization",
  "unlisted",
  "public",
];

export interface PackVisibilityChangeDescription {
  readonly title: string;
  readonly consequence: string;
  /** Said only when it applies, so it keeps its force when it does. */
  readonly warning: string | null;
  readonly confirmLabel: string;
  readonly widening: boolean;
}

/**
 * What the change actually does, in plain language and before it happens.
 * Publishing is a second act rather than a side effect of deploying, so the
 * consequence has to be legible at the moment of consent — including the part
 * that cannot be taken back.
 */
export function describeVisibilityChange(
  from: PackVisibilityScope,
  to: PackVisibilityScope,
  record: PackScarRecord,
): PackVisibilityChangeDescription {
  const widening = VISIBILITY_WIDTH[to] > VISIBILITY_WIDTH[from];
  const { hasProduction } = describeScarRecord(record);
  const warning =
    widening && !hasProduction
      ? "Nothing has run behind this yet, so it publishes with a record of zeros. That is the honest reading of it — publish only if you mean to put an unproven pack in front of people who will read it next to proven ones."
      : null;

  if (to === "public") {
    return {
      title: "Publish to the marketplace?",
      consequence:
        "Anyone will be able to find and install this. Its record travels with it — every failure mode it has written down, every deployment it has lost, and every count as it stands. Installs made while it is public keep running if you narrow it again later; you cannot recall them.",
      warning,
      confirmLabel: "Publish",
      widening,
    };
  }

  if (to === "unlisted") {
    return {
      title: "Share this by link?",
      consequence:
        "Anyone holding the link can install it. It stays out of search, so it is neither indexed nor ranked, and you cannot tell who has passed the link on.",
      warning,
      confirmLabel: "Share by link",
      widening,
    };
  }

  if (to === "workspace") {
    return {
      title: "Make this workspace-private?",
      consequence:
        "It leaves search and stops being installable by anyone new. Deployments already running it keep running on the version they have.",
      warning: null,
      confirmLabel: "Make private",
      widening,
    };
  }

  return {
    title: `Share this with ${PACK_VISIBILITY_DESCRIPTIONS[to].label.toLowerCase()}?`,
    consequence: `${PACK_VISIBILITY_DESCRIPTIONS[to].detail} Its record goes with it, including the releases you abandoned.`,
    warning,
    confirmLabel: "Share",
    widening,
  };
}

/**
 * Generic first, then whatever targets the manifest actually carries. Targets
 * are not invented here: a variant exists because somebody wrote one, and
 * offering a Lovable button that pastes the generic prompt would be a lie about
 * where the instructions came from.
 */
export function listIntegrationTargets(
  integration: PackIntegration,
): readonly PackIntegrationTarget[] {
  const declared: PackIntegrationTarget[] = [];
  for (const variant of integration.variants ?? []) {
    if (variant.target === "generic") continue;
    if (declared.includes(variant.target)) continue;
    declared.push(variant.target);
  }
  return ["generic", ...declared];
}

export function resolveIntegrationPrompt(
  integration: PackIntegration,
  target: PackIntegrationTarget,
): string {
  if (target === "generic") return integration.prompt;
  const variant = integration.variants?.find((entry) => entry.target === target);
  return variant?.prompt ?? integration.prompt;
}

const RESOLUTION_RANK: Record<PackFailureMode["resolution"]["kind"], number> = {
  open: 0,
  upstream: 1,
  mitigated: 2,
  fixed: 3,
};

const SEVERITY_RANK: Record<PackFailureMode["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Unresolved before resolved, then by severity. What is still open is what an
 * installer is about to walk into; a fixed failure is history it inherits for
 * free by taking the release that fixed it.
 */
export function orderFailureModes(
  failureModes: readonly PackFailureMode[],
): readonly PackFailureMode[] {
  return failureModes.toSorted((left, right) => {
    const byResolution =
      RESOLUTION_RANK[left.resolution.kind] - RESOLUTION_RANK[right.resolution.kind];
    if (byResolution !== 0) return byResolution;
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    return right.deploymentsAffected - left.deploymentsAffected;
  });
}

/**
 * How much this release was the one that learned something. Counted from the
 * manifest being read, so a release newer than it counts zero rather than
 * borrowing knowledge it had not been taught yet.
 */
export function countKnowledgeIntroducedIn(knowledge: PackKnowledge, version: string): number {
  let count = 0;
  for (const failureMode of knowledge.failureModes ?? []) {
    if (failureMode.origin.introducedIn === version) count += 1;
  }
  for (const entry of knowledge.integration ?? []) {
    if (entry.origin.introducedIn === version) count += 1;
  }
  return count;
}

export function countKnowledgeEntries(knowledge: PackKnowledge): number {
  return (knowledge.failureModes ?? []).length + (knowledge.integration ?? []).length;
}

/** Accounts the consumer has to pay for, which is the requirement that stings. */
export function listPaidAccounts(requirements: PackRequirements): readonly string[] {
  return (requirements.accounts ?? [])
    .filter((account) => account.costsMoney === true)
    .map((account) => account.displayName);
}

/**
 * One line on what has to be in place first. Read before anything else on the
 * page, because a key the reader cannot get is what rules a pack out.
 */
export function describeRequirements(requirements: PackRequirements): string {
  const parts: string[] = [];
  const required = (requirements.environment ?? []).filter((entry) => entry.required);
  if (required.length > 0) {
    parts.push(pluralize(required.length, "value"));
  }
  const accounts = requirements.accounts ?? [];
  if (accounts.length > 0) {
    const paid = listPaidAccounts(requirements);
    parts.push(
      paid.length === 0
        ? pluralize(accounts.length, "third-party account")
        : `${pluralize(accounts.length, "third-party account")} (${formatList([...paid])} costs money)`,
    );
  }
  const services = requirements.services ?? [];
  if (services.length > 0) {
    parts.push(pluralize(services.length, "service"));
  }
  const packs = requirements.packs ?? [];
  if (packs.length > 0) {
    parts.push(pluralize(packs.length, "other pack"));
  }

  return parts.length === 0
    ? "Nothing. This pack declares that it needs nothing supplied before it runs."
    : `You supply ${formatList(parts)}.`;
}

export interface PackRouteSearch {
  /** Which release is being read. Absent means the newest one. */
  version?: string | undefined;
}

export function parsePackRouteSearch(search: Record<string, unknown>): PackRouteSearch {
  const raw = search.version;
  if (typeof raw !== "string") return {};
  const version = raw.trim();
  return version.length > 0 ? { version } : {};
}
