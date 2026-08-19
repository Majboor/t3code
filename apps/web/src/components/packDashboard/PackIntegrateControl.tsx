import { CopyIcon, TerminalIcon } from "lucide-react";
import type { PackIntegration, PackIntegrationTarget } from "@t3tools/contracts";
import { useState } from "react";

import {
  PACK_INTEGRATION_TARGET_LABELS,
  listIntegrationTargets,
  resolveIntegrationPrompt,
} from "./packDetail.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { Card, CardTitle } from "../ui/card";

/**
 * The paste-into-another-agent surface. Targets are offered only where the
 * manifest carries a variant for them: a Lovable button that quietly pastes the
 * generic prompt would claim somebody wrote instructions for Lovable when
 * nobody did.
 */
export function PackIntegrateControl({ integration }: { integration: PackIntegration }) {
  const targets = listIntegrationTargets(integration);
  const [target, setTarget] = useState<PackIntegrationTarget>("generic");
  const prompt = resolveIntegrationPrompt(integration, target);

  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (label) => {
      toastManager.add({
        type: "success",
        title: `${label} copied`,
        description: "Paste it into the agent that is going to do the wiring.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: error.message,
      });
    },
  });

  return (
    <Card className="p-4" render={<section />} data-testid="pack-detail-integrate">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle className="text-sm">Integrate</CardTitle>
        <Button
          size="sm"
          data-testid="pack-detail-integrate-copy"
          onClick={() => copyToClipboard(prompt, "Integration prompt")}
        >
          <CopyIcon />
          Copy integration prompt
        </Button>
      </div>

      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        The instructions an agent needs to wire this into a codebase it has never seen. They say
        what order to do things in and what to get right, which is not the same as what the pack has
        since learned goes wrong — that is the knowledge below.
      </p>

      {targets.length > 1 ? (
        <ToggleGroup
          className="mt-3 flex-wrap"
          data-testid="pack-detail-integrate-targets"
          onValueChange={(next) => {
            const [selected] = next;
            const entry = targets.find((candidate) => candidate === selected);
            if (entry !== undefined) {
              setTarget(entry);
            }
          }}
          value={[target]}
          variant="segmented"
        >
          {targets.map((entry) => (
            <ToggleGroupItem
              key={entry}
              data-target={entry}
              data-testid="pack-detail-integrate-target"
              value={entry}
            >
              {PACK_INTEGRATION_TARGET_LABELS[entry]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}

      <pre
        className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs leading-5 text-foreground"
        data-testid="pack-detail-integrate-prompt"
      >
        {prompt}
      </pre>

      {integration.installCommand !== undefined ? (
        <div className="mt-2 flex items-center gap-2">
          <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted/40 px-2 py-1 font-mono text-xs text-foreground">
            {integration.installCommand}
          </code>
          <Button
            size="xs"
            variant="outline"
            aria-label="Copy install command"
            data-testid="pack-detail-install-copy"
            onClick={() => {
              copyToClipboard(integration.installCommand ?? "", "Install command");
            }}
          >
            <CopyIcon />
          </Button>
        </div>
      ) : null}

      {integration.followUpQuestions !== undefined && integration.followUpQuestions.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="text-xs font-medium text-foreground">The agent should ask you first</div>
          <ul className="mt-1 grid gap-0.5">
            {integration.followUpQuestions.map((question) => (
              <li key={question} className="text-xs leading-5 text-muted-foreground">
                — {question}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
