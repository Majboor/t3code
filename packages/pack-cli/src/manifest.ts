/**
 * The CLI's only contact with the inside of a manifest.
 *
 * Every other module here works on the views this file returns, so when the
 * format moves a field — and it is still moving — this is the one file that has
 * to change. Nothing outside it imports `@t3tools/contracts`.
 *
 * Two rules hold everywhere below:
 *
 * - **Decode strictly, read loosely.** A manifest is validated against the
 *   schema on the way in, so an unreadable pack is reported rather than half
 *   understood. The readers themselves walk the decoded value structurally, so
 *   a field the type does not carry yet is absent from the output instead of a
 *   crash on the hot path. `search` is called constantly by an agent; it must
 *   never be the thing that breaks.
 * - **Omit rather than invent.** An unknown count is left out; it is never
 *   defaulted to zero, because zero installs and unrecorded installs are
 *   opposite claims and this format exists to keep them apart.
 *
 * @module manifest
 */
import {
  PACK_DIRECTORY_SUFFIX,
  PACK_FORMAT_VERSION,
  PACK_HANDOVER_FILENAME,
  PACK_MANIFEST_FILENAME,
  PackManifest,
  PackManifestEnvelope,
} from "@t3tools/contracts";
import { Result, Schema, SchemaIssue } from "effect";

export const MANIFEST_FILENAME = PACK_MANIFEST_FILENAME;
export const HANDOVER_FILENAME = PACK_HANDOVER_FILENAME;
export const DIRECTORY_SUFFIX = PACK_DIRECTORY_SUFFIX;
export const FORMAT_VERSION = PACK_FORMAT_VERSION;

/**
 * Dotted paths, kept here rather than spelled out at each rule, so a readiness
 * report keeps pointing at the right place after a field moves.
 */
export const MANIFEST_PATHS = {
  handoverSummary: "provenance.handover.summary",
  startCommand: "runtime.commands.start",
  runtimeServices: "runtime.services",
  interfaces: "interfaces",
  integrationPrompt: "integration.prompt",
  environment: "requirements.environment",
  elevated: "permissions.elevated",
  analyticsMetered: "analytics.meteredOperations",
  knowledge: "knowledge",
  failureModes: "knowledge.failureModes",
  integrationKnowledge: "knowledge.integration",
  verificationRecord: "verification.record",
  checks: "verification.checks",
  advisories: "verification.advisories",
  contents: "contents",
  signature: "signature",
} as const;

// ── Structural readers ──────────────────────────────────────────────────────

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function at(source: unknown, ...path: ReadonlyArray<string>): unknown {
  let current: unknown = source;
  for (const key of path) {
    const parent = object(current);
    if (parent === undefined) {
      return undefined;
    }
    current = parent[key];
  }
  return current;
}

function text(source: unknown, ...path: ReadonlyArray<string>): string | undefined {
  const value = at(source, ...path);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function count(source: unknown, ...path: ReadonlyArray<string>): number | undefined {
  const value = at(source, ...path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flag(source: unknown, ...path: ReadonlyArray<string>): boolean | undefined {
  const value = at(source, ...path);
  return typeof value === "boolean" ? value : undefined;
}

function items(source: unknown, ...path: ReadonlyArray<string>): ReadonlyArray<unknown> {
  const value = at(source, ...path);
  return Array.isArray(value) ? (value as ReadonlyArray<unknown>) : [];
}

function texts(source: unknown, ...path: ReadonlyArray<string>): ReadonlyArray<string> {
  return items(source, ...path).filter((entry): entry is string => typeof entry === "string");
}

/** Empty lists are dropped so a card carries only what the pack actually says. */
function whenAny<A>(values: ReadonlyArray<A>): ReadonlyArray<A> | undefined {
  return values.length > 0 ? values : undefined;
}

// ── Decoding ────────────────────────────────────────────────────────────────

const decodeManifest = Schema.decodeUnknownResult(PackManifest);
const decodeEnvelope = Schema.decodeUnknownResult(PackManifestEnvelope);
const formatIssue = SchemaIssue.makeFormatterDefault();

export type ManifestReadResult =
  | { readonly ok: true; readonly manifest: PackManifest; readonly raw: unknown }
  | {
      readonly ok: false;
      readonly reason: "manifest-invalid" | "format-version-unsupported";
      readonly message: string;
      readonly formatVersion: string | undefined;
    };

/**
 * Reads the envelope before the body, so a manifest from a newer T3 says so
 * instead of producing forty missing-field errors.
 */
export function readManifest(raw: unknown): ManifestReadResult {
  const envelope = decodeEnvelope(raw);
  const formatVersion = Result.isSuccess(envelope) ? envelope.success.formatVersion : undefined;
  if (formatVersion !== undefined && formatVersion !== FORMAT_VERSION) {
    return {
      ok: false,
      reason: "format-version-unsupported",
      message: `This pack declares format version ${formatVersion}; this CLI reads ${FORMAT_VERSION}.`,
      formatVersion,
    };
  }
  const decoded = decodeManifest(raw);
  if (Result.isFailure(decoded)) {
    return {
      ok: false,
      reason: "manifest-invalid",
      message: formatIssue(decoded.failure),
      formatVersion,
    };
  }
  return { ok: true, manifest: decoded.success, raw };
}

export function parseManifestJson(source: string): ManifestReadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    return {
      ok: false,
      reason: "manifest-invalid",
      message: `${MANIFEST_FILENAME} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      formatVersion: undefined,
    };
  }
  return readManifest(raw);
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface PackRefView {
  readonly id: string | undefined;
  readonly name: string;
  readonly version: string | undefined;
  readonly publisher: string | undefined;
  /** `publisher/name@version`, which is what an install command wants. */
  readonly qualified: string;
}

export interface PackConditionsView {
  readonly observedAt: string | undefined;
  readonly accountTier: string | undefined;
  readonly regions: ReadonlyArray<string> | undefined;
  readonly consoleVersion: string | undefined;
  readonly apiVersion: string | undefined;
  readonly observedAcrossDeployments: number | undefined;
  readonly untestedAxes: ReadonlyArray<string> | undefined;
  /**
   * The hedge, pre-composed. An agent that repeats this instead of asserting
   * turns a trust-destroying wrong answer into a mild caveat.
   */
  readonly caveat: string | undefined;
}

export interface PackFailureModeView {
  readonly id: string | undefined;
  readonly symptom: string | undefined;
  readonly trigger: string | undefined;
  readonly triggerKinds: ReadonlyArray<string> | undefined;
  readonly severity: string | undefined;
  readonly silent: boolean | undefined;
  readonly attributedTo: string | undefined;
  readonly resolution: string | undefined;
  readonly resolutionDetail: string | undefined;
  readonly fixedIn: string | undefined;
  readonly detection:
    | { readonly signal: string | undefined; readonly match: string | undefined }
    | undefined;
  readonly deploymentsAffected: number | undefined;
  readonly firstSeenAt: string | undefined;
  readonly lastSeenAt: string | undefined;
  readonly conditions: PackConditionsView | undefined;
  readonly introducedIn: string | undefined;
  readonly source: string | undefined;
}

export interface PackConsoleStepView {
  readonly action: string | undefined;
  readonly url: string | undefined;
  readonly expect: string | undefined;
}

export interface PackIntegrationKnowledgeView {
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly kind: string | undefined;
  readonly conditions: PackConditionsView | undefined;
  readonly standing:
    | {
        readonly state: string | undefined;
        readonly confirmedInInstalls: number | undefined;
        readonly contradictedInInstalls: number | undefined;
        readonly lastConfirmedAt: string | undefined;
      }
    | undefined;
  /** What a model produces instead when it guesses. Shown so it recognises itself. */
  readonly commonMistake: string | undefined;
  readonly preventsFailureModeIds: ReadonlyArray<string> | undefined;
  readonly environmentVariable: string | undefined;
  readonly service: string | undefined;
  readonly credentialKind: string | undefined;
  readonly consoleUrl: string | undefined;
  readonly navigation: ReadonlyArray<PackConsoleStepView> | undefined;
  readonly scopes:
    | ReadonlyArray<{
        readonly name: string | undefined;
        readonly purpose: string | undefined;
        readonly required: boolean | undefined;
      }>
    | undefined;
  readonly rotation: string | undefined;
  readonly prompt: string | undefined;
  readonly touches: ReadonlyArray<string> | undefined;
  readonly rule: string | undefined;
  readonly rationale: string | undefined;
  readonly example: string | undefined;
  readonly decisions:
    | ReadonlyArray<{
        readonly subject: string | undefined;
        readonly latitude: string | undefined;
        readonly reason: string | undefined;
        readonly failureModeId: string | undefined;
        readonly path: string | undefined;
      }>
    | undefined;
}

export interface PackSetupView {
  readonly environment: ReadonlyArray<{
    readonly name: string | undefined;
    readonly purpose: string | undefined;
    readonly secret: boolean | undefined;
    readonly required: boolean | undefined;
    readonly obtainUrl: string | undefined;
    readonly example: string | undefined;
    readonly pattern: string | undefined;
  }>;
  readonly accounts: ReadonlyArray<{
    readonly service: string | undefined;
    readonly displayName: string | undefined;
    readonly purpose: string | undefined;
    readonly signupUrl: string | undefined;
    readonly requiredScopes: ReadonlyArray<string> | undefined;
    readonly costsMoney: boolean | undefined;
  }>;
  readonly services: ReadonlyArray<{
    readonly kind: string | undefined;
    readonly name: string | undefined;
    readonly versionRange: string | undefined;
  }>;
  readonly toolchain: ReadonlyArray<{
    readonly name: string | undefined;
    readonly versionRange: string | undefined;
  }>;
  readonly dependsOnPacks: ReadonlyArray<string>;
  readonly setupSteps: number;
  /** Steps a machine cannot do: signing up, passing KYC, clicking a link. */
  readonly manualSteps: number;
  readonly preflightCommand: string | undefined;
}

export interface PackSignalsView {
  readonly measuredAt: string | undefined;
  readonly installsAttempted: number | undefined;
  readonly installsSucceeded: number | undefined;
  readonly deploymentsAttempted: number | undefined;
  readonly deploymentsSurviving: number | undefined;
  readonly cumulativeServiceDays: number | undefined;
  readonly longestServiceDays: number | undefined;
  readonly firstDeployedAt: string | undefined;
  readonly breakagesCaught: number | undefined;
  readonly breakagesFixed: number | undefined;
  readonly knowledgeContradictions: number | undefined;
  readonly survival:
    | {
        readonly cohortSize: number | undefined;
        readonly aliveAtDay30: number | undefined;
        readonly aliveAtDay60: number | undefined;
        readonly aliveAtDay90: number | undefined;
      }
    | undefined;
  readonly checks: ReadonlyArray<{
    readonly id: string | undefined;
    readonly title: string | undefined;
    readonly runsOn: ReadonlyArray<string> | undefined;
    readonly guardsFailureModeId: string | undefined;
    readonly runs: number | undefined;
    readonly passes: number | undefined;
    readonly deploymentsCovered: number | undefined;
    readonly lastRunAt: string | undefined;
    readonly lastOutcome: string | undefined;
  }>;
  readonly attestations: ReadonlyArray<{
    readonly attestedAt: string | undefined;
    readonly attestedBy: string | undefined;
    readonly did: ReadonlyArray<string> | undefined;
    readonly conditions: PackConditionsView | undefined;
  }>;
  readonly advisories: ReadonlyArray<{
    readonly id: string | undefined;
    readonly severity: string | undefined;
    readonly reason: string | undefined;
    readonly issuedAt: string | undefined;
    readonly failureModeId: string | undefined;
  }>;
}

export interface PackKnowledgeCountsView {
  readonly failureModes: number;
  readonly openFailureModes: number;
  readonly integrationEntries: number;
  readonly credentialGuides: number;
  readonly oldestObservedAt: string | undefined;
  readonly contradicted: number;
}

export interface PackCardView {
  readonly ref: PackRefView;
  readonly displayName: string | undefined;
  readonly summary: string | undefined;
  readonly does: string | undefined;
  readonly categories: ReadonlyArray<string> | undefined;
  readonly tags: ReadonlyArray<string> | undefined;
  readonly nonGoals: ReadonlyArray<string> | undefined;
  readonly interfaceKinds: ReadonlyArray<string>;
  readonly license: string | undefined;
  readonly visibility: string | undefined;
  readonly setup: PackSetupView;
  readonly signals: PackSignalsView;
  /** Failures production already paid for and this pack has closed or contained. */
  readonly handles: ReadonlyArray<PackFailureModeView>;
  /** Failures still open. The list a cautious consumer thresholds on. */
  readonly openFailureModes: ReadonlyArray<PackFailureModeView>;
  readonly knowledge: PackKnowledgeCountsView;
  readonly installCommand: string | undefined;
}

export interface PackDetailView extends PackCardView {
  readonly description: string | undefined;
  readonly useCases: ReadonlyArray<string> | undefined;
  readonly integrationKnowledge: ReadonlyArray<PackIntegrationKnowledgeView>;
  readonly interfaces: ReadonlyArray<{
    readonly kind: string | undefined;
    readonly id: string | undefined;
    readonly title: string | undefined;
    readonly serviceId: string | undefined;
    readonly operations: ReadonlyArray<string> | undefined;
  }>;
  readonly runtime: {
    readonly target: string | undefined;
    readonly versionRange: string | undefined;
    readonly commands: Record<string, string>;
    readonly services: ReadonlyArray<{
      readonly id: string | undefined;
      readonly protocol: string | undefined;
      readonly exposure: string | undefined;
    }>;
  };
  readonly permissions: {
    readonly network: ReadonlyArray<{
      readonly host: string | undefined;
      readonly purpose: string | undefined;
      readonly dataClasses: ReadonlyArray<string> | undefined;
    }>;
    readonly filesystem: ReadonlyArray<{
      readonly root: string | undefined;
      readonly path: string | undefined;
      readonly access: string | undefined;
    }>;
    readonly secrets: ReadonlyArray<string>;
    readonly elevated: ReadonlyArray<{
      readonly capability: string | undefined;
      readonly justification: string | undefined;
    }>;
  };
  readonly integration: {
    readonly prompt: string | undefined;
    readonly installCommand: string | undefined;
    readonly variants:
      | ReadonlyArray<{
          readonly target: string | undefined;
          readonly prompt: string | undefined;
        }>
      | undefined;
    readonly snippets:
      | ReadonlyArray<{
          readonly title: string | undefined;
          readonly language: string | undefined;
          readonly code: string | undefined;
        }>
      | undefined;
    readonly followUpQuestions: ReadonlyArray<string> | undefined;
  };
  readonly provenance: {
    readonly extractedAt: string | undefined;
    readonly extractedBy: string | undefined;
    readonly handoverSummary: string | undefined;
    readonly handoverPath: string | undefined;
    readonly workspaceKeyId: string | undefined;
    readonly derivedFrom: string | undefined;
  };
}

// ── Readers ─────────────────────────────────────────────────────────────────

const MONTHS = [
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

function readConditions(source: unknown): PackConditionsView | undefined {
  const conditions = object(source);
  if (conditions === undefined) {
    return undefined;
  }
  const observedAt = text(conditions, "observedAt");
  const accountTier = text(conditions, "accountTier");
  const regions = whenAny(texts(conditions, "regions"));
  const untestedAxes = whenAny(texts(conditions, "untestedAxes"));
  const where = [accountTier ? `${accountTier}-tier` : undefined, regions?.join(", ")]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const when = observedAt !== undefined ? monthOf(observedAt) : undefined;
  const caveat =
    where.length > 0 || when !== undefined
      ? `Observed on ${where.length > 0 ? where : "an unrecorded setup"}${
          when !== undefined ? ` in ${when}` : ""
        }${untestedAxes !== undefined ? ` — never varied by ${untestedAxes.join(", ")}` : ""}. Yours may differ.`
      : undefined;
  return {
    observedAt,
    accountTier,
    regions,
    consoleVersion: text(conditions, "consoleVersion"),
    apiVersion: text(conditions, "apiVersion"),
    observedAcrossDeployments: count(conditions, "observedAcrossDeployments"),
    untestedAxes,
    caveat,
  };
}

function monthOf(iso: string): string | undefined {
  const parsed = new Date(iso);
  const month = MONTHS[parsed.getUTCMonth()];
  return Number.isNaN(parsed.getTime()) || month === undefined
    ? undefined
    : `${month} ${parsed.getUTCFullYear()}`;
}

function describeAuthor(source: unknown): string | undefined {
  const author = object(source);
  if (author === undefined) {
    return undefined;
  }
  const model = text(author, "model");
  return (
    text(author, "displayName") ??
    (text(author, "provider") !== undefined
      ? `${text(author, "provider")}${model !== undefined ? ` (${model})` : ""}`
      : undefined)
  );
}

function describeAttribution(source: unknown): string | undefined {
  const kind = text(source, "kind");
  if (kind === undefined) {
    return undefined;
  }
  const named = text(source, "service") ?? text(source, "name");
  return named !== undefined ? `${kind}: ${named}` : kind;
}

function readFailureMode(source: unknown): PackFailureModeView {
  const resolution = at(source, "resolution");
  const detection = object(at(source, "detection"));
  return {
    id: text(source, "id"),
    symptom: text(source, "symptom"),
    trigger: text(source, "trigger"),
    triggerKinds: whenAny(texts(source, "triggerKinds")),
    severity: text(source, "severity"),
    silent: flag(source, "silent"),
    attributedTo: describeAttribution(at(source, "attributedTo")),
    resolution: text(resolution, "kind"),
    resolutionDetail:
      text(resolution, "change") ??
      text(resolution, "workaround") ??
      text(resolution, "currentAdvice") ??
      text(resolution, "waitingOn"),
    fixedIn: text(resolution, "inVersion"),
    detection:
      detection === undefined
        ? undefined
        : { signal: text(detection, "signal"), match: text(detection, "match") },
    deploymentsAffected: count(source, "deploymentsAffected"),
    firstSeenAt: text(source, "firstSeenAt"),
    lastSeenAt: text(source, "lastSeenAt"),
    conditions: readConditions(at(source, "conditions")),
    introducedIn: text(source, "origin", "introducedIn"),
    source: text(source, "origin", "source", "kind"),
  };
}

function readIntegrationKnowledge(source: unknown): PackIntegrationKnowledgeView {
  const detail = at(source, "detail");
  const standing = object(at(source, "standing"));
  const navigation = items(detail, "navigation").map((step) => ({
    action: text(step, "action"),
    url: text(step, "url"),
    expect: text(step, "expect"),
  }));
  const scopes = items(detail, "scopes").map((scope) => ({
    name: text(scope, "name"),
    purpose: text(scope, "purpose"),
    required: flag(scope, "required"),
  }));
  const decisions = items(detail, "decisions").map((decision) => ({
    subject: text(decision, "subject"),
    latitude: text(decision, "latitude"),
    reason: text(decision, "reason"),
    failureModeId: text(decision, "failureModeId"),
    path: text(decision, "path"),
  }));
  return {
    id: text(source, "id"),
    title: text(source, "title"),
    kind: text(detail, "kind"),
    conditions: readConditions(at(source, "conditions")),
    standing:
      standing === undefined
        ? undefined
        : {
            state: text(standing, "state"),
            confirmedInInstalls: count(standing, "confirmedInInstalls"),
            contradictedInInstalls: count(standing, "contradictedInInstalls"),
            lastConfirmedAt: text(standing, "lastConfirmedAt"),
          },
    commonMistake: text(source, "commonMistake"),
    preventsFailureModeIds: whenAny(texts(source, "preventsFailureModeIds")),
    environmentVariable: text(detail, "environmentVariable"),
    service: text(detail, "service"),
    credentialKind: text(detail, "credentialKind"),
    consoleUrl: text(detail, "consoleUrl"),
    navigation: whenAny(navigation),
    scopes: whenAny(scopes),
    rotation: text(detail, "rotation"),
    prompt: text(detail, "prompt"),
    touches: whenAny(texts(detail, "touches")),
    rule: text(detail, "rule"),
    rationale: text(detail, "rationale"),
    example: text(detail, "example"),
    decisions: whenAny(decisions),
  };
}

function readSetup(manifest: unknown): PackSetupView {
  const setupSteps = items(manifest, "requirements", "setupSteps");
  return {
    environment: items(manifest, "requirements", "environment").map((entry) => ({
      name: text(entry, "name"),
      purpose: text(entry, "purpose"),
      secret: flag(entry, "secret"),
      required: flag(entry, "required"),
      obtainUrl: text(entry, "obtainUrl"),
      example: text(entry, "example"),
      pattern: text(entry, "pattern"),
    })),
    accounts: items(manifest, "requirements", "accounts").map((entry) => ({
      service: text(entry, "service"),
      displayName: text(entry, "displayName"),
      purpose: text(entry, "purpose"),
      signupUrl: text(entry, "signupUrl"),
      requiredScopes: whenAny(texts(entry, "requiredScopes")),
      costsMoney: flag(entry, "costsMoney"),
    })),
    services: items(manifest, "requirements", "services").map((entry) => ({
      kind: text(entry, "kind"),
      name: text(entry, "name"),
      versionRange: text(entry, "versionRange"),
    })),
    toolchain: items(manifest, "requirements", "toolchain").map((entry) => ({
      name: text(entry, "name"),
      versionRange: text(entry, "versionRange"),
    })),
    dependsOnPacks: items(manifest, "requirements", "packs")
      .map((entry) => text(entry, "name"))
      .filter((name): name is string => name !== undefined),
    setupSteps: setupSteps.length,
    manualSteps: setupSteps.filter((step) => flag(step, "manual") === true).length,
    preflightCommand: text(manifest, "requirements", "preflightCommand"),
  };
}

function readSignals(manifest: unknown): PackSignalsView {
  const record = at(manifest, "verification", "record");
  const survival = object(at(record, "survival"));
  return {
    measuredAt: text(record, "measuredAt"),
    installsAttempted: count(record, "installsAttempted"),
    installsSucceeded: count(record, "installsSucceeded"),
    deploymentsAttempted: count(record, "deploymentsAttempted"),
    deploymentsSurviving: count(record, "deploymentsSurviving"),
    cumulativeServiceDays: count(record, "cumulativeServiceDays"),
    longestServiceDays: count(record, "longestServiceDays"),
    firstDeployedAt: text(record, "firstDeployedAt"),
    breakagesCaught: count(record, "breakagesCaught"),
    breakagesFixed: count(record, "breakagesFixed"),
    knowledgeContradictions: count(record, "knowledgeContradictions"),
    survival:
      survival === undefined
        ? undefined
        : {
            cohortSize: count(survival, "cohortSize"),
            aliveAtDay30: count(survival, "aliveAtDay30"),
            aliveAtDay60: count(survival, "aliveAtDay60"),
            aliveAtDay90: count(survival, "aliveAtDay90"),
          },
    checks: items(manifest, "verification", "checks").map((check) => ({
      id: text(check, "id"),
      title: text(check, "title"),
      runsOn: whenAny(texts(check, "runsOn")),
      guardsFailureModeId: text(check, "guardsFailureModeId"),
      runs: count(check, "runs"),
      passes: count(check, "passes"),
      deploymentsCovered: count(check, "deploymentsCovered"),
      lastRunAt: text(check, "lastRunAt"),
      lastOutcome: text(check, "lastOutcome"),
    })),
    attestations: items(manifest, "verification", "attestations").map((attestation) => ({
      attestedAt: text(attestation, "attestedAt"),
      attestedBy: describeAuthor(at(attestation, "attestedBy")),
      did: whenAny(texts(attestation, "did")),
      conditions: readConditions(at(attestation, "conditions")),
    })),
    advisories: items(manifest, "verification", "advisories").map((advisory) => ({
      id: text(advisory, "id"),
      severity: text(advisory, "severity"),
      reason: text(advisory, "reason"),
      issuedAt: text(advisory, "issuedAt"),
      failureModeId: text(advisory, "failureModeId"),
    })),
  };
}

export function readRef(manifest: PackManifest): PackRefView {
  const name = text(manifest, "identity", "name") ?? "unnamed";
  const version = text(manifest, "identity", "version");
  const publisher = text(manifest, "identity", "publisher", "handle");
  return {
    id: text(manifest, "identity", "id"),
    name,
    version,
    publisher,
    qualified: `${publisher !== undefined ? `${publisher}/` : ""}${name}${
      version !== undefined ? `@${version}` : ""
    }`,
  };
}

/** Failure modes with a fix or a workaround behind them, worst first. */
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function bySeverity(left: PackFailureModeView, right: PackFailureModeView): number {
  const rank = (entry: PackFailureModeView): number => {
    const index = SEVERITY_ORDER.indexOf(entry.severity ?? "");
    return index === -1 ? SEVERITY_ORDER.length : index;
  };
  const difference = rank(left) - rank(right);
  return difference !== 0
    ? difference
    : (right.deploymentsAffected ?? 0) - (left.deploymentsAffected ?? 0);
}

export function readCard(manifest: PackManifest): PackCardView {
  const failureModes = items(manifest, "knowledge", "failureModes").map(readFailureMode);
  const integration = items(manifest, "knowledge", "integration").map(readIntegrationKnowledge);
  const open = failureModes.filter((entry) => entry.resolution === "open").toSorted(bySeverity);
  const handled = failureModes.filter((entry) => entry.resolution !== "open").toSorted(bySeverity);
  const observedDates = [...failureModes, ...integration]
    .map((entry) => entry.conditions?.observedAt)
    .filter((observedAt): observedAt is string => observedAt !== undefined)
    .toSorted();

  return {
    ref: readRef(manifest),
    displayName: text(manifest, "identity", "displayName"),
    summary: text(manifest, "identity", "summary"),
    does: text(manifest, "capability", "does"),
    categories: whenAny(texts(manifest, "identity", "categories")),
    tags: whenAny(texts(manifest, "identity", "tags")),
    nonGoals: whenAny(texts(manifest, "capability", "nonGoals")),
    interfaceKinds: items(manifest, "interfaces")
      .map((entry) => text(entry, "kind"))
      .filter((kind): kind is string => kind !== undefined),
    license: text(manifest, "identity", "license"),
    visibility: text(manifest, "visibility", "scope"),
    setup: readSetup(manifest),
    signals: readSignals(manifest),
    handles: handled,
    openFailureModes: open,
    knowledge: {
      failureModes: failureModes.length,
      openFailureModes: open.length,
      integrationEntries: integration.length,
      credentialGuides: integration.filter((entry) => entry.kind === "credential-retrieval").length,
      oldestObservedAt: observedDates[0],
      contradicted: integration.filter(
        (entry) =>
          (entry.standing?.contradictedInInstalls ?? 0) >
          (entry.standing?.confirmedInInstalls ?? 0),
      ).length,
    },
    installCommand: text(manifest, "integration", "installCommand"),
  };
}

export function readDetail(manifest: PackManifest): PackDetailView {
  const commands: Record<string, string> = {};
  const declared = object(at(manifest, "runtime", "commands")) ?? {};
  for (const name of Object.keys(declared)) {
    const command = text(declared, name, "command");
    if (command !== undefined) {
      commands[name] = command;
    }
  }

  return {
    ...readCard(manifest),
    description: text(manifest, "identity", "description"),
    useCases: whenAny(texts(manifest, "capability", "useCases")),
    integrationKnowledge: items(manifest, "knowledge", "integration").map(readIntegrationKnowledge),
    interfaces: items(manifest, "interfaces").map((entry) => ({
      kind: text(entry, "kind"),
      id: text(entry, "id"),
      title: text(entry, "title"),
      serviceId: text(entry, "serviceId"),
      operations: whenAny(
        items(entry, "operations")
          .map((operation) => text(operation, "operationId"))
          .filter((operationId): operationId is string => operationId !== undefined),
      ),
    })),
    runtime: {
      target: text(manifest, "runtime", "target"),
      versionRange: text(manifest, "runtime", "versionRange"),
      commands,
      services: items(manifest, "runtime", "services").map((service) => ({
        id: text(service, "id"),
        protocol: text(service, "protocol"),
        exposure: text(service, "exposure"),
      })),
    },
    permissions: {
      network: items(manifest, "permissions", "network").map((entry) => ({
        host: text(entry, "host"),
        purpose: text(entry, "purpose"),
        dataClasses: whenAny(texts(entry, "dataClasses")),
      })),
      filesystem: items(manifest, "permissions", "filesystem").map((entry) => ({
        root: text(entry, "root"),
        path: text(entry, "path"),
        access: text(entry, "access"),
      })),
      secrets: items(manifest, "permissions", "secrets")
        .map((entry) => text(entry, "name"))
        .filter((name): name is string => name !== undefined),
      elevated: items(manifest, "permissions", "elevated").map((entry) => ({
        capability: text(entry, "capability"),
        justification: text(entry, "justification"),
      })),
    },
    integration: {
      prompt: text(manifest, "integration", "prompt"),
      installCommand: text(manifest, "integration", "installCommand"),
      variants: whenAny(
        items(manifest, "integration", "variants").map((variant) => ({
          target: text(variant, "target"),
          prompt: text(variant, "prompt"),
        })),
      ),
      snippets: whenAny(
        items(manifest, "integration", "snippets").map((snippet) => ({
          title: text(snippet, "title"),
          language: text(snippet, "language"),
          code: text(snippet, "code"),
        })),
      ),
      followUpQuestions: whenAny(texts(manifest, "integration", "followUpQuestions")),
    },
    provenance: {
      extractedAt: text(manifest, "provenance", "extractedAt"),
      extractedBy: describeAuthor(at(manifest, "provenance", "extractedBy")),
      handoverSummary: text(manifest, "provenance", "handover", "summary"),
      handoverPath: text(manifest, "provenance", "handover", "path"),
      workspaceKeyId: text(manifest, "provenance", "workspace", "workspaceKeyId"),
      derivedFrom: text(manifest, "provenance", "derivedFrom", "name"),
    },
  };
}

// ── What the readiness rules need that is not on a card ─────────────────────

export interface PackReadinessFacts {
  readonly handoverSummary: string | undefined;
  readonly startCommand: string | undefined;
  readonly interfaceKinds: ReadonlyArray<string>;
  readonly interfaceServiceIds: ReadonlyArray<string>;
  readonly runtimeServiceIds: ReadonlyArray<string>;
  readonly operationIds: ReadonlyArray<string>;
  readonly meteredOperationIds: ReadonlyArray<string>;
  readonly integrationPrompt: string | undefined;
  readonly declaredEnvironment: ReadonlyArray<string>;
  readonly environmentExamples: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly elevatedWithoutJustification: number;
  readonly failureModeIds: ReadonlyArray<string>;
  readonly checkIds: ReadonlyArray<string>;
  /** Every id a knowledge entry points at, with where it was pointed from. */
  readonly knowledgeReferences: ReadonlyArray<{
    readonly path: string;
    readonly kind: "failure-mode" | "check";
    readonly id: string;
  }>;
  readonly credentialVariables: ReadonlyArray<{ readonly path: string; readonly name: string }>;
  readonly frozenDecisionsWithoutCause: ReadonlyArray<string>;
  readonly hasContents: boolean;
  readonly hasSignature: boolean;
}

export function readReadinessFacts(manifest: PackManifest): PackReadinessFacts {
  const interfaces = items(manifest, "interfaces");
  const failureModes = items(manifest, "knowledge", "failureModes");
  const integration = items(manifest, "knowledge", "integration");
  const checks = items(manifest, "verification", "checks");

  const knowledgeReferences: Array<{
    readonly path: string;
    readonly kind: "failure-mode" | "check";
    readonly id: string;
  }> = [];
  const frozenDecisionsWithoutCause: Array<string> = [];
  const credentialVariables: Array<{ readonly path: string; readonly name: string }> = [];

  failureModes.forEach((entry, index) => {
    const path = `${MANIFEST_PATHS.failureModes}[${index}]`;
    for (const id of [text(entry, "detection", "checkId"), text(entry, "resolution", "checkId")]) {
      if (id !== undefined) {
        knowledgeReferences.push({ path, kind: "check", id });
      }
    }
  });

  integration.forEach((entry, index) => {
    const path = `${MANIFEST_PATHS.integrationKnowledge}[${index}]`;
    for (const id of texts(entry, "preventsFailureModeIds")) {
      knowledgeReferences.push({ path, kind: "failure-mode", id });
    }
    const environmentVariable = text(entry, "detail", "environmentVariable");
    if (environmentVariable !== undefined) {
      credentialVariables.push({ path, name: environmentVariable });
    }
    for (const decision of items(entry, "detail", "decisions")) {
      const failureModeId = text(decision, "failureModeId");
      if (failureModeId !== undefined) {
        knowledgeReferences.push({ path, kind: "failure-mode", id: failureModeId });
      }
      if (
        text(decision, "latitude") === "frozen" &&
        failureModeId === undefined &&
        (text(decision, "reason")?.length ?? 0) < 40
      ) {
        frozenDecisionsWithoutCause.push(text(decision, "subject") ?? path);
      }
    }
  });

  for (const check of checks) {
    const guards = text(check, "guardsFailureModeId");
    if (guards !== undefined) {
      knowledgeReferences.push({ path: MANIFEST_PATHS.checks, kind: "failure-mode", id: guards });
    }
  }

  return {
    handoverSummary: text(manifest, "provenance", "handover", "summary"),
    startCommand: text(manifest, "runtime", "commands", "start", "command"),
    interfaceKinds: interfaces
      .map((entry) => text(entry, "kind"))
      .filter((kind): kind is string => kind !== undefined),
    interfaceServiceIds: interfaces
      .map((entry) => text(entry, "serviceId"))
      .filter((serviceId): serviceId is string => serviceId !== undefined),
    runtimeServiceIds: items(manifest, "runtime", "services")
      .map((entry) => text(entry, "id"))
      .filter((id): id is string => id !== undefined),
    operationIds: interfaces.flatMap((entry) =>
      items(entry, "operations")
        .map((operation) => text(operation, "operationId"))
        .filter((operationId): operationId is string => operationId !== undefined),
    ),
    meteredOperationIds: texts(manifest, "analytics", "meteredOperations"),
    integrationPrompt: text(manifest, "integration", "prompt"),
    declaredEnvironment: items(manifest, "requirements", "environment")
      .map((entry) => text(entry, "name"))
      .filter((name): name is string => name !== undefined),
    environmentExamples: items(manifest, "requirements", "environment").flatMap((entry) => {
      const name = text(entry, "name");
      const values = [text(entry, "example"), text(entry, "defaultValue")].filter(
        (value): value is string => value !== undefined,
      );
      return name === undefined ? [] : values.map((value) => ({ name, value }));
    }),
    elevatedWithoutJustification: items(manifest, "permissions", "elevated").filter(
      (entry) => text(entry, "justification") === undefined,
    ).length,
    failureModeIds: failureModes
      .map((entry) => text(entry, "id"))
      .filter((id): id is string => id !== undefined),
    checkIds: checks
      .map((entry) => text(entry, "id"))
      .filter((id): id is string => id !== undefined),
    knowledgeReferences,
    credentialVariables,
    frozenDecisionsWithoutCause,
    hasContents: object(at(manifest, "contents")) !== undefined,
    hasSignature: object(at(manifest, "signature")) !== undefined,
  };
}

// ── Writers ─────────────────────────────────────────────────────────────────

export interface StarterManifestInput {
  readonly name: string;
  readonly displayName: string;
  readonly summary: string;
  readonly does: string;
  readonly publisher: string;
  readonly license: string;
  readonly target: string;
  readonly version: string;
  readonly packId: string;
  readonly workspaceKeyId: string;
  readonly now: string;
}

/**
 * The honest minimum: an empty `knowledge` and a zeroed scar record, which is
 * the correct thing for a pack to say on the day it is cut. Nothing here
 * pretends the pack has run anywhere.
 */
export function buildStarterManifest(input: StarterManifestInput): Record<string, unknown> {
  return {
    formatVersion: FORMAT_VERSION,
    identity: {
      id: input.packId,
      name: input.name,
      version: input.version,
      displayName: input.displayName,
      summary: input.summary,
      publisher: { type: "user", handle: input.publisher, displayName: input.publisher },
      license: input.license,
      tags: [],
    },
    provenance: {
      workspace: { workspaceKeyId: input.workspaceKeyId },
      extractedAt: input.now,
      extractedBy: { type: "user", displayName: input.publisher },
      // Placeholders short enough that the readiness rules flag them, so
      // `validate` names the three things the author still has to write rather
      // than passing a scaffold as finished work.
      handover: { path: HANDOVER_FILENAME, summary: "TODO: write this.", generatedAt: input.now },
    },
    capability: { does: input.does },
    knowledge: {},
    requirements: {},
    interfaces: [
      {
        kind: "library",
        id: input.name,
        title: input.displayName,
        language: "typescript",
        exports: [
          {
            name: "install",
            kind: "function",
            summary: "Replace with what this pack actually exports.",
          },
        ],
      },
    ],
    runtime: { target: input.target, commands: {} },
    permissions: {},
    verification: {
      record: {
        measuredAt: input.now,
        installsAttempted: 0,
        installsSucceeded: 0,
        deploymentsAttempted: 0,
        deploymentsSurviving: 0,
        cumulativeServiceDays: 0,
        breakagesCaught: 0,
        breakagesFixed: 0,
      },
    },
    visibility: { scope: "workspace", workspaceKeyId: input.workspaceKeyId },
    integration: { prompt: "TODO: write the integration prompt." },
  };
}

/**
 * Rewrites the version on the parsed JSON rather than on a decoded manifest, so
 * a bump never silently drops a field this CLI does not know about yet.
 */
export function setManifestVersion(raw: unknown, version: string): unknown {
  const manifest = object(raw);
  const identity = object(manifest?.["identity"]);
  if (manifest === undefined || identity === undefined) {
    return raw;
  }
  return { ...manifest, identity: { ...identity, version } };
}

/**
 * Forces a release private on its way into a registry. Cutting a pack and
 * listing it for other people are two decisions, and a manifest that arrives
 * claiming to be public does not get to make the second one on its author's
 * behalf.
 */
export function setManifestVisibilityPrivate(raw: unknown): {
  readonly raw: unknown;
  readonly claimedScope: string | undefined;
  readonly scope: string;
} {
  const manifest = object(raw);
  const claimedScope = text(manifest, "visibility", "scope");
  const workspaceKeyId =
    text(manifest, "visibility", "workspaceKeyId") ??
    text(manifest, "provenance", "workspace", "workspaceKeyId");
  if (manifest === undefined || workspaceKeyId === undefined) {
    return { raw, claimedScope, scope: claimedScope ?? "unknown" };
  }
  return {
    raw: { ...manifest, visibility: { scope: "workspace", workspaceKeyId } },
    claimedScope,
    scope: "workspace",
  };
}

export function readVersionFromRaw(raw: unknown): string | undefined {
  return text(raw, "identity", "version");
}

export function readNameFromRaw(raw: unknown): string | undefined {
  return text(raw, "identity", "name");
}

export type { PackManifest };
