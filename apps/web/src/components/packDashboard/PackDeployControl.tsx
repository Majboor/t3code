import { CopyIcon, RocketIcon, TriangleAlertIcon } from "lucide-react";
import type { PackRequirements, PackRuntime } from "@t3tools/contracts";

import { buildDeployPrompt } from "./packDetail.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * The lifecycle entries worth showing, in the order somebody runs them. The
 * manifest's `commands` is a fixed set rather than a free list, so this can be
 * an ordered whitelist instead of guessing which key means "start".
 */
const DEPLOY_STEPS = [
  ["install", "Install"],
  ["build", "Build"],
  ["migrate", "Migrate"],
  ["start", "Start"],
  ["healthcheck", "Health check"],
] as const;

/**
 * The values a deploy needs before any of the commands can run. Secrets are
 * called out separately because they are the ones that must not be typed onto
 * a command line.
 */
export function listDeployInputs(requirements: PackRequirements): {
  readonly required: ReadonlyArray<{ name: string; secret: boolean; purpose: string }>;
} {
  const environment = requirements.environment ?? [];
  return {
    required: environment
      .filter((entry) => entry.required)
      .map((entry) => ({ name: entry.name, secret: entry.secret, purpose: entry.purpose })),
  };
}

export function PackDeployControl({
  qualifiedName,
  runtime,
  requirements,
}: {
  qualifiedName: string;
  runtime: PackRuntime;
  requirements: PackRequirements;
}) {
  // The same words the composer's quick view writes into the prompt bar, so a
  // pack does not describe its own deploy two different ways.
  const deployPrompt = buildDeployPrompt({ qualifiedName, runtime, requirements });
  const { required } = listDeployInputs(requirements);
  const steps = DEPLOY_STEPS.flatMap(([key, label]) => {
    const step = runtime.commands[key];
    return step === undefined ? [] : [{ label, step }];
  });

  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (label) => {
      toastManager.add({
        type: "success",
        title: `${label} copied`,
        description: "Paste it to the agent working on the project you want this deployed from.",
      });
    },
    onError: (error) => {
      toastManager.add({ type: "error", title: "Could not copy", description: error.message });
    },
  });

  if (steps.length === 0) {
    return (
      <section className="rounded-lg border border-border p-4" data-testid="pack-detail-deploy">
        <h2 className="text-sm font-medium text-foreground">Deploy</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          This pack declares no runtime commands, so there is nothing to start. It is a library
          rather than something you deploy.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border p-4" data-testid="pack-detail-deploy">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Deploy</h2>
        {deployPrompt === null ? null : (
          <Button
            size="sm"
            data-testid="pack-detail-deploy-copy"
            onClick={() => copyToClipboard(deployPrompt, "Deploy prompt")}
          >
            <CopyIcon />
            Copy deploy prompt
          </Button>
        )}
      </div>

      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        What this pack says it takes to run. The host and its credentials are yours to supply — the
        pack declares what it needs, not where it goes.
      </p>

      {required.length === 0 ? null : (
        <div className="mt-3" data-testid="pack-detail-deploy-inputs">
          <div className="text-xs font-medium text-foreground">Set these first</div>
          <ul className="mt-1 grid gap-1">
            {required.map((entry) => (
              <li key={entry.name} className="flex items-start gap-1.5 text-xs">
                {entry.secret ? (
                  <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-amber-500" />
                ) : (
                  <RocketIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <code className="text-foreground">{entry.name}</code>
                  <span className="text-muted-foreground">
                    {entry.secret ? " (secret — keep it off the command line)" : ""} —{" "}
                    {entry.purpose}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 grid gap-2" data-testid="pack-detail-deploy-steps">
        {steps.map(({ label, step }) => (
          <div key={label} className="rounded-md border border-border/70 p-2">
            <div className="text-[11px] font-medium text-foreground">{label}</div>
            <code className="mt-0.5 block overflow-x-auto text-[11px] text-muted-foreground">
              {step.command}
            </code>
            {step.description === undefined ? null : (
              <div className="mt-0.5 text-[11px] text-muted-foreground/80">{step.description}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
