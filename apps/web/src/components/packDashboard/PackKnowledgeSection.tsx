import { AlertTriangleIcon, EyeOffIcon } from "lucide-react";
import type {
  PackConditions,
  PackFailureMode,
  PackIntegrationKnowledge,
  PackKnowledge,
  PackKnowledgeOrigin,
} from "@t3tools/contracts";

import {
  describeConditions,
  describeFailureStanding,
  describeStaleness,
  formatObservedDate,
  orderFailureModes,
} from "./packDetail.logic";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

const SEVERITY_TONE = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "outline",
} as const;

const LATITUDE_TONE = {
  "safe-to-change": "success",
  "change-with-care": "warning",
  frozen: "error",
} as const;

function describeOrigin(origin: PackKnowledgeOrigin): string {
  const source = origin.source;
  const who =
    source.kind === "maintenance-agent"
      ? "the maintenance agent"
      : source.kind === "deployment-telemetry"
        ? "deployment telemetry"
        : source.kind === "install-report"
          ? `an install${source.target === undefined ? "" : ` into ${source.target}`}`
          : source.kind === "human-report"
            ? "a person who hit it"
            : `${source.packName}@${source.packVersion}, which this depends on`;
  return `Written by ${who}, and carried since ${origin.introducedIn}.`;
}

/**
 * The conditions block, rendered under every claim rather than once per pack.
 * The second line is the load-bearing one: an agent that can say "yours may
 * differ" turns a trust-destroying failure into a mild caveat, and an agent
 * that cannot just asserts.
 */
function Conditions({ conditions }: { conditions: PackConditions }) {
  const description = describeConditions(conditions);
  const staleness = describeStaleness(conditions);
  return (
    <div
      className="mt-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground"
      data-testid="pack-detail-conditions"
    >
      <div>{description.observed}</div>
      <div className="mt-0.5 text-foreground/80">{description.untested}</div>
      <div
        className={cn("mt-0.5", staleness.state === "stale" && "text-destructive-foreground")}
        data-testid="pack-detail-staleness"
        data-state={staleness.state}
      >
        {staleness.line}
      </div>
    </div>
  );
}

function IntegrationEntry({ entry }: { entry: PackIntegrationKnowledge }) {
  const detail = entry.detail;

  return (
    <div
      className="rounded-md border border-border p-3"
      data-testid="pack-detail-integration-knowledge"
      data-entry-id={entry.id}
    >
      <div className="text-xs font-medium text-foreground">{entry.title}</div>

      {detail.kind === "credential-retrieval" ? (
        <div className="mt-2">
          <div className="font-mono text-[11px] text-muted-foreground">
            {detail.environmentVariable} · {detail.service}
            {detail.credentialKind === undefined ? "" : ` · ${detail.credentialKind}`}
          </div>
          <ol className="mt-1.5 grid gap-1.5">
            {detail.navigation.map((step, index) => (
              <li key={step.action} className="text-xs leading-5">
                <span className="text-foreground">
                  {index + 1}. {step.action}
                </span>
                {step.expect !== undefined ? (
                  <div className="text-muted-foreground">You should see: {step.expect}</div>
                ) : null}
              </li>
            ))}
          </ol>
          {detail.scopes !== undefined && detail.scopes.length > 0 ? (
            <div className="mt-2 grid gap-0.5">
              {detail.scopes.map((scope) => (
                <div key={scope.name} className="text-xs leading-5">
                  <span className="font-mono text-foreground">{scope.name}</span>{" "}
                  <span className="text-muted-foreground">
                    — {scope.purpose} {scope.required ? "" : "(optional)"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {detail.rotation !== undefined ? (
            <div className="mt-2 text-xs leading-5 text-muted-foreground">
              When it expires: {detail.rotation}
            </div>
          ) : null}
        </div>
      ) : null}

      {detail.kind === "wiring" ? (
        <div className="mt-2">
          <div className="text-xs leading-5 text-muted-foreground">{detail.prompt}</div>
          {detail.touches !== undefined && detail.touches.length > 0 ? (
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              touches {detail.touches.join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {detail.kind === "pattern" ? (
        <div className="mt-2">
          <div className="text-xs leading-5 text-foreground">{detail.rule}</div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Why: {detail.rationale}
          </div>
          {detail.example !== undefined ? (
            <code className="mt-1 block overflow-x-auto rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground">
              {detail.example}
            </code>
          ) : null}
        </div>
      ) : null}

      {detail.kind === "boundary" ? (
        <div className="mt-2 grid gap-1.5">
          {detail.decisions.map((decision) => (
            <div key={decision.subject} className="text-xs leading-5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge size="sm" variant={LATITUDE_TONE[decision.latitude]}>
                  {decision.latitude.replaceAll("-", " ")}
                </Badge>
                <span className="text-foreground">{decision.subject}</span>
              </div>
              <div className="text-muted-foreground">{decision.reason}</div>
              {decision.path !== undefined ? (
                <div className="font-mono text-[11px] text-muted-foreground">{decision.path}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {entry.commonMistake !== undefined ? (
        <div
          className="mt-2 rounded-md border border-border p-2 text-xs leading-5"
          data-testid="pack-detail-common-mistake"
        >
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground" />
            What an agent says instead when it guesses
          </div>
          <div className="mt-0.5 text-muted-foreground">{entry.commonMistake}</div>
        </div>
      ) : null}

      {entry.standing !== undefined ? (
        <div
          className="mt-2 text-[11px] leading-4 text-muted-foreground"
          data-testid="pack-detail-standing"
        >
          Confirmed in {entry.standing.confirmedInInstalls} installs, contradicted in{" "}
          {entry.standing.contradictedInInstalls}
          {entry.standing.state === "superseded"
            ? ". Superseded — kept because an older console may still match it."
            : entry.standing.state === "doubtful"
              ? ". The field has started disagreeing with this."
              : "."}
        </div>
      ) : null}

      <Conditions conditions={entry.conditions} />
      <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
        {describeOrigin(entry.origin)}
      </div>
    </div>
  );
}

function FailureModeEntry({ failureMode }: { failureMode: PackFailureMode }) {
  const resolution = failureMode.resolution;

  return (
    <div
      className="rounded-md border border-border p-3"
      data-testid="pack-detail-failure-mode"
      data-failure-mode-id={failureMode.id}
      data-resolution={resolution.kind}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant={SEVERITY_TONE[failureMode.severity]}>
          {failureMode.severity}
        </Badge>
        {resolution.kind === "fixed" ? (
          <Badge size="sm" variant="outline">
            fixed in {resolution.inVersion}
          </Badge>
        ) : (
          <Badge size="sm" variant="warning">
            {resolution.kind}
          </Badge>
        )}
        {failureMode.silent === true ? (
          <Badge size="sm" variant="outline">
            <EyeOffIcon />
            nothing reports it
          </Badge>
        ) : null}
      </div>

      <div className="mt-1.5 text-xs font-medium leading-5 text-foreground">
        {failureMode.symptom}
      </div>
      <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{failureMode.trigger}</div>

      <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {resolution.kind === "fixed"
          ? `Fixed in ${resolution.inVersion}: ${resolution.change}`
          : resolution.kind === "mitigated"
            ? `Worked around: ${resolution.workaround}`
            : resolution.kind === "upstream"
              ? `Waiting on ${resolution.waitingOn}.${
                  resolution.workaround === undefined ? "" : ` Until then: ${resolution.workaround}`
                }`
              : `Still open. ${resolution.currentAdvice}`}
      </div>

      {failureMode.detection !== undefined ? (
        <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Recognised by {failureMode.detection.signal.replaceAll("-", " ")}
          {failureMode.detection.match === undefined ? "" : `: ${failureMode.detection.match}`}
        </div>
      ) : null}

      <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
        Hit {failureMode.deploymentsAffected} deployments. First seen{" "}
        {formatObservedDate(failureMode.firstSeenAt)}
        {failureMode.lastSeenAt === undefined
          ? ""
          : `, last seen ${formatObservedDate(failureMode.lastSeenAt)}`}
        . Attributed to{" "}
        {failureMode.attributedTo.kind === "provider"
          ? failureMode.attributedTo.service
          : failureMode.attributedTo.kind === "dependency"
            ? failureMode.attributedTo.name
            : failureMode.attributedTo.kind === "host"
              ? "the host codebase"
              : "the pack itself"}
        .
      </div>

      {failureMode.standing === undefined ? null : (
        <div
          className="mt-1 text-[11px] leading-4 text-muted-foreground"
          data-testid="pack-detail-failure-standing"
          data-state={failureMode.standing.state}
        >
          {describeFailureStanding(failureMode.standing)}
        </div>
      )}

      <Conditions conditions={failureMode.conditions} />
      <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
        {describeOrigin(failureMode.origin)}
      </div>
    </div>
  );
}

/**
 * The part that is not derivable from the source, and the part a consuming
 * agent could not have generated for itself. Integration knowledge comes first
 * because it is read while installing; the failures follow because they are
 * what the guidance above exists to prevent.
 */
export function PackKnowledgeSection({ knowledge }: { knowledge: PackKnowledge }) {
  const integration = knowledge.integration ?? [];
  const failureModes = orderFailureModes(knowledge.failureModes ?? []);

  if (integration.length === 0 && failureModes.length === 0) {
    return (
      <section className="rounded-lg border border-border p-4" data-testid="pack-detail-knowledge">
        <h2 className="text-sm font-medium text-foreground">What it knows</h2>
        <p
          className="mt-1 text-xs leading-5 text-muted-foreground"
          data-testid="pack-detail-knowledge-empty"
        >
          Nothing yet. No failure mode has been recorded against this and no installation knowledge
          has been written down, so an agent installing it is working from the source alone — the
          same position it would be in having written the code itself.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border p-4" data-testid="pack-detail-knowledge">
      <h2 className="text-sm font-medium text-foreground">What it knows</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        None of this is in the source. Each entry carries the conditions it was seen under, because
        a console path correct on one account tier in one region can be wrong on another and fail
        silently on your screen.
      </p>

      {integration.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Installing it correctly
          </div>
          <div className="grid gap-2">
            {integration.map((entry) => (
              <IntegrationEntry key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      ) : null}

      {failureModes.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            What has gone wrong in production
          </div>
          <div className="grid gap-2">
            {failureModes.map((failureMode) => (
              <FailureModeEntry key={failureMode.id} failureMode={failureMode} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
