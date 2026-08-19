import type { PackRelease, PackVerification } from "@t3tools/contracts";

import {
  describeConditions,
  describeReleaseSignals,
  describeScarRecord,
  formatObservedDate,
} from "./packDetail.logic";
import { Badge } from "../ui/badge";
import { Card, CardTitle } from "../ui/card";

function Count({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
}) {
  return (
    <div className="rounded-md border border-border p-2.5" data-testid="pack-detail-count">
      <div className="font-mono text-base text-foreground tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{label}</div>
      {detail === undefined ? null : (
        <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground/80">{detail}</div>
      )}
    </div>
  );
}

/**
 * What production has said, as the counts themselves. No badge and no rate:
 * a check that ran 812 times and failed twice, a check that has never run, and
 * a check that passed once on its author's laptop are three different facts,
 * and every collapsed form of them loses the denominator that decides which
 * one you are reading.
 */
export function PackScarRecordSection({
  verification,
  release,
}: {
  verification: PackVerification;
  /** Carries what this one release earned, which the lineage record does not. */
  release: PackRelease | undefined;
}) {
  const record = verification.record;
  const { hasProduction, headline } = describeScarRecord(record);
  const checks = verification.checks ?? [];
  const attestations = verification.attestations ?? [];

  return (
    <Card className="p-4" render={<section />} data-testid="pack-detail-record">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle className="text-sm">What production says</CardTitle>
        <span className="text-[11px] text-muted-foreground">
          As of {formatObservedDate(record.measuredAt)}
        </span>
      </div>

      <p
        className="mt-1 text-xs leading-5 text-muted-foreground"
        data-testid="pack-detail-record-headline"
        data-has-production={hasProduction}
      >
        {headline}
      </p>

      <p
        className="mt-1 text-[11px] leading-4 text-muted-foreground"
        data-testid="pack-detail-record-scope"
      >
        {record.scope === "release"
          ? "These counts are this release alone."
          : "These counts are every release of this pack together, so behaviour earned by an earlier release is in them."}
        {release?.signals === undefined
          ? ""
          : ` This release alone: ${describeReleaseSignals(release.signals)}.`}
      </p>

      {hasProduction ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Count
            label="installs succeeded"
            value={`${record.installsSucceeded} / ${record.installsAttempted}`}
            detail="of installs attempted"
          />
          <Count
            label="deployments still running"
            value={`${record.deploymentsSurviving} / ${record.deploymentsAttempted}`}
            detail="the number trying again cannot inflate"
          />
          <Count
            label="deployment-days"
            value={record.cumulativeServiceDays.toLocaleString()}
            detail={
              record.longestServiceDays === undefined
                ? undefined
                : `longest single run ${record.longestServiceDays} days`
            }
          />
          <Count
            label="breakages caught, and fixed"
            value={`${record.breakagesCaught} / ${record.breakagesFixed}`}
            detail="found by the maintenance agent"
          />
          {record.survival === undefined ? null : (
            <Count
              label="alive at 30 / 60 / 90 days"
              value={`${record.survival.aliveAtDay30} / ${record.survival.aliveAtDay60 ?? 0} / ${
                record.survival.aliveAtDay90 ?? 0
              }`}
              detail={`from a cohort of ${record.survival.cohortSize}`}
            />
          )}
          {record.knowledgeContradictions === undefined ? null : (
            <Count
              label="installs found the knowledge wrong"
              value={record.knowledgeContradictions.toLocaleString()}
              detail="followed what it says and it did not hold"
            />
          )}
          {record.firstDeployedAt === undefined ? null : (
            <Count
              label="first deployed"
              value={formatObservedDate(record.firstDeployedAt)}
              detail="the clock behind every count here"
            />
          )}
        </div>
      ) : null}

      {checks.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Checks that keep running after install
          </div>
          <div className="grid gap-2">
            {checks.map((check) => (
              <div
                key={check.id}
                className="rounded-md border border-border p-2.5"
                data-testid="pack-detail-check"
                data-check-id={check.id}
              >
                <div className="text-xs leading-5 text-foreground">{check.title}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {check.command}
                </div>
                <div
                  className="mt-1 text-[11px] leading-4 text-muted-foreground"
                  data-testid="pack-detail-check-counts"
                >
                  {check.runs === 0
                    ? "Has never run."
                    : `Ran ${check.runs} times, passed ${check.passes}${
                        check.deploymentsCovered === undefined
                          ? ""
                          : `, across ${check.deploymentsCovered} deployments`
                      }.`}
                  {check.guardsFailureModeId === undefined
                    ? ""
                    : ` It exists because ${check.guardsFailureModeId} happened.`}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {check.runsOn.map((moment) => (
                    <Badge key={moment} size="sm" variant="outline">
                      on {moment}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {attestations.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Somebody says they ran it
          </div>
          <p className="mb-1.5 text-[11px] leading-4 text-muted-foreground">
            Kept separate from the counts above and ranked by nothing. It says who did what, on
            what, and when — which is a smaller claim than &ldquo;it runs&rdquo;.
          </p>
          <div className="grid gap-2">
            {attestations.map((attestation) => (
              <div
                key={attestation.attestedAt}
                className="rounded-md border border-border p-2.5"
                data-testid="pack-detail-attestation"
              >
                <div className="text-xs leading-5 text-foreground">
                  {attestation.attestedBy.type === "user"
                    ? attestation.attestedBy.displayName
                    : `${attestation.attestedBy.provider} agent`}{" "}
                  <span className="text-muted-foreground">
                    on {formatObservedDate(attestation.attestedAt)}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {attestation.did.map((did) => did.replaceAll("-", " ")).join(", ")}
                </div>
                {attestation.note === undefined ? null : (
                  <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {attestation.note}
                  </div>
                )}
                {attestation.conditions === undefined ? null : (
                  <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {describeConditions(attestation.conditions).observed}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
