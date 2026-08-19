import { ExternalLinkIcon } from "lucide-react";
import type { PackRequirements } from "@t3tools/contracts";

import {
  describeCostBasis,
  describeCostModel,
  describeRequirements,
  summariseRunningCost,
} from "./packDetail.logic";
import { Badge } from "../ui/badge";
import { Card, CardTitle } from "../ui/card";

function RequirementRow({
  title,
  detail,
  badges,
  children,
}: {
  title: string;
  detail: string;
  badges?: readonly { readonly label: string; readonly tone: "warning" | "outline" | "info" }[];
  children?: React.ReactNode;
}) {
  return (
    <div className="border-t border-border py-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-foreground">{title}</span>
        {(badges ?? []).map((badge) => (
          <Badge key={badge.label} size="sm" variant={badge.tone}>
            {badge.label}
          </Badge>
        ))}
      </div>
      <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
      {children}
    </div>
  );
}

function ObtainLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="mt-1 inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {label}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

/**
 * What a consumer has to supply before any of this runs, placed above what the
 * pack knows because a key they cannot get or an account they will not pay for
 * rules the pack out before anything else on the page matters.
 */
export function PackRequirementsSection({ requirements }: { requirements: PackRequirements }) {
  const accounts = requirements.accounts ?? [];
  const environment = requirements.environment ?? [];
  const services = requirements.services ?? [];
  const toolchain = requirements.toolchain ?? [];
  const packs = requirements.packs ?? [];
  const setupSteps = requirements.setupSteps ?? [];
  const cost = summariseRunningCost(requirements);

  return (
    <Card className="p-4" render={<section />} data-testid="pack-detail-requirements">
      <CardTitle className="text-sm">Before this runs, you supply</CardTitle>
      <p
        className="mt-1 text-xs leading-5 text-muted-foreground"
        data-testid="pack-detail-requirements-headline"
      >
        {describeRequirements(requirements)}
      </p>

      <p
        className="mt-1 text-xs leading-5 text-foreground"
        data-testid="pack-detail-requirements-cost"
        data-paying={cost.paying.length}
        data-undeclared={cost.undeclared.length}
      >
        {cost.line}
      </p>

      {accounts.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Accounts in your name
          </div>
          <div className="grid" data-testid="pack-detail-requirement-accounts">
            {accounts.map((account) => (
              <RequirementRow
                key={account.service}
                title={account.displayName}
                detail={account.purpose}
                badges={
                  account.cost !== undefined
                    ? [
                        {
                          label: describeCostModel(account.cost.model),
                          tone:
                            account.cost.model === "free"
                              ? ("outline" as const)
                              : ("warning" as const),
                        },
                      ]
                    : account.costsMoney === true
                      ? [{ label: "Costs money", tone: "warning" as const }]
                      : account.costsMoney === false
                        ? [{ label: "Free", tone: "outline" as const }]
                        : [{ label: "Cost not stated", tone: "warning" as const }]
                }
              >
                {account.cost === undefined || describeCostBasis(account.cost) === null ? null : (
                  <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {describeCostBasis(account.cost)}
                  </div>
                )}
                {account.requiredPlan !== undefined ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Needs the {account.requiredPlan} plan.
                  </div>
                ) : null}
                {account.requiredScopes !== undefined && account.requiredScopes.length > 0 ? (
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {account.requiredScopes.join(" · ")}
                  </div>
                ) : null}
                {account.signupUrl !== undefined ? (
                  <ObtainLink href={account.signupUrl} label="Sign up" />
                ) : null}
              </RequirementRow>
            ))}
          </div>
        </div>
      ) : null}

      {environment.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Values</div>
          <div className="grid" data-testid="pack-detail-requirement-environment">
            {environment.map((entry) => (
              <RequirementRow
                key={entry.name}
                title={entry.name}
                detail={entry.purpose}
                badges={[
                  ...(entry.required
                    ? [{ label: "Required", tone: "outline" as const }]
                    : [{ label: "Optional", tone: "outline" as const }]),
                  // Secrecy and necessity are separate facts: a publishable key
                  // is required and not secret, a signing secret is both.
                  ...(entry.secret ? [{ label: "Secret", tone: "info" as const }] : []),
                ]}
              >
                {entry.example !== undefined ? (
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    looks like {entry.example}
                  </div>
                ) : null}
                {entry.defaultValue !== undefined ? (
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    defaults to {entry.defaultValue}
                  </div>
                ) : null}
                {entry.obtainUrl !== undefined ? (
                  <ObtainLink href={entry.obtainUrl} label="Where to get one" />
                ) : null}
              </RequirementRow>
            ))}
          </div>
        </div>
      ) : null}

      {services.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Infrastructure you run
          </div>
          <div className="grid" data-testid="pack-detail-requirement-services">
            {services.map((service) => (
              <RequirementRow
                key={service.name}
                title={`${service.name} (${service.kind}${
                  service.versionRange !== undefined ? ` ${service.versionRange}` : ""
                })`}
                detail={service.purpose}
                badges={
                  service.cost === undefined
                    ? [{ label: "Cost not stated", tone: "warning" as const }]
                    : [
                        {
                          label: describeCostModel(service.cost.model),
                          tone:
                            service.cost.model === "free"
                              ? ("outline" as const)
                              : ("warning" as const),
                        },
                      ]
                }
              >
                {service.cost === undefined || describeCostBasis(service.cost) === null ? null : (
                  <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {describeCostBasis(service.cost)}
                  </div>
                )}
              </RequirementRow>
            ))}
          </div>
        </div>
      ) : null}

      {toolchain.length > 0 || packs.length > 0 ? (
        <div className="mt-3 text-xs leading-5 text-muted-foreground">
          {toolchain.length > 0 ? (
            <div data-testid="pack-detail-requirement-toolchain">
              Toolchain:{" "}
              {toolchain
                .map((tool) =>
                  tool.versionRange === undefined ? tool.name : `${tool.name} ${tool.versionRange}`,
                )
                .join(", ")}
            </div>
          ) : null}
          {packs.length > 0 ? (
            <div data-testid="pack-detail-requirement-packs">
              Other packs:{" "}
              {packs
                .map((pack) => `${pack.publisherHandle}/${pack.name}@${pack.versionRange}`)
                .join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {setupSteps.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Setup, in order</div>
          <ol className="grid gap-2" data-testid="pack-detail-setup-steps">
            {setupSteps.map((step, index) => (
              <li key={step.title} className="text-xs leading-5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-foreground">
                    {index + 1}. {step.title}
                  </span>
                  {step.manual === true ? (
                    <Badge size="sm" variant="outline">
                      You, not the agent
                    </Badge>
                  ) : null}
                </div>
                <div className="text-muted-foreground">{step.instructions}</div>
                {step.command !== undefined ? (
                  <code className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                    {step.command}
                  </code>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {requirements.preflightCommand !== undefined ? (
        <div className="mt-3 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
          Answers &ldquo;can this run yet?&rdquo; on its own:{" "}
          <code className="font-mono text-foreground">{requirements.preflightCommand}</code>
        </div>
      ) : null}
    </Card>
  );
}
