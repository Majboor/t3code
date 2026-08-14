import type {
  PackConditionAxis,
  PackConditions,
  PackFailureMode,
  PackFailureStanding,
  PackIntegration,
  PackIntegrationTarget,
  PackKnowledge,
  PackRelease,
  PackRequirements,
  PackRunningCost,
  PackScarRecord,
  PackVisibilityScope,
} from "@t3tools/contracts";
import { PACK_SURFACE_HALF_LIFE_DAYS, PACK_VISIBILITY_WIDTH } from "@t3tools/contracts";

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

const MILLISECONDS_PER_DAY = 86_400_000;

export interface PackStalenessDescription {
  /**
   * `durable` is not "very fresh": a claim about at-least-once delivery is not
   * on its way to being wrong, and collapsing it into the same scale as a
   * console path is what forces one global threshold onto both.
   */
  readonly state: "durable" | "fresh" | "aging" | "stale" | "unrated";
  readonly line: string;
}

function ageInDays(from: string, now: Date): number | null {
  const observed = new Date(from);
  if (Number.isNaN(observed.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - observed.getTime()) / MILLISECONDS_PER_DAY));
}

/**
 * How much weight to put on one claim given how old it is and how fast its kind
 * of fact rots. A date alone cannot answer that — six weeks kills a console
 * path and means nothing to an idempotency rule — so the half-life travels with
 * the entry and the reader is told which half-life it is reading and where it
 * came from.
 */
export function describeStaleness(
  conditions: PackConditions,
  now: Date = new Date(),
): PackStalenessDescription {
  const days = ageInDays(conditions.observedAt, now);
  const rot = conditions.rot;

  if (days === null) {
    return { state: "unrated", line: "Nothing dates this, so nothing can age it." };
  }

  const age = pluralize(days, "day");
  if (rot === undefined) {
    return {
      state: "unrated",
      line: `${capitalize(age)} old, and nothing says how fast this kind of fact rots — so its age is all you have to go on.`,
    };
  }

  const halfLife =
    rot.basis === "observed" ? rot.halfLifeDays : PACK_SURFACE_HALF_LIFE_DAYS[rot.surface];
  const surface = rot.surface.replaceAll("-", " ");

  if (halfLife === null) {
    return {
      state: "durable",
      line: `${capitalize(age)} old, and about ${surface} rather than a screen — this does not go stale with time, only if the guarantee itself changes.`,
    };
  }

  const basis =
    rot.basis === "observed"
      ? `measured across ${pluralize(rot.fromInstalls, "install")}`
      : `the default for ${surface}`;
  const ratio = days / halfLife;

  if (ratio >= 1) {
    return {
      state: "stale",
      line: `${capitalize(age)} old against a ${halfLife}-day half-life (${basis}). Assume it has moved and check before following it.`,
    };
  }
  if (ratio >= 0.5) {
    return {
      state: "aging",
      line: `${capitalize(age)} old against a ${halfLife}-day half-life (${basis}). Past halfway, so confirm the first step before trusting the rest.`,
    };
  }
  return {
    state: "fresh",
    line: `${capitalize(age)} old against a ${halfLife}-day half-life (${basis}), so it is probably still current.`,
  };
}

/**
 * Whether a failure mode still describes the present. Counted in deployments
 * that carry the resolution, which is why this reads differently from the
 * standing on an instruction: a confirmation there is somebody following steps
 * that worked, and here it is somebody being hurt again.
 */
export function describeFailureStanding(standing: PackFailureStanding): string {
  const checked =
    standing.lastCheckedAt === undefined
      ? ""
      : ` Last checked ${formatObservedDate(standing.lastCheckedAt)}.`;

  switch (standing.state) {
    case "recurring":
      return `Still recurring: ${pluralize(standing.recurredInDeployments, "deployment")} carrying the resolution hit it anyway.${checked}`;
    case "holding":
      return `Holding in ${pluralize(standing.heldInDeployments, "deployment")} since, with ${standing.recurredInDeployments} recurrence${standing.recurredInDeployments === 1 ? "" : "s"}.${checked}`;
    case "dormant":
      return `Nothing has hit this in a while and nothing says why — it may be gone, or nobody may be walking that path.${checked}`;
    case "obsolete":
      return `The surface this described is gone, so it cannot recur. Kept for installs still sitting on an older release.${checked}`;
  }
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
 * What one release earned on its own, said next to what the line earned rather
 * than instead of it. Behaviour belongs to the release that ran and knowledge
 * accumulates across the line, so a reader handed only the line's number reads
 * a rewrite as proven, and a reader handed only the release's number reads
 * every fresh release as untested.
 */
export function describeReleaseSignals(signals: PackScarRecord): string {
  if (signals.deploymentsAttempted === 0) {
    return "Nothing has run this release yet.";
  }
  return [
    `${signals.deploymentsSurviving} of ${pluralize(signals.deploymentsAttempted, "deployment")} on this release still running`,
    pluralize(signals.cumulativeServiceDays, "deployment-day"),
  ].join(" · ");
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

/** How each scope reads in a sentence about the moment it started. */
const VISIBILITY_SINCE_LABELS: Record<PackVisibilityScope, string> = {
  workspace: "Visible in this workspace",
  tenant: "Visible across this tenant",
  organization: "Visible across your organization",
  unlisted: "Reachable by anyone with the link",
  public: "Public in the marketplace",
};

export interface PackPublicationDescription {
  /** Where it stands now. `null` means it has never been shown to anybody. */
  readonly scope: PackVisibilityScope | null;
  /** When it reached that scope, which is not when it was cut. */
  readonly since: string | null;
  readonly line: string;
  /** Said only when it was once wider than it is now, which a single date hides. */
  readonly narrowed: string | null;
}

/**
 * When a release became visible, and to whom. `provenance.extractedAt` answers
 * a different question — when the bytes were cut — and a release can sit unseen
 * for a week between the two, so the publish copy cannot borrow it.
 */
export function describePublication(release: PackRelease | undefined): PackPublicationDescription {
  const publications = release?.publications ?? [];
  const latest = publications.at(-1);

  if (latest === undefined) {
    return {
      scope: null,
      since: null,
      line:
        release === undefined
          ? "Nothing is recorded about when this became visible."
          : `Cut ${formatObservedDate(release.cutAt)} and never published. Nobody outside this workspace has been able to see it.`,
      narrowed: null,
    };
  }

  const widest = publications.reduce((left, right) =>
    PACK_VISIBILITY_WIDTH[right.scope] > PACK_VISIBILITY_WIDTH[left.scope] ? right : left,
  );
  const narrowed =
    PACK_VISIBILITY_WIDTH[widest.scope] > PACK_VISIBILITY_WIDTH[latest.scope]
      ? `It was ${VISIBILITY_SINCE_LABELS[widest.scope].toLowerCase()} from ${formatObservedDate(widest.at)} until ${formatObservedDate(latest.at)}. Installs made in that window are still out there.`
      : null;

  return {
    scope: latest.scope,
    since: latest.at,
    line: `${VISIBILITY_SINCE_LABELS[latest.scope]} since ${formatObservedDate(latest.at)}.`,
    narrowed,
  };
}

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
  /** Where this release stands today and since when, stated before it moves. */
  readonly sinceLine: string | null;
  readonly confirmLabel: string;
  readonly widening: boolean;
}

/**
 * What the change actually does, in plain language and before it happens.
 * Publishing is a second act rather than a side effect of deploying, so the
 * consequence has to be legible at the moment of consent — including the part
 * that cannot be taken back, and including the date this act is about to write.
 */
export function describeVisibilityChange(
  from: PackVisibilityScope,
  to: PackVisibilityScope,
  record: PackScarRecord,
  release?: PackRelease,
): PackVisibilityChangeDescription {
  const widening = PACK_VISIBILITY_WIDTH[to] > PACK_VISIBILITY_WIDTH[from];
  const publication = describePublication(release);
  const sinceLine =
    release === undefined
      ? null
      : [
          `${release.version}: ${publication.line}`,
          publication.narrowed,
          widening
            ? "Confirming dates it from this moment, and that date travels with the release."
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" ");
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
      sinceLine,
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
      sinceLine,
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
      sinceLine,
      confirmLabel: "Make private",
      widening,
    };
  }

  return {
    title: `Share this with ${PACK_VISIBILITY_DESCRIPTIONS[to].label.toLowerCase()}?`,
    consequence: `${PACK_VISIBILITY_DESCRIPTIONS[to].detail} Its record goes with it, including the releases you abandoned.`,
    warning,
    sinceLine,
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

/**
 * What a release is worth reading for, derived from the manifest instead of
 * from a note somebody wrote. A release note is prose about intent; the
 * failures a release closed and the knowledge it brought are facts already in
 * the format, and they are the two things a reader deciding whether to upgrade
 * is actually asking about.
 */
export function describeReleaseLearning(knowledge: PackKnowledge, version: string): string | null {
  const fixed = (knowledge.failureModes ?? [])
    .filter((entry) => entry.resolution.kind === "fixed" && entry.resolution.inVersion === version)
    .map((entry) => entry.symptom);
  const introduced = countKnowledgeIntroducedIn(knowledge, version);

  const sentences: string[] = [];
  if (fixed.length > 0) {
    sentences.push(`Fixed: ${fixed.join(" ")}`);
  }
  if (introduced > 0) {
    sentences.push(`Brought ${pluralize(introduced, "piece")} of knowledge with it.`);
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}

const COST_MODEL_LABELS: Record<PackRunningCost["model"], string> = {
  free: "Free",
  "free-tier": "Free tier",
  metered: "Metered",
  subscription: "Subscription",
  "paid-plan": "Paid plan",
};

/** The badge on one requirement: how it bills, in two words. */
export function describeCostModel(model: PackRunningCost["model"]): string {
  return COST_MODEL_LABELS[model];
}

/**
 * What the bill is actually for, without repeating the model — that is the
 * badge's job, and a line that says "Metered — metered on requests" is noise
 * where the reader is looking for the threshold.
 */
export function describeCostBasis(cost: PackRunningCost): string | null {
  const parts = [cost.billedOn, cost.freeTierLimit].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? null : parts.join(" ");
}

export interface PackCostSummary {
  readonly paying: readonly string[];
  /** Declared free. Worth naming, because it is a claim rather than a silence. */
  readonly free: readonly string[];
  /** Says nothing either way. The half that made the old summary an undercount. */
  readonly undeclared: readonly string[];
  readonly line: string;
}

/**
 * Everything that bills, across every requirement kind that can. Counting only
 * `accounts` undercounted every pack that needs a database or a bucket, and
 * silence is the other half of the undercount: a service with no cost declared
 * is unknown, and unknown is not free.
 */
export function summariseRunningCost(requirements: PackRequirements): PackCostSummary {
  const paying: string[] = [];
  const free: string[] = [];
  const undeclared: string[] = [];

  for (const account of requirements.accounts ?? []) {
    const model = account.cost?.model;
    if (model !== undefined) {
      (model === "free" ? free : paying).push(account.displayName);
      continue;
    }
    if (account.costsMoney === undefined) undeclared.push(account.displayName);
    else (account.costsMoney ? paying : free).push(account.displayName);
  }

  for (const service of requirements.services ?? []) {
    const model = service.cost?.model;
    if (model === undefined) undeclared.push(service.name);
    else (model === "free" ? free : paying).push(service.name);
  }

  if (paying.length === 0 && undeclared.length === 0) {
    return {
      paying,
      free,
      undeclared,
      line:
        free.length === 0
          ? "Nothing here bills: this pack needs no account and no service of its own."
          : `Nothing here bills. ${capitalize(formatList([...free]))} ${free.length === 1 ? "is" : "are"} declared free at the scale this pack uses.`,
    };
  }

  const sentences: string[] = [];
  if (paying.length > 0) {
    sentences.push(
      `${capitalize(formatList([...paying]))} cost${paying.length === 1 ? "s" : ""} money to run.`,
    );
  }
  if (undeclared.length > 0) {
    sentences.push(
      `${capitalize(formatList([...undeclared]))} say${undeclared.length === 1 ? "s" : ""} nothing about cost, and nothing is not free — assume ${undeclared.length === 1 ? "it bills" : "they bill"} until you have checked.`,
    );
  }
  return { paying, free, undeclared, line: sentences.join(" ") };
}

/**
 * One line on what has to be in place first. Read before anything else on the
 * page, because a key the reader cannot get is what rules a pack out. What it
 * costs is a second sentence rather than a parenthesis on the accounts, because
 * the bill does not arrive only from accounts.
 */
export function describeRequirements(requirements: PackRequirements): string {
  const parts: string[] = [];
  const required = (requirements.environment ?? []).filter((entry) => entry.required);
  if (required.length > 0) {
    parts.push(pluralize(required.length, "value"));
  }
  const accounts = requirements.accounts ?? [];
  if (accounts.length > 0) {
    parts.push(pluralize(accounts.length, "third-party account"));
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
