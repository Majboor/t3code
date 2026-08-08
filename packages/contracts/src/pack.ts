/**
 * Pack format contracts.
 *
 * A pack is a workspace turned into something a stranger can install: the code,
 * the notes the agent wrote on its way out, a declaration of everything the
 * consumer has to supply before it will run — and the part that decides whether
 * any of it is worth installing, which is what the thing has already been
 * caught getting wrong in production.
 *
 * The sections that describe shape — identity, requirements, interfaces,
 * runtime, permissions — are the carrier. `knowledge` and `verification` are
 * the product: a manifest that declares a perfect interface with nothing
 * learned behind it describes a template, and a template is something the
 * consuming agent could have generated itself. So those two sections are
 * required even when empty, and everything in them is shaped to be written by a
 * machine watching a deployment rather than by an author volunteering notes.
 *
 * Every downstream surface reads this manifest: the CLI writes it, the
 * marketplace indexes and ranks it, pack mode searches it, the maintenance
 * agent appends to it, and the deploy dashboard charts what it declares. That
 * makes the format the load-bearing contract rather than one schema among many,
 * so it carries a `formatVersion` and prefers tagged unions over loose optional
 * fields wherever an illegal combination would otherwise be representable.
 *
 * See `docs/pack-format.md` for the prose specification and a worked example.
 *
 * @module pack
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  OrganizationId,
  PositiveInt,
  ProjectId,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";

// ── Format version ──────────────────────────────────────────────────────────

/**
 * Bumped only when a reader written against the previous version could
 * misinterpret a manifest. Consumers read this field before decoding anything
 * else so an unsupported pack fails with "too new" rather than a field error.
 *
 * `2.0` exists because `verification` carries a different meaning rather than a
 * different shape: in `1.0` it was a reviewer's badge, and a `1.0` reader handed
 * a `2.0` manifest would read a section about production behaviour as a review
 * decision. That is exactly the silent misread the bump rule is for.
 */
export const PackFormatVersion = Schema.Literals(["2.0"]);
export type PackFormatVersion = typeof PackFormatVersion.Type;

export const PACK_FORMAT_VERSION = "2.0" satisfies PackFormatVersion;

/**
 * Readable by a migrator, rejected by `PackManifest`. Listed rather than
 * inferred so an upgrade path can tell "a version we retired" apart from "a
 * version from the future", which are opposite errors for a consumer.
 */
export const PACK_SUPERSEDED_FORMAT_VERSIONS: ReadonlyArray<string> = ["1.0"];

/** File and directory names the rest of the ecosystem may hard-code. */
export const PACK_DIRECTORY_SUFFIX = ".pack";
export const PACK_MANIFEST_FILENAME = "pack.json";
export const PACK_HANDOVER_FILENAME = "handover.md";
export const PACK_ARCHIVE_SUFFIX = ".pack.tgz";

// ── Scalars ─────────────────────────────────────────────────────────────────

const PACK_NAME_MAX_LENGTH = 64;
const PACK_SUMMARY_MAX_LENGTH = 200;
const PACK_DESCRIPTION_MAX_LENGTH = 20_000;
const PACK_PURPOSE_MAX_LENGTH = 500;
const PACK_COMMAND_MAX_LENGTH = 4_000;
const PACK_RELATIVE_PATH_MAX_LENGTH = 512;
const PACK_INTEGRATION_PROMPT_MAX_LENGTH = 8_000;
const PACK_KNOWLEDGE_TEXT_MAX_LENGTH = 4_000;
const PACK_CONDITION_VALUE_MAX_LENGTH = 64;
const PACK_MAX_PORT = 65_535;

/**
 * A lowercase slug, used for every name a human types or a URL carries. The
 * single character case exists because short identifiers like `id` are common
 * inside operation and service names.
 */
export const PackSlug = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  Schema.isMaxLength(PACK_NAME_MAX_LENGTH),
);
export type PackSlug = typeof PackSlug.Type;

/** The name a person types. Unique per publisher, not globally. */
export const PackName = PackSlug;
export type PackName = typeof PackName.Type;

/** The publisher's public handle, the half of identity that appears in URLs. */
export const PackHandle = PackSlug;
export type PackHandle = typeof PackHandle.Type;

/**
 * Strict semantic version. Ranges are deliberately a separate type: a release
 * is always one exact point, and only dependencies get to be fuzzy.
 */
export const PackVersion = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  ),
);
export type PackVersion = typeof PackVersion.Type;

/** npm-style range syntax, resolved by the installer rather than the format. */
export const PackVersionRange = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PackVersionRange = typeof PackVersionRange.Type;

/**
 * Paths never escape the pack directory, so a reviewer can reason about the
 * file set without resolving anything and an extractor cannot be walked out of
 * its own root.
 */
export const PackRelativePath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@\-/]+$/),
  Schema.isMaxLength(PACK_RELATIVE_PATH_MAX_LENGTH),
);
export type PackRelativePath = typeof PackRelativePath.Type;

/** POSIX environment variable spelling, so shells and containers agree. */
export const PackEnvVarName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/),
  Schema.isMaxLength(128),
);
export type PackEnvVarName = typeof PackEnvVarName.Type;

/** Dotted lowercase, matching the shape of the product event catalog. */
export const PackEventName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  Schema.isMaxLength(128),
);
export type PackEventName = typeof PackEventName.Type;

/**
 * A host a pack talks to. A single leading `*.` wildcard is allowed because
 * real services span subdomains; a bare `*` is not, because a permission that
 * allows everything communicates nothing to a reviewer.
 */
export const PackHostPattern = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
  ),
  Schema.isMaxLength(253),
);
export type PackHostPattern = typeof PackHostPattern.Type;

export const PackPort = PositiveInt.check(Schema.isLessThanOrEqualTo(PACK_MAX_PORT));
export type PackPort = typeof PackPort.Type;

export const PackSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type PackSha256 = typeof PackSha256.Type;

export const PackBase64 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  Schema.isMaxLength(4_096),
);
export type PackBase64 = typeof PackBase64.Type;

const PackSummaryText = TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_SUMMARY_MAX_LENGTH));
const PackDescriptionText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PACK_DESCRIPTION_MAX_LENGTH),
);
const PackPurposeText = TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_PURPOSE_MAX_LENGTH));
const PackCommandText = TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_COMMAND_MAX_LENGTH));
/**
 * Long enough for a paragraph of hard-won detail, short enough that a
 * maintenance agent writing twenty of these cannot bloat a manifest a search
 * index has to hold in memory.
 */
const PackKnowledgeText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PACK_KNOWLEDGE_TEXT_MAX_LENGTH),
);
const PackConditionValue = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PACK_CONDITION_VALUE_MAX_LENGTH),
);
const PackUrl = TrimmedNonEmptyString.check(
  Schema.isPattern(/^https:\/\/\S+$/),
  Schema.isMaxLength(2_048),
);

// ── Identifiers ─────────────────────────────────────────────────────────────

/**
 * Opaque and permanent. A pack may be renamed, retitled or transferred and this
 * never changes, which is what lets installs, analytics and verification
 * records survive all three.
 */
export const PackId = TrimmedNonEmptyString.pipe(Schema.brand("PackId"));
export type PackId = typeof PackId.Type;

/**
 * Names the publisher's signing keypair. The private half never leaves the
 * publisher; the public half is registered once with the marketplace so a
 * consumer can check a release really came from that account.
 */
export const PackSigningKeyId = TrimmedNonEmptyString.pipe(Schema.brand("PackSigningKeyId"));
export type PackSigningKeyId = typeof PackSigningKeyId.Type;

/**
 * A workspace's stable, non-reversible handle. It travels instead of the
 * workspace id so a public pack can prove two releases share an origin, and so
 * a workspace-private pack can be pinned to its home, without leaking tenancy.
 */
export const PackWorkspaceKeyId = TrimmedNonEmptyString.pipe(Schema.brand("PackWorkspaceKeyId"));
export type PackWorkspaceKeyId = typeof PackWorkspaceKeyId.Type;

/**
 * A running deployment's stable, non-reversible handle. Knowledge cites it so a
 * public pack can say a failure was seen in three distinct deployments — the
 * claim that makes a sighting more than an anecdote — without naming any of
 * the installations it was seen in.
 */
export const PackDeploymentKeyId = TrimmedNonEmptyString.pipe(Schema.brand("PackDeploymentKeyId"));
export type PackDeploymentKeyId = typeof PackDeploymentKeyId.Type;

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * A closed set, because facets only work for search if everyone picks from the
 * same list. Free-form discovery is what `tags` is for.
 */
export const PackCategory = Schema.Literals([
  "payments",
  "authentication",
  "messaging",
  "data",
  "storage",
  "analytics",
  "ai",
  "search",
  "media",
  "commerce",
  "devops",
  "integration",
  "ui",
  "workflow",
  "other",
]);
export type PackCategory = typeof PackCategory.Type;

export const PackTag = PackSlug;
export type PackTag = typeof PackTag.Type;

/**
 * An SPDX identifier, or one of the two escape hatches for code that is not
 * open source. Both escape hatches are spelled out rather than left as an
 * absent field so a consumer never has to guess what silence means.
 */
export const PackLicense = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PackLicense = typeof PackLicense.Type;

/**
 * Public identity. Internal ids are optional because a manifest that leaves the
 * installation must still be readable by a marketplace that has never heard of
 * this tenant.
 */
export const PackPublisher = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    handle: PackHandle,
    displayName: TrimmedNonEmptyString,
    userId: Schema.optional(UserId),
    signingKeyId: Schema.optional(PackSigningKeyId),
    publicKey: Schema.optional(PackBase64),
    contactUrl: Schema.optional(PackUrl),
  }),
  Schema.Struct({
    type: Schema.Literal("organization"),
    handle: PackHandle,
    displayName: TrimmedNonEmptyString,
    organizationId: Schema.optional(OrganizationId),
    signingKeyId: Schema.optional(PackSigningKeyId),
    publicKey: Schema.optional(PackBase64),
    contactUrl: Schema.optional(PackUrl),
  }),
]);
export type PackPublisher = typeof PackPublisher.Type;

export const PackIdentity = Schema.Struct({
  id: PackId,
  name: PackName,
  version: PackVersion,
  displayName: TrimmedNonEmptyString,
  /** One line. Search results and agent context windows both live off this. */
  summary: PackSummaryText,
  description: Schema.optional(PackDescriptionText),
  publisher: PackPublisher,
  license: PackLicense,
  categories: Schema.optional(Schema.Array(PackCategory)),
  tags: Schema.optional(Schema.Array(PackTag)),
  homepageUrl: Schema.optional(PackUrl),
  repositoryUrl: Schema.optional(PackUrl),
});
export type PackIdentity = typeof PackIdentity.Type;

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * The workspace a pack was cut from. `workspaceId` is optional so a public
 * release can drop it while the key id keeps the lineage intact.
 */
export const PackOriginWorkspace = Schema.Struct({
  workspaceKeyId: PackWorkspaceKeyId,
  workspaceId: Schema.optional(WorkspaceId),
  tenantId: Schema.optional(TenantId),
  projectId: Schema.optional(ProjectId),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type PackOriginWorkspace = typeof PackOriginWorkspace.Type;

/** Who cut the pack. Agents are first-class here because usually one did. */
export const PackAuthor = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    userId: Schema.optional(UserId),
    displayName: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    provider: TrimmedNonEmptyString,
    model: Schema.optional(TrimmedNonEmptyString),
    /** The person who asked for the extraction, so accountability survives. */
    onBehalfOfUserId: Schema.optional(UserId),
  }),
]);
export type PackAuthor = typeof PackAuthor.Type;

/** The commit the extraction was taken from, for auditing and for re-cutting. */
export const PackSourceRevision = Schema.Struct({
  repositoryUrl: Schema.optional(PackUrl),
  branch: Schema.optional(TrimmedNonEmptyString),
  commitSha: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{7,40}$/))),
  /** True when the working tree had uncommitted changes at extraction time. */
  dirty: Schema.optional(Schema.Boolean),
});
export type PackSourceRevision = typeof PackSourceRevision.Type;

/**
 * The notes the agent writes on the way out: what it built, what it tried, what
 * it left undone. Required, because a pack without a handover is a zip file.
 * The prose stays in a file and only a summary travels in the manifest, so
 * search and agent context stay cheap.
 */
export const PackHandover = Schema.Struct({
  path: PackRelativePath,
  summary: PackDescriptionText,
  generatedBy: Schema.optional(PackAuthor),
  generatedAt: Schema.optional(IsoDateTime),
});
export type PackHandover = typeof PackHandover.Type;

export const PackProvenance = Schema.Struct({
  workspace: PackOriginWorkspace,
  extractedAt: IsoDateTime,
  extractedBy: PackAuthor,
  handover: PackHandover,
  source: Schema.optional(PackSourceRevision),
  /** Set when this pack was forked from another, so credit survives a rename. */
  derivedFrom: Schema.optional(
    Schema.Struct({
      id: PackId,
      name: PackName,
      version: PackVersion,
      publisherHandle: PackHandle,
    }),
  ),
});
export type PackProvenance = typeof PackProvenance.Type;

// ── Reusability contract ────────────────────────────────────────────────────

/**
 * How data crosses the pack boundary. Kept coarse on purpose: the point is to
 * let an agent decide whether a pack fits before reading any code, not to
 * replace the interface definitions further down.
 */
export const PackPortKind = Schema.Literals([
  "http-request",
  "http-response",
  "function-call",
  "function-result",
  "event",
  "webhook",
  "cli-argument",
  "file",
  "stream",
]);
export type PackPortKind = typeof PackPortKind.Type;

export const PackDataPort = Schema.Struct({
  name: PackSlug,
  kind: PackPortKind,
  description: PackPurposeText,
  /** A JSON Schema inside the pack, when the shape is worth pinning down. */
  schemaPath: Schema.optional(PackRelativePath),
  required: Schema.optional(Schema.Boolean),
});
export type PackDataPort = typeof PackDataPort.Type;

export const PackCapability = Schema.Struct({
  /** One imperative sentence. The first thing a searching agent reads. */
  does: PackSummaryText,
  useCases: Schema.optional(Schema.Array(PackPurposeText)),
  /**
   * What the pack deliberately does not do. Cheap to write and the fastest way
   * for a consumer to rule a candidate out.
   */
  nonGoals: Schema.optional(Schema.Array(PackPurposeText)),
  inputs: Schema.optional(Schema.Array(PackDataPort)),
  outputs: Schema.optional(Schema.Array(PackDataPort)),
});
export type PackCapability = typeof PackCapability.Type;

// ── Knowledge: the conditions a claim held under ─────────────────────────────

/**
 * Axes along which knowledge that is true here can be false there. A closed set
 * because the point of naming them is that a consumer compares its own context
 * field by field before trusting anything; a free-form label would only be
 * legible to the agent that wrote it.
 */
export const PackConditionAxis = Schema.Literals([
  "account-tier",
  "region",
  "console-version",
  "api-version",
  "sdk-version",
  "runtime-version",
  "plan",
  "locale",
  "deployment-target",
]);
export type PackConditionAxis = typeof PackConditionAxis.Type;

/**
 * The context one claim held under, attached per claim rather than once per
 * pack. Two entries in the same manifest are routinely verified years and tiers
 * apart, and a single global block would silently relabel the older one as
 * having been checked under the newer one's conditions.
 *
 * `observedAt` is the only required field, because it is the one thing the
 * observing agent always has and because undated knowledge cannot be aged out.
 * Everything else narrows. An absent axis means "not recorded"; naming an axis
 * in `untestedAxes` means "recorded, and we know we never varied it" — the
 * difference between an agent that asserts and one that can say "verified on
 * standard-tier US, yours may differ". At install volume a confident wrong
 * answer travels further than a hedged right one, so the hedge is structural.
 */
export const PackConditions = Schema.Struct({
  observedAt: IsoDateTime,
  accountTier: Schema.optional(PackConditionValue),
  regions: Schema.optional(Schema.Array(PackConditionValue)),
  /** The provider console or dashboard release the steps were walked against. */
  consoleVersion: Schema.optional(PackConditionValue),
  apiVersion: Schema.optional(PackConditionValue),
  other: Schema.optional(
    Schema.Array(
      Schema.Struct({
        axis: PackConditionAxis,
        value: PackConditionValue,
      }),
    ),
  ),
  /**
   * Distinct deployments the claim held under. One is an anecdote and forty is
   * a fact, and a reader is entitled to know which of the two it is reading.
   */
  observedAcrossDeployments: Schema.optional(NonNegativeInt),
  untestedAxes: Schema.optional(Schema.Array(PackConditionAxis)),
});
export type PackConditions = typeof PackConditions.Type;

// ── Knowledge: where a piece of it came from ────────────────────────────────

/**
 * What produced a piece of knowledge. The machine-written variants come first
 * because they are the ones the format is betting on: nobody volunteers their
 * edge cases, so anything that depends on an author sitting down to write is a
 * source that will stay empty. `inherited` is how a failure caught once reaches
 * everyone — a dependency's scar is the dependant's scar.
 */
export const PackKnowledgeSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("maintenance-agent"),
    provider: TrimmedNonEmptyString,
    model: Schema.optional(TrimmedNonEmptyString),
    /** The scheduled run that noticed, so the reasoning can be pulled back up. */
    runId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("deployment-telemetry"),
    /** The metric or event that crossed a line, drawn from the analytics block. */
    signal: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  }),
  /** An installing agent reporting what it hit while wiring the pack in. */
  Schema.Struct({
    kind: Schema.Literal("install-report"),
    target: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  }),
  Schema.Struct({
    kind: Schema.Literal("human-report"),
    reportedByUserId: Schema.optional(UserId),
  }),
  Schema.Struct({
    kind: Schema.Literal("inherited"),
    packId: PackId,
    packName: PackName,
    packVersion: PackVersion,
    entryId: PackSlug,
  }),
]);
export type PackKnowledgeSource = typeof PackKnowledgeSource.Type;

/**
 * How one entry got here and when. `introducedIn` is what makes knowledge
 * propagate rather than accumulate in one place: an installer diffing the
 * version it runs against the version it is offered can answer "what did the
 * last four hundred deployments learn that I do not know yet" without reading
 * either manifest in full.
 */
export const PackKnowledgeOrigin = Schema.Struct({
  introducedIn: PackVersion,
  source: PackKnowledgeSource,
  recordedAt: IsoDateTime,
  deploymentKeyIds: Schema.optional(Schema.Array(PackDeploymentKeyId)),
  /**
   * An earlier entry this one replaces. A console path that moved is a
   * correction, not a second fact, and a manifest that keeps both is how an
   * agent ends up confidently reciting last year's menu.
   */
  supersedes: Schema.optional(PackSlug),
});
export type PackKnowledgeOrigin = typeof PackKnowledgeOrigin.Type;

// ── Knowledge: failure modes ────────────────────────────────────────────────

/**
 * The shape of the thing that went wrong, for search and for pattern-matching
 * against a failure the consumer is currently looking at. Deliberately about
 * mechanism rather than component, because "webhook retries are not idempotent"
 * generalises across providers and "Stripe broke" does not.
 */
export const PackFailureTrigger = Schema.Literals([
  "race-condition",
  "retry",
  "idempotency",
  "rate-limit",
  "quota-exhausted",
  "clock-skew",
  "provider-quirk",
  "provider-deprecation",
  "payload-shape",
  "partial-failure",
  "cold-start",
  "concurrency",
  "misconfiguration",
  "permission-denied",
  "network-timeout",
  "version-drift",
]);
export type PackFailureTrigger = typeof PackFailureTrigger.Type;

/**
 * Who is actually at fault. A union rather than a free string because the four
 * cases have different half-lives: a provider quirk may vanish with a console
 * release, a dependency fault is fixed by a version bump, and a fault in the
 * pack's own code is the only one the maintainer can close alone.
 */
export const PackFailureAttribution = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("provider"),
    /** Matches a `requirements.accounts[].service`, so the two never drift. */
    service: PackSlug,
    apiVersion: Schema.optional(PackConditionValue),
  }),
  Schema.Struct({
    kind: Schema.Literal("dependency"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    versionRange: Schema.optional(PackVersionRange),
  }),
  /** The codebase the pack was installed into, rather than the pack itself. */
  Schema.Struct({
    kind: Schema.Literal("host"),
    detail: PackPurposeText,
  }),
  Schema.Struct({
    kind: Schema.Literal("pack"),
  }),
]);
export type PackFailureAttribution = typeof PackFailureAttribution.Type;

/**
 * How the failure announces itself. Stored so the next deployment recognises it
 * instead of rediscovering it: a detector is the difference between a note
 * about the past and a guard on the present, and it is the field that lets the
 * maintenance agent close the loop without a human describing the symptom
 * again.
 */
export const PackFailureDetection = Schema.Struct({
  signal: Schema.Literals([
    "healthcheck",
    "error-rate",
    "log-pattern",
    "test-failure",
    "provider-error-code",
    "latency",
    "reconciliation-mismatch",
    "user-report",
  ]),
  /** The literal string, code or pattern to look for. */
  match: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /** The production check standing guard over this, once one exists. */
  checkId: Schema.optional(PackSlug),
});
export type PackFailureDetection = typeof PackFailureDetection.Type;

/**
 * Where the failure stands. `open` still carries required advice, because an
 * unresolved failure an installer is warned about is worth more than a fixed
 * one nobody wrote down, and a knowledge base that only records victories is a
 * marketing asset rather than a scar record.
 */
export const PackFailureResolution = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("fixed"),
    /** The release carrying the fix, so an installer can tell whether it has it. */
    inVersion: PackVersion,
    change: PackKnowledgeText,
    checkId: Schema.optional(PackSlug),
  }),
  Schema.Struct({
    kind: Schema.Literal("mitigated"),
    workaround: PackKnowledgeText,
    residualRisk: Schema.optional(PackPurposeText),
  }),
  Schema.Struct({
    kind: Schema.Literal("upstream"),
    waitingOn: PackPurposeText,
    reportUrl: Schema.optional(PackUrl),
    workaround: Schema.optional(PackKnowledgeText),
  }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    currentAdvice: PackKnowledgeText,
  }),
]);
export type PackFailureResolution = typeof PackFailureResolution.Type;

/**
 * One thing that has actually gone wrong in production — the edge cases, race
 * conditions and provider quirks somebody already paid for.
 *
 * Every required field is something the observing agent holds at the moment it
 * notices: an id it mints, a symptom it read off a signal, the deployment
 * conditions it was already running under, its own clock, and its own count of
 * affected deployments. Nothing here requires an author to reflect, which is
 * the only way this section stays populated.
 *
 * `id` is stable across releases, so a repeat sighting, a fix and a regression
 * check all point at the same failure rather than at three versions of a story.
 */
export const PackFailureMode = Schema.Struct({
  id: PackSlug,
  /** What it looks like from outside, which is all a matching consumer has. */
  symptom: PackSummaryText,
  trigger: PackKnowledgeText,
  triggerKinds: Schema.optional(Schema.Array(PackFailureTrigger)),
  attributedTo: PackFailureAttribution,
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  /**
   * True when nothing in the running system reports it. A silent failure is the
   * one worth carrying: the loud ones get noticed by whoever is on call, and
   * the quiet ones are discovered by a customer months later.
   */
  silent: Schema.optional(Schema.Boolean),
  detection: Schema.optional(PackFailureDetection),
  resolution: PackFailureResolution,
  firstSeenAt: IsoDateTime,
  lastSeenAt: Schema.optional(IsoDateTime),
  /** Deployments known to have hit it. Read against the scar record's totals. */
  deploymentsAffected: NonNegativeInt,
  conditions: PackConditions,
  origin: PackKnowledgeOrigin,
});
export type PackFailureMode = typeof PackFailureMode.Type;

// ── Knowledge: what an installing agent needs and the code cannot say ───────

/**
 * One move inside somebody else's console. `expect` is what makes the step
 * falsifiable: an agent that knows what the screen should say can report that
 * the provider redesigned it, which turns provider churn into a detected event
 * rather than a user watching an agent insist on a menu that no longer exists.
 */
export const PackConsoleStep = Schema.Struct({
  /** The literal path a person clicks: "Settings → API keys → Create key". */
  action: PackPurposeText,
  url: Schema.optional(PackUrl),
  expect: Schema.optional(PackPurposeText),
});
export type PackConsoleStep = typeof PackConsoleStep.Type;

/**
 * A permission on a credential. `required` is the load-bearing half: the
 * default an agent reaches for is every scope the console offers, and this is
 * the field that argues it down to the two the pack actually calls.
 */
export const PackCredentialScope = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  purpose: PackPurposeText,
  required: Schema.Boolean,
});
export type PackCredentialScope = typeof PackCredentialScope.Type;

export const PackCredentialKind = Schema.Literals([
  "restricted-key",
  "secret-key",
  "publishable-key",
  "oauth-client",
  "service-account",
  "personal-access-token",
  "webhook-signing-secret",
]);
export type PackCredentialKind = typeof PackCredentialKind.Type;

/**
 * How far a consumer may move one decision. `frozen` entries carry the failure
 * mode that explains them wherever one exists, because "do not touch this" is
 * an assertion and "do not touch this, here is what happened the last time
 * somebody did" is knowledge — and only the second one survives an agent that
 * has a good reason of its own.
 */
export const PackCustomisationDecision = Schema.Struct({
  subject: PackSummaryText,
  latitude: Schema.Literals(["safe-to-change", "change-with-care", "frozen"]),
  reason: PackPurposeText,
  failureModeId: Schema.optional(PackSlug),
  path: Schema.optional(PackRelativePath),
});
export type PackCustomisationDecision = typeof PackCustomisationDecision.Type;

/**
 * The four things an installing agent needs that reading the source will not
 * give it: how to get the credential, how to wire the thing in, which patterns
 * to hold to, and which decisions it may move.
 *
 * `credential-retrieval` is modelled hardest because it is the sharpest case in
 * the whole format. "Go to the console, Settings → API, generate a restricted
 * key with these two scopes" is in no repository, is frequently not in the
 * provider's own documentation, changes without notice, and is hallucinated
 * confidently by every model that is asked. It exists only in the aftermath of
 * somebody doing it, which is exactly the material this section carries.
 */
export const PackIntegrationKnowledgeDetail = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("credential-retrieval"),
    /** Ties the steps to the declared requirement, so neither drifts alone. */
    environmentVariable: PackEnvVarName,
    service: PackSlug,
    credentialKind: Schema.optional(PackCredentialKind),
    consoleUrl: Schema.optional(PackUrl),
    navigation: Schema.NonEmptyArray(PackConsoleStep),
    scopes: Schema.optional(Schema.Array(PackCredentialScope)),
    /** What to do when it expires or is rotated, which is when it next matters. */
    rotation: Schema.optional(PackKnowledgeText),
  }),
  Schema.Struct({
    kind: Schema.Literal("wiring"),
    /** Addressed to the installing agent, not to a reader of documentation. */
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
    interfaceId: Schema.optional(PackSlug),
    /** Files in the host codebase the wiring touches, for a reviewer's diff. */
    touches: Schema.optional(Schema.Array(PackRelativePath)),
  }),
  Schema.Struct({
    kind: Schema.Literal("pattern"),
    rule: PackKnowledgeText,
    /** Why, because a rule without one is the first thing an agent optimises away. */
    rationale: PackPurposeText,
    example: Schema.optional(PackKnowledgeText),
  }),
  Schema.Struct({
    kind: Schema.Literal("boundary"),
    decisions: Schema.NonEmptyArray(PackCustomisationDecision),
  }),
]);
export type PackIntegrationKnowledgeDetail = typeof PackIntegrationKnowledgeDetail.Type;

/**
 * Whether an entry still holds. Counted from installs rather than declared,
 * so a console redesign shows up as contradictions outrunning confirmations
 * before anyone files a report. `superseded` entries stay in the manifest on
 * purpose: knowing the path used to be this is worth more than silence when an
 * agent is looking at an older console.
 */
export const PackKnowledgeStanding = Schema.Struct({
  state: Schema.Literals(["holding", "doubtful", "superseded"]),
  confirmedInInstalls: NonNegativeInt,
  contradictedInInstalls: NonNegativeInt,
  lastConfirmedAt: Schema.optional(IsoDateTime),
});
export type PackKnowledgeStanding = typeof PackKnowledgeStanding.Type;

/**
 * One piece of installation knowledge. The envelope carries what a search
 * indexes and what a consumer thresholds on; `detail` carries what an installer
 * executes. Split that way because a marketplace ranking a thousand packs must
 * not have to open four different shapes to find a date and a condition.
 */
export const PackIntegrationKnowledge = Schema.Struct({
  id: PackSlug,
  title: PackSummaryText,
  detail: PackIntegrationKnowledgeDetail,
  conditions: PackConditions,
  origin: PackKnowledgeOrigin,
  standing: Schema.optional(PackKnowledgeStanding),
  /**
   * What a model produces instead when it has to guess. Carried because the
   * failure this prevents is a confident wrong answer rather than a missing
   * one, and an agent that has been shown the wrong answer can recognise
   * itself about to give it.
   */
  commonMistake: Schema.optional(PackKnowledgeText),
  preventsFailureModeIds: Schema.optional(Schema.Array(PackSlug)),
});
export type PackIntegrationKnowledge = typeof PackIntegrationKnowledge.Type;

/**
 * Present even when empty, like requirements and permissions. `{}` is an
 * honest and useful claim — this pack has run nowhere and learned nothing yet —
 * and it is a different statement from an absent section. Making it required is
 * what stops the knowledge from being the part everybody skips.
 */
export const PackKnowledge = Schema.Struct({
  failureModes: Schema.optional(Schema.Array(PackFailureMode)),
  integration: Schema.optional(Schema.Array(PackIntegrationKnowledge)),
});
export type PackKnowledge = typeof PackKnowledge.Type;

// ── Requirements the consumer must satisfy ──────────────────────────────────

/**
 * A value the consumer supplies. `secret` drives storage and redaction, so it
 * is separate from `required`: a public publishable key is required and not
 * secret, a webhook signing secret is both.
 */
export const PackEnvRequirement = Schema.Struct({
  name: PackEnvVarName,
  purpose: PackPurposeText,
  secret: Schema.Boolean,
  required: Schema.Boolean,
  /** Never a real value — a shape, so the installer can show what to expect. */
  example: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  defaultValue: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** Where to go to get one. The difference between a pack that installs and
   * one that stalls on the first missing key. */
  obtainUrl: Schema.optional(PackUrl),
  /** Lets an installer reject an obviously wrong paste before anything runs. */
  pattern: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type PackEnvRequirement = typeof PackEnvRequirement.Type;

/** A third-party account the consumer has to hold in their own name. */
export const PackExternalAccount = Schema.Struct({
  service: PackSlug,
  displayName: TrimmedNonEmptyString,
  purpose: PackPurposeText,
  signupUrl: Schema.optional(PackUrl),
  requiredScopes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  requiredPlan: Schema.optional(TrimmedNonEmptyString),
  /** Flags the packs that cost money to run, before install rather than after. */
  costsMoney: Schema.optional(Schema.Boolean),
  providesEnvironment: Schema.optional(Schema.Array(PackEnvVarName)),
});
export type PackExternalAccount = typeof PackExternalAccount.Type;

export const PackServiceDependencyKind = Schema.Literals([
  "postgres",
  "mysql",
  "sqlite",
  "redis",
  "object-storage",
  "smtp",
  "queue",
  "vector-store",
  "custom",
]);
export type PackServiceDependencyKind = typeof PackServiceDependencyKind.Type;

/** Infrastructure the consumer must already be running or willing to run. */
export const PackServiceDependency = Schema.Struct({
  kind: PackServiceDependencyKind,
  name: PackSlug,
  purpose: PackPurposeText,
  versionRange: Schema.optional(PackVersionRange),
  connectionEnvVar: Schema.optional(PackEnvVarName),
});
export type PackServiceDependency = typeof PackServiceDependency.Type;

export const PackToolchainRequirement = Schema.Struct({
  name: PackSlug,
  versionRange: Schema.optional(PackVersionRange),
});
export type PackToolchainRequirement = typeof PackToolchainRequirement.Type;

export const PackDependency = Schema.Struct({
  id: PackId,
  name: PackName,
  publisherHandle: PackHandle,
  versionRange: PackVersionRange,
  optional: Schema.optional(Schema.Boolean),
});
export type PackDependency = typeof PackDependency.Type;

/**
 * An ordered step towards a runnable install. `satisfies` closes the loop
 * between a declared key and the instructions for getting it, and `verify` is
 * what lets a consuming agent check its own work instead of guessing.
 */
export const PackSetupStep = Schema.Struct({
  title: PackSummaryText,
  instructions: PackDescriptionText,
  command: Schema.optional(PackCommandText),
  verifyCommand: Schema.optional(PackCommandText),
  satisfies: Schema.optional(Schema.Array(PackEnvVarName)),
  /** Steps a machine cannot do, such as signing a contract or passing KYC. */
  manual: Schema.optional(Schema.Boolean),
});
export type PackSetupStep = typeof PackSetupStep.Type;

/**
 * Present even when empty: `{}` is an affirmative claim that the pack needs
 * nothing supplied, which is a different statement from an absent section and
 * one a reviewer can hold the publisher to.
 */
export const PackRequirements = Schema.Struct({
  environment: Schema.optional(Schema.Array(PackEnvRequirement)),
  accounts: Schema.optional(Schema.Array(PackExternalAccount)),
  services: Schema.optional(Schema.Array(PackServiceDependency)),
  toolchain: Schema.optional(Schema.Array(PackToolchainRequirement)),
  packs: Schema.optional(Schema.Array(PackDependency)),
  setupSteps: Schema.optional(Schema.Array(PackSetupStep)),
  /** Exits zero when everything above is in place. One command, so an agent
   * can answer "can this run yet?" without interpreting the list itself. */
  preflightCommand: Schema.optional(PackCommandText),
});
export type PackRequirements = typeof PackRequirements.Type;

// ── Interfaces ──────────────────────────────────────────────────────────────

export const PackHttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type PackHttpMethod = typeof PackHttpMethod.Type;

export const PackAuthenticationKind = Schema.Literals([
  "none",
  "api-key",
  "bearer",
  "session",
  "signature",
  "oauth",
]);
export type PackAuthenticationKind = typeof PackAuthenticationKind.Type;

/**
 * One callable operation. `operationId` is the join key: analytics meters
 * operations by id rather than restating routes, so a path can change without
 * orphaning a dashboard.
 */
export const PackApiOperation = Schema.Struct({
  operationId: PackSlug,
  method: PackHttpMethod,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  summary: PackSummaryText,
  authentication: Schema.optional(PackAuthenticationKind),
  requiresEnvironment: Schema.optional(Schema.Array(PackEnvVarName)),
});
export type PackApiOperation = typeof PackApiOperation.Type;

export const PackLibraryExport = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  kind: Schema.Literals(["function", "class", "component", "type", "constant", "hook"]),
  summary: PackSummaryText,
  signature: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
});
export type PackLibraryExport = typeof PackLibraryExport.Type;

export const PackCliCommand = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  usage: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  summary: PackSummaryText,
});
export type PackCliCommand = typeof PackCliCommand.Type;

/**
 * How a consumer touches the pack. A union rather than a `hasWebUi` flag,
 * because a headless payments API and a dashboard are not the same product and
 * a marketplace that assumes a front end cannot list the first one.
 *
 * `serviceId` points at the runtime service that hosts the interface, so ports
 * are declared exactly once.
 */
export const PackInterface = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("web"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    serviceId: Schema.optional(PackSlug),
    basePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
    framework: Schema.optional(TrimmedNonEmptyString),
    requiresAuthentication: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("tui"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    command: PackCommandText,
    summary: Schema.optional(PackSummaryText),
  }),
  Schema.Struct({
    kind: Schema.Literal("api"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    protocol: Schema.Literals(["http", "websocket", "grpc"]),
    serviceId: Schema.optional(PackSlug),
    basePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
    specPath: Schema.optional(PackRelativePath),
    operations: Schema.NonEmptyArray(PackApiOperation),
  }),
  Schema.Struct({
    kind: Schema.Literal("library"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    language: TrimmedNonEmptyString,
    packageName: Schema.optional(TrimmedNonEmptyString),
    importPath: Schema.optional(PackRelativePath),
    exports: Schema.NonEmptyArray(PackLibraryExport),
  }),
  Schema.Struct({
    kind: Schema.Literal("cli"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    binary: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    commands: Schema.NonEmptyArray(PackCliCommand),
  }),
  /** Packs are searched and installed by agents, so being callable as tools is
   * a first-class interface rather than an integration detail. */
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    transport: Schema.Literals(["stdio", "http"]),
    command: Schema.optional(PackCommandText),
    serviceId: Schema.optional(PackSlug),
    tools: Schema.NonEmptyArray(
      Schema.Struct({
        name: PackSlug,
        summary: PackSummaryText,
      }),
    ),
  }),
]);
export type PackInterface = typeof PackInterface.Type;

// ── Runtime ─────────────────────────────────────────────────────────────────

export const PackRuntimeTarget = Schema.Literals([
  "node",
  "bun",
  "deno",
  "python",
  "go",
  "rust",
  "container",
  "static",
  "none",
]);
export type PackRuntimeTarget = typeof PackRuntimeTarget.Type;

export const PackRuntimeCommand = Schema.Struct({
  command: PackCommandText,
  cwd: Schema.optional(PackRelativePath),
  description: Schema.optional(PackSummaryText),
});
export type PackRuntimeCommand = typeof PackRuntimeCommand.Type;

/**
 * A fixed lifecycle rather than a free list, because every downstream surface
 * needs to answer the same handful of questions and an open-ended array would
 * force each of them to guess which entry means "start".
 */
export const PackRuntimeCommands = Schema.Struct({
  install: Schema.optional(PackRuntimeCommand),
  build: Schema.optional(PackRuntimeCommand),
  start: Schema.optional(PackRuntimeCommand),
  dev: Schema.optional(PackRuntimeCommand),
  test: Schema.optional(PackRuntimeCommand),
  migrate: Schema.optional(PackRuntimeCommand),
  healthcheck: Schema.optional(PackRuntimeCommand),
});
export type PackRuntimeCommands = typeof PackRuntimeCommands.Type;

/**
 * How a service picks its port. A union because "port 3000", "whatever `PORT`
 * says" and "the runtime assigns one" need different handling at deploy time
 * and a nullable number cannot tell them apart.
 */
export const PackPortBinding = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("fixed"),
    port: PackPort,
  }),
  Schema.Struct({
    type: Schema.Literal("environment"),
    envVar: PackEnvVarName,
    defaultPort: Schema.optional(PackPort),
  }),
  Schema.Struct({
    type: Schema.Literal("dynamic"),
  }),
]);
export type PackPortBinding = typeof PackPortBinding.Type;

export const PackRuntimeService = Schema.Struct({
  id: PackSlug,
  title: TrimmedNonEmptyString,
  protocol: Schema.Literals(["http", "https", "ws", "tcp", "grpc"]),
  binding: PackPortBinding,
  /** Whether the deploy surface should route public traffic here. */
  exposure: Schema.Literals(["public", "internal", "loopback"]),
  healthPath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type PackRuntimeService = typeof PackRuntimeService.Type;

export const PackContainerSpec = Schema.Struct({
  dockerfilePath: Schema.optional(PackRelativePath),
  composePath: Schema.optional(PackRelativePath),
  image: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type PackContainerSpec = typeof PackContainerSpec.Type;

export const PackRuntime = Schema.Struct({
  target: PackRuntimeTarget,
  versionRange: Schema.optional(PackVersionRange),
  commands: PackRuntimeCommands,
  services: Schema.optional(Schema.Array(PackRuntimeService)),
  container: Schema.optional(PackContainerSpec),
});
export type PackRuntime = typeof PackRuntime.Type;

// ── Permissions ─────────────────────────────────────────────────────────────

/**
 * What leaves the machine. Declared per destination so a reviewer reads
 * "card data goes to Stripe" instead of inferring it from source.
 */
export const PackDataClass = Schema.Literals([
  "payment",
  "pii",
  "credentials",
  "content",
  "telemetry",
  "none",
]);
export type PackDataClass = typeof PackDataClass.Type;

export const PackNetworkEgress = Schema.Struct({
  host: PackHostPattern,
  purpose: PackPurposeText,
  ports: Schema.optional(Schema.Array(PackPort)),
  required: Schema.optional(Schema.Boolean),
  dataClasses: Schema.optional(Schema.Array(PackDataClass)),
});
export type PackNetworkEgress = typeof PackNetworkEgress.Type;

/**
 * Filesystem access is anchored to a named root rather than a raw path, so a
 * sandbox can map the roots however it likes and `absolute` stands out as the
 * one case a reviewer has to argue with.
 */
export const PackFilesystemRoot = Schema.Literals([
  "pack",
  "data",
  "tmp",
  "workspace",
  "home",
  "absolute",
]);
export type PackFilesystemRoot = typeof PackFilesystemRoot.Type;

export const PackFilesystemAccess = Schema.Struct({
  root: PackFilesystemRoot,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_RELATIVE_PATH_MAX_LENGTH)),
  access: Schema.Literals(["read", "write", "read-write"]),
  purpose: PackPurposeText,
});
export type PackFilesystemAccess = typeof PackFilesystemAccess.Type;

export const PackSecretAccess = Schema.Struct({
  name: PackEnvVarName,
  purpose: PackPurposeText,
});
export type PackSecretAccess = typeof PackSecretAccess.Type;

export const PackProcessPermission = Schema.Struct({
  spawnsSubprocesses: Schema.Boolean,
  commands: Schema.optional(Schema.Array(PackCommandText)),
});
export type PackProcessPermission = typeof PackProcessPermission.Type;

/**
 * Anything the permission model above cannot express. Each entry carries a
 * justification because these are exactly the requests a human should read
 * before approving, and an unjustified escalation is a review failure.
 */
export const PackElevatedCapability = Schema.Struct({
  capability: Schema.Literals([
    "raw-socket",
    "native-module",
    "privileged-port",
    "host-network",
    "docker-socket",
    "system-package-install",
    "kernel-module",
  ]),
  justification: PackPurposeText,
});
export type PackElevatedCapability = typeof PackElevatedCapability.Type;

/**
 * Like requirements, present even when empty: `{}` claims the pack needs no
 * access at all, and enforcement later gets to treat anything undeclared as a
 * violation rather than an omission.
 */
export const PackPermissions = Schema.Struct({
  network: Schema.optional(Schema.Array(PackNetworkEgress)),
  acceptsInboundNetwork: Schema.optional(Schema.Boolean),
  filesystem: Schema.optional(Schema.Array(PackFilesystemAccess)),
  secrets: Schema.optional(Schema.Array(PackSecretAccess)),
  process: Schema.optional(PackProcessPermission),
  elevated: Schema.optional(Schema.Array(PackElevatedCapability)),
});
export type PackPermissions = typeof PackPermissions.Type;

// ── Verification: signals earned in production ──────────────────────────────

/**
 * A test that keeps running after install. `guardsFailureModeId` is what turns
 * a check into evidence rather than ceremony: a check that exists because
 * something broke, still passing across four hundred deployments, is a stronger
 * statement about this pack than any review of its source.
 *
 * Counts rather than a pass/fail badge, because a check that ran four hundred
 * times and failed twice, a check that has never run, and a check that passed
 * once on the author's laptop are three different facts and a badge collapses
 * them into one.
 */
export const PackProductionCheck = Schema.Struct({
  id: PackSlug,
  title: PackSummaryText,
  command: PackCommandText,
  runsOn: Schema.NonEmptyArray(Schema.Literals(["install", "deploy", "schedule", "upgrade"])),
  guardsFailureModeId: Schema.optional(PackSlug),
  runs: NonNegativeInt,
  passes: NonNegativeInt,
  /** Distinct deployments it ran in, so repetition is not read as coverage. */
  deploymentsCovered: Schema.optional(NonNegativeInt),
  lastRunAt: Schema.optional(IsoDateTime),
  lastOutcome: Schema.optional(Schema.Literals(["pass", "fail", "error", "skipped"])),
});
export type PackProductionCheck = typeof PackProductionCheck.Type;

/**
 * What the pack has survived. Raw counts, never rates: the consumer is an agent
 * and can divide, and a stored ratio hides the denominator that decides whether
 * the ratio means anything. Nine of ten installs succeeding is a fact; nine of
 * ten with the ten unstated is a claim.
 *
 * Required on every manifest, filled with zeros on a pack that has never run.
 * A clean record has to be visibly clean rather than absent, because "no
 * breakages" and "no deployments" are the two ends of this format's central
 * judgement and an omitted section reads like the good one.
 */
export const PackScarRecord = Schema.Struct({
  /** Everything below is as of this moment; a count with no as-of is unusable. */
  measuredAt: IsoDateTime,
  installsAttempted: NonNegativeInt,
  installsSucceeded: NonNegativeInt,
  deploymentsAttempted: NonNegativeInt,
  /** Still running. The only number that cannot be inflated by trying again. */
  deploymentsSurviving: NonNegativeInt,
  /**
   * Cohort survival at thirty, sixty and ninety days. Deployments that go quiet
   * in the first month teach nothing, so this is the measure of whether the
   * knowledge behind the pack is still being fed.
   */
  survival: Schema.optional(
    Schema.Struct({
      cohortSize: NonNegativeInt,
      aliveAtDay30: NonNegativeInt,
      aliveAtDay60: Schema.optional(NonNegativeInt),
      aliveAtDay90: Schema.optional(NonNegativeInt),
    }),
  ),
  /** Deployment-days summed across every install, and the longest single run. */
  cumulativeServiceDays: NonNegativeInt,
  longestServiceDays: Schema.optional(NonNegativeInt),
  firstDeployedAt: Schema.optional(IsoDateTime),
  /** Failures the maintenance agent caught, and how many became fixes. */
  breakagesCaught: NonNegativeInt,
  breakagesFixed: NonNegativeInt,
  /** Installs that followed carried knowledge and found it wrong. The provider
   * churn alarm, and the one number a publisher would rather not publish. */
  knowledgeContradictions: Schema.optional(NonNegativeInt),
});
export type PackScarRecord = typeof PackScarRecord.Type;

/**
 * "We ran it." Kept deliberately secondary and deliberately specific: it names
 * who did what, on what, and when, and it carries no ranking of its own.
 * Manual review does not scale and self-attestation means nothing, so this is
 * evidence a consumer may weigh rather than a badge a registry confers — and
 * `conditions` is what stops "we ran it" from meaning "it runs".
 */
export const PackAttestation = Schema.Struct({
  attestedAt: IsoDateTime,
  attestedBy: PackAuthor,
  did: Schema.NonEmptyArray(
    Schema.Literals([
      "installed-from-clean",
      "ran-checks",
      "reviewed-source",
      "reviewed-permissions",
      "scanned-secrets",
      "deployed-to-production",
    ]),
  ),
  conditions: Schema.optional(PackConditions),
  note: Schema.optional(PackPurposeText),
});
export type PackAttestation = typeof PackAttestation.Type;

/**
 * A stop signal, separate from the earned signals above because "nobody has run
 * this yet" and "this was pulled" are opposite claims and no single scale holds
 * both. This is the one part of the old reviewer-owned badge worth keeping: a
 * pack found to be dangerous has to be withdrawable without waiting for
 * production to notice.
 */
export const PackAdvisory = Schema.Struct({
  id: PackSlug,
  severity: Schema.Literals(["revoked", "critical", "warning"]),
  reason: PackDescriptionText,
  issuedAt: IsoDateTime,
  issuedBy: TrimmedNonEmptyString,
  affectedVersions: Schema.optional(Schema.Array(PackVersionRange)),
  failureModeId: Schema.optional(PackSlug),
});
export type PackAdvisory = typeof PackAdvisory.Type;

/**
 * What is known about whether this works, expressed as signals a consumer
 * thresholds itself rather than as a tier somebody assigned. A tier is coarser
 * than the decision being made — an agent wiring up a payment flow and an agent
 * wiring up a changelog widget want different bars — and the consumer here is
 * an agent, which can handle the nuance a badge throws away.
 *
 * The registry owns `advisories` and the runtime owns `record` and `checks`;
 * the publisher may write `attestations` and nothing else that ranks.
 */
export const PackVerification = Schema.Struct({
  record: PackScarRecord,
  checks: Schema.optional(Schema.Array(PackProductionCheck)),
  attestations: Schema.optional(Schema.Array(PackAttestation)),
  advisories: Schema.optional(Schema.Array(PackAdvisory)),
});
export type PackVerification = typeof PackVerification.Type;

// ── Visibility ──────────────────────────────────────────────────────────────

/**
 * Who can find and install this. The scoped variants carry their own id so an
 * installer can refuse a pack that wandered outside its boundary, and
 * `unlisted` exists because "share a link with a client" is not the same
 * request as "put this in the marketplace".
 */
export const PackVisibility = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("workspace"),
    workspaceKeyId: PackWorkspaceKeyId,
    workspaceId: Schema.optional(WorkspaceId),
  }),
  Schema.Struct({
    scope: Schema.Literal("tenant"),
    tenantId: TenantId,
  }),
  Schema.Struct({
    scope: Schema.Literal("organization"),
    organizationId: OrganizationId,
  }),
  Schema.Struct({
    scope: Schema.Literal("unlisted"),
  }),
  Schema.Struct({
    scope: Schema.Literal("public"),
  }),
]);
export type PackVisibility = typeof PackVisibility.Type;

// ── Integration ─────────────────────────────────────────────────────────────

export const PackIntegrationTarget = Schema.Literals([
  "generic",
  "t3",
  "claude-code",
  "codex",
  "cursor",
  "windsurf",
  "lovable",
  "replit",
  "v0",
  "bolt",
]);
export type PackIntegrationTarget = typeof PackIntegrationTarget.Type;

export const PackIntegrationSnippet = Schema.Struct({
  title: PackSummaryText,
  language: PackSlug,
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  description: Schema.optional(PackPurposeText),
});
export type PackIntegrationSnippet = typeof PackIntegrationSnippet.Type;

/**
 * The paste-into-another-agent surface. The generic prompt is required and
 * inline so a search result is immediately actionable without fetching files;
 * variants exist because the same instructions land differently in a tool that
 * owns its own hosting than in one that does not.
 *
 * This is the carrier, not the knowledge. It says how to invoke the pack, and
 * it is authored once at extraction; `knowledge.integration` says what goes
 * wrong while doing so, is written by whatever observed it, and carries the
 * conditions it was true under. Keeping them apart is what stops an accumulated
 * scar record from being flattened back into a prompt nobody updates.
 */
export const PackIntegration = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
  installCommand: Schema.optional(PackCommandText),
  variants: Schema.optional(
    Schema.Array(
      Schema.Struct({
        target: PackIntegrationTarget,
        prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
      }),
    ),
  ),
  snippets: Schema.optional(Schema.Array(PackIntegrationSnippet)),
  /** What the consuming agent should ask its user before wiring anything up. */
  followUpQuestions: Schema.optional(Schema.Array(PackSummaryText)),
});
export type PackIntegration = typeof PackIntegration.Type;

// ── Analytics ───────────────────────────────────────────────────────────────

export const PackAnalyticsProperty = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/), Schema.isMaxLength(64)),
  type: Schema.Literals(["string", "number", "boolean", "timestamp"]),
  /** Drives redaction and retention downstream, so it is required per property. */
  pii: Schema.Boolean,
  description: Schema.optional(PackPurposeText),
});
export type PackAnalyticsProperty = typeof PackAnalyticsProperty.Type;

export const PackAnalyticsEvent = Schema.Struct({
  name: PackEventName,
  source: Schema.Literals(["frontend", "backend", "job", "cli"]),
  description: PackPurposeText,
  properties: Schema.optional(Schema.Array(PackAnalyticsProperty)),
});
export type PackAnalyticsEvent = typeof PackAnalyticsEvent.Type;

/**
 * A chart the deployment dashboard can draw without anyone configuring it.
 * Sources reference declared events and operation ids rather than restating
 * routes, so the manifest keeps one definition of each traffic surface.
 */
export const PackAnalyticsMetric = Schema.Struct({
  id: PackSlug,
  title: PackSummaryText,
  kind: Schema.Literals(["count", "unique-users", "sum", "latency-p95", "error-rate"]),
  source: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("event"),
      event: PackEventName,
      property: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
    }),
    Schema.Struct({
      type: Schema.Literal("operation"),
      operationId: PackSlug,
    }),
  ]),
  unit: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
});
export type PackAnalyticsMetric = typeof PackAnalyticsMetric.Type;

export const PackAnalytics = Schema.Struct({
  events: Schema.optional(Schema.Array(PackAnalyticsEvent)),
  /** Operation ids whose traffic should be counted, drawn from the interfaces. */
  meteredOperations: Schema.optional(Schema.Array(PackSlug)),
  metrics: Schema.optional(Schema.Array(PackAnalyticsMetric)),
  sink: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["t3", "none", "custom"]),
      endpointEnvVar: Schema.optional(PackEnvVarName),
    }),
  ),
});
export type PackAnalytics = typeof PackAnalytics.Type;

// ── Contents and signature ──────────────────────────────────────────────────

export const PackFileDigest = Schema.Struct({
  path: PackRelativePath,
  sha256: PackSha256,
  bytes: NonNegativeInt,
});
export type PackFileDigest = typeof PackFileDigest.Type;

/**
 * Where the conventional files actually live. Paths are declared rather than
 * assumed so a pack can be laid out to suit its language, and the digest list
 * is what a signature and an archive are checked against. Authoring tools leave
 * `files` empty; the publisher fills it when the bytes stop moving.
 */
export const PackContents = Schema.Struct({
  readmePath: Schema.optional(PackRelativePath),
  licensePath: Schema.optional(PackRelativePath),
  iconPath: Schema.optional(PackRelativePath),
  sourceRoot: Schema.optional(PackRelativePath),
  examplesRoot: Schema.optional(PackRelativePath),
  files: Schema.optional(Schema.Array(PackFileDigest)),
  archiveSha256: Schema.optional(PackSha256),
});
export type PackContents = typeof PackContents.Type;

/**
 * Covers the canonical manifest with this block removed, plus the contents
 * digest, so neither the metadata nor the files can be swapped independently.
 */
export const PackSignature = Schema.Struct({
  keyId: PackSigningKeyId,
  algorithm: Schema.Literal("ed25519"),
  publicKey: PackBase64,
  manifestSha256: PackSha256,
  contentsSha256: Schema.optional(PackSha256),
  signature: PackBase64,
  signedAt: IsoDateTime,
});
export type PackSignature = typeof PackSignature.Type;

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * The whole of `pack.json`. Sections are grouped by the question they answer —
 * who made it, where it came from, what it does, what it has learned, what you
 * must bring, how you touch it, how it runs, what it may reach, what production
 * says about it, who may see it, how to wire it up, what it reports — because
 * that is the order a consumer reads them in and the order the downstream
 * surfaces consume them.
 *
 * `knowledge` sits directly after `capability` because "what does it do" and
 * "what does it know that I do not" are asked together, and because the second
 * question is the one this format exists to answer.
 */
export const PackManifest = Schema.Struct({
  formatVersion: PackFormatVersion,
  identity: PackIdentity,
  provenance: PackProvenance,
  capability: PackCapability,
  knowledge: PackKnowledge,
  requirements: PackRequirements,
  interfaces: Schema.NonEmptyArray(PackInterface),
  runtime: PackRuntime,
  permissions: PackPermissions,
  verification: PackVerification,
  visibility: PackVisibility,
  integration: PackIntegration,
  analytics: Schema.optional(PackAnalytics),
  contents: Schema.optional(PackContents),
  signature: Schema.optional(PackSignature),
});
export type PackManifest = typeof PackManifest.Type;

/**
 * Read first, decoded loosely, so an unsupported format version produces a
 * useful message instead of a pile of missing-field errors.
 */
export const PackManifestEnvelope = Schema.Struct({
  formatVersion: TrimmedNonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type PackManifestEnvelope = typeof PackManifestEnvelope.Type;

// ── Registry projections ────────────────────────────────────────────────────

/** Enough to name one exact release. */
export const PackRef = Schema.Struct({
  id: PackId,
  name: PackName,
  version: PackVersion,
  publisherHandle: PackHandle,
});
export type PackRef = typeof PackRef.Type;

/**
 * What a search returns. Flattened out of the manifest so a coding agent can
 * scan many candidates cheaply, and carrying the required keys because "what
 * would I have to set up" is the first question that rules a pack out.
 *
 * The production signals travel here as raw counts rather than as a badge, so
 * ranking happens at the consumer: pack mode can lead with "running in 340
 * deployments and it handles the webhook idempotency case that breaks most
 * implementations" only if the search result carries the numbers behind both
 * halves of that sentence.
 */
export const PackSummary = Schema.Struct({
  ref: PackRef,
  displayName: TrimmedNonEmptyString,
  summary: PackSummaryText,
  does: PackSummaryText,
  categories: Schema.optional(Schema.Array(PackCategory)),
  tags: Schema.optional(Schema.Array(PackTag)),
  interfaceKinds: Schema.NonEmptyArray(
    Schema.Literals(["web", "tui", "api", "library", "cli", "mcp"]),
  ),
  requiredEnvironment: Schema.Array(PackEnvVarName),
  requiredAccounts: Schema.Array(PackSlug),
  installsAttempted: NonNegativeInt,
  installsSucceeded: NonNegativeInt,
  deploymentsSurviving: NonNegativeInt,
  cumulativeServiceDays: NonNegativeInt,
  breakagesCaught: NonNegativeInt,
  knownFailureModes: NonNegativeInt,
  /** Failures with no fix yet. The number a cautious consumer filters on. */
  openFailureModes: NonNegativeInt,
  integrationKnowledgeEntries: NonNegativeInt,
  /** Oldest `conditions.observedAt` across the knowledge, so stale knowledge is
   * visible in a list rather than only after opening the pack. */
  knowledgeOldestObservedAt: Schema.optional(IsoDateTime),
  hasAdvisory: Schema.Boolean,
  visibilityScope: Schema.Literals(["workspace", "tenant", "organization", "unlisted", "public"]),
  license: PackLicense,
  updatedAt: IsoDateTime,
});
export type PackSummary = typeof PackSummary.Type;

// ── Publish readiness ───────────────────────────────────────────────────────

/**
 * Rules that a well-formed manifest can still break. They are kept out of the
 * schema on purpose: a half-finished pack must stay decodable so the tooling
 * can tell its author what is missing, rather than refusing to open the file.
 */
export const PackReadinessCode = Schema.Literals([
  "handover-empty",
  "start-command-missing",
  "service-binding-missing",
  "integration-prompt-thin",
  "license-unspecified",
  "requirements-undeclared",
  "permissions-undeclared",
  "secret-value-in-manifest",
  "elevated-capability-unjustified",
  "analytics-operation-unknown",
  "interface-service-unknown",
  "contents-digest-missing",
  "signature-missing",
  /** No production behind it. A warning rather than an error, because a pack
   * has to be publishable before it can earn anything, but a loud one: this is
   * the difference between a proven capability and a template. */
  "knowledge-absent",
  "verification-record-unmeasured",
  /** Knowledge whose conditions have aged past the point of being asserted. */
  "knowledge-conditions-stale",
  "knowledge-contradicted",
  "failure-mode-open-critical",
  /** A failure mode, check or boundary pointing at an id nothing declares. */
  "knowledge-reference-unknown",
  "credential-knowledge-unlinked",
  "customisation-boundary-unexplained",
  "check-never-run",
  "advisory-open",
]);
export type PackReadinessCode = typeof PackReadinessCode.Type;

export const PackReadinessIssue = Schema.Struct({
  code: PackReadinessCode,
  severity: Schema.Literals(["error", "warning"]),
  /** Dotted path into the manifest, so an editor can jump straight to it. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  message: PackPurposeText,
});
export type PackReadinessIssue = typeof PackReadinessIssue.Type;

export const PackReadinessReport = Schema.Struct({
  ref: PackRef,
  publishable: Schema.Boolean,
  issues: Schema.Array(PackReadinessIssue),
});
export type PackReadinessReport = typeof PackReadinessReport.Type;

export class PackError extends Schema.TaggedErrorClass<PackError>()("PackError", {
  message: TrimmedNonEmptyString,
  code: Schema.Literals([
    "manifest-not-found",
    "manifest-invalid",
    "format-version-unsupported",
    "signature-invalid",
    "digest-mismatch",
    "pack-not-found",
    "version-exists",
    "visibility-forbidden",
    "requirements-unmet",
    /** The consumer's own threshold on the production signals was not met. */
    "signals-insufficient",
    "advisory-blocked",
  ]),
  cause: Schema.optional(Schema.Defect),
}) {}
