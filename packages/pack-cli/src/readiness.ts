/**
 * Valid and publishable are two different questions.
 *
 * The schema stays permissive so a half-finished pack still opens — tooling has
 * to be able to load a pack in order to say what is missing from it. The rules
 * below are the second tier: cross-field checks that a well-formed manifest can
 * still break. Errors block a publish; warnings never do, because a pack has to
 * be publishable before it can earn anything.
 *
 * Codes mirror the registry's readiness vocabulary but are spelled locally, so
 * a change to that union shows up here as a decision rather than as a build
 * failure in a package that only reports.
 *
 * @module readiness
 */
import { MANIFEST_PATHS, type PackCardView, type PackReadinessFacts } from "./manifest.ts";

const STALE_AFTER_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_HANDOVER_LENGTH = 20;
const MIN_INTEGRATION_PROMPT_LENGTH = 40;

export type ReadinessCode =
  | "handover-empty"
  | "start-command-missing"
  | "integration-prompt-thin"
  | "interface-service-unknown"
  | "analytics-operation-unknown"
  | "secret-value-in-manifest"
  | "elevated-capability-unjustified"
  | "knowledge-reference-unknown"
  | "credential-knowledge-unlinked"
  | "customisation-boundary-unexplained"
  | "knowledge-absent"
  | "verification-record-unmeasured"
  | "knowledge-conditions-stale"
  | "knowledge-contradicted"
  | "failure-mode-open-critical"
  | "check-never-run"
  | "advisory-open"
  | "interface-scaffold-unfilled"
  | "contents-digest-missing"
  | "signature-missing";

export interface ReadinessIssue {
  readonly code: ReadinessCode;
  readonly severity: "error" | "warning";
  /** Dotted path into the manifest, so an editor can jump straight to it. */
  readonly path: string;
  readonly message: string;
}

export interface ReadinessReport {
  readonly publishable: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly issues: ReadonlyArray<ReadinessIssue>;
}

/**
 * Shapes a live credential takes. Checked against declared examples because an
 * example is the one field an author fills in by pasting from a console.
 */
const LIVE_CREDENTIAL_PATTERNS = [
  /\b[sr]k_live_[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function looksLikeSecret(value: string): boolean {
  return LIVE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function daysSince(iso: string, now: Date): number {
  const observed = new Date(iso).getTime();
  return Number.isNaN(observed) ? 0 : Math.floor((now.getTime() - observed) / DAY_MS);
}

export function assessReadiness(input: {
  readonly card: PackCardView;
  readonly facts: PackReadinessFacts;
  readonly now: Date;
}): ReadinessReport {
  const { card, facts, now } = input;
  const issues: Array<ReadinessIssue> = [];
  const error = (code: ReadinessCode, path: string, message: string): void => {
    issues.push({ code, severity: "error", path, message });
  };
  const warn = (code: ReadinessCode, path: string, message: string): void => {
    issues.push({ code, severity: "warning", path, message });
  };

  if ((facts.handoverSummary?.length ?? 0) < MIN_HANDOVER_LENGTH) {
    error(
      "handover-empty",
      MANIFEST_PATHS.handoverSummary,
      "A pack whose author cannot say what they built, what they tried and what they left undone is a zip file with metadata.",
    );
  }

  const needsStart = facts.interfaceKinds.some((kind) => kind !== "library");
  if (needsStart && facts.startCommand === undefined) {
    error(
      "start-command-missing",
      MANIFEST_PATHS.startCommand,
      "Every interface except a library has to be started by something, and no start command is declared.",
    );
  }

  if ((facts.integrationPrompt?.length ?? 0) < MIN_INTEGRATION_PROMPT_LENGTH) {
    error(
      "integration-prompt-thin",
      MANIFEST_PATHS.integrationPrompt,
      "The integration prompt is what another agent pastes to start using this pack; it has to be actionable on its own.",
    );
  }

  for (const interfaceId of facts.scaffoldInterfaceIds) {
    warn(
      "interface-scaffold-unfilled",
      MANIFEST_PATHS.interfaces,
      `Interface "${interfaceId}" still carries the summary the scaffold wrote, so this pack claims an export it does not have. Describe the real interface, or drop it — a pack that exports nothing may declare none.`,
    );
  }

  for (const serviceId of facts.interfaceServiceIds) {
    if (!facts.runtimeServiceIds.includes(serviceId)) {
      error(
        "interface-service-unknown",
        MANIFEST_PATHS.interfaces,
        `An interface is hosted by service "${serviceId}", which the runtime does not declare.`,
      );
    }
  }

  for (const operationId of facts.meteredOperationIds) {
    if (!facts.operationIds.includes(operationId)) {
      error(
        "analytics-operation-unknown",
        MANIFEST_PATHS.analyticsMetered,
        `Analytics meters operation "${operationId}", which no interface declares.`,
      );
    }
  }

  for (const example of facts.environmentExamples) {
    if (looksLikeSecret(example.value)) {
      error(
        "secret-value-in-manifest",
        MANIFEST_PATHS.environment,
        `The example for ${example.name} looks like a live credential rather than a shape.`,
      );
    }
  }

  if (facts.elevatedWithoutJustification > 0) {
    error(
      "elevated-capability-unjustified",
      MANIFEST_PATHS.elevated,
      `${facts.elevatedWithoutJustification} elevated capability request(s) carry no justification, and these are exactly the requests a human should read before approving.`,
    );
  }

  for (const reference of facts.knowledgeReferences) {
    const known =
      reference.kind === "failure-mode"
        ? facts.failureModeIds.includes(reference.id)
        : facts.checkIds.includes(reference.id);
    if (!known) {
      error(
        "knowledge-reference-unknown",
        reference.path,
        `Points at ${reference.kind} "${reference.id}", which nothing in this manifest declares.`,
      );
    }
  }

  for (const credential of facts.credentialVariables) {
    if (!facts.declaredEnvironment.includes(credential.name)) {
      error(
        "credential-knowledge-unlinked",
        credential.path,
        `Explains how to obtain ${credential.name}, which requirements.environment does not declare.`,
      );
    }
  }

  for (const subject of facts.frozenDecisionsWithoutCause) {
    warn(
      "customisation-boundary-unexplained",
      MANIFEST_PATHS.integrationKnowledge,
      `"${subject}" is frozen with neither a failure mode nor a reason that survives reading; an agent with a good reason of its own will change it anyway.`,
    );
  }

  if (card.knowledge.failureModes + card.knowledge.integrationEntries === 0) {
    warn(
      "knowledge-absent",
      MANIFEST_PATHS.knowledge,
      "Nothing has been learned behind this pack yet. That is the difference between a proven capability and a template.",
    );
  }

  if (
    (card.signals.installsAttempted ?? 0) === 0 &&
    (card.signals.deploymentsAttempted ?? 0) === 0
  ) {
    warn(
      "verification-record-unmeasured",
      MANIFEST_PATHS.verificationRecord,
      "The scar record is empty: this pack has never been installed or deployed.",
    );
  }

  const oldest = card.knowledge.oldestObservedAt;
  if (oldest !== undefined && daysSince(oldest, now) > STALE_AFTER_DAYS) {
    warn(
      "knowledge-conditions-stale",
      MANIFEST_PATHS.knowledge,
      `The oldest knowledge here was observed ${daysSince(oldest, now)} days ago; a console path rots long before an idempotency pattern does.`,
    );
  }

  if (card.knowledge.contradicted > 0) {
    warn(
      "knowledge-contradicted",
      MANIFEST_PATHS.integrationKnowledge,
      `${card.knowledge.contradicted} entry(ies) have been contradicted by installs more often than confirmed.`,
    );
  }

  for (const failureMode of card.openFailureModes) {
    if (failureMode.severity === "critical") {
      warn(
        "failure-mode-open-critical",
        MANIFEST_PATHS.failureModes,
        `"${failureMode.id ?? "unnamed"}" is critical and still open.`,
      );
    }
  }

  for (const check of card.signals.checks) {
    if ((check.runs ?? 0) === 0) {
      warn(
        "check-never-run",
        MANIFEST_PATHS.checks,
        `Check "${check.id ?? "unnamed"}" has never run, so it is ceremony rather than evidence.`,
      );
    }
  }

  for (const advisory of card.signals.advisories) {
    warn(
      "advisory-open",
      MANIFEST_PATHS.advisories,
      `Advisory "${advisory.id ?? "unnamed"}" (${advisory.severity ?? "unknown"}) is on this pack.`,
    );
  }

  if (!facts.hasContents) {
    warn(
      "contents-digest-missing",
      MANIFEST_PATHS.contents,
      "No content digests, so an extractor cannot verify what it got before running it.",
    );
  }

  if (!facts.hasSignature) {
    warn(
      "signature-missing",
      MANIFEST_PATHS.signature,
      "Unsigned, so nothing proves this release came from the publisher it names.",
    );
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    publishable: errors === 0,
    errors,
    warnings: issues.length - errors,
    issues,
  };
}
