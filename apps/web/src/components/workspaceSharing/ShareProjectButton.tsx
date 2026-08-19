import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, GlobeIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildTunnelProjectUrl,
  describeProjectShareTrigger,
  PROJECT_SHARE_OTHER_KINDS,
  PROJECT_SHARE_TUNNEL_KIND,
  PROJECT_SHARE_TUNNEL_SCOPE_NOTE,
  type ProjectShareTriggerPresentation,
} from "./projectShare.logic";
import { useWorkspaceShareState } from "./useWorkspaceShareState";
import {
  describeWorkspaceShare,
  formatWorkspaceShareDiagnostics,
  type WorkspaceShareTone,
} from "./workspaceSharing.logic";
import { WorkspaceShareConfirmDialog } from "./WorkspaceShareConfirmDialog";

const TONE_DOT: Record<WorkspaceShareTone, string> = {
  idle: "bg-muted-foreground/40",
  pending: "bg-amber-400",
  live: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

const TONE_BADGE = {
  idle: "secondary",
  pending: "info",
  live: "success",
  warning: "warning",
  error: "error",
} as const satisfies Record<WorkspaceShareTone, string>;

function TriggerFace({ view }: { view: ProjectShareTriggerPresentation }) {
  return (
    <>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[view.tone])} />
      {view.isBusy ? <Spinner className="size-3.5" /> : <GlobeIcon className="size-3.5" />}
      <span className="hidden @2xl/header-actions:inline">Share</span>
      {view.badgeLabel ? (
        <Badge size="sm" variant={TONE_BADGE[view.tone]} data-testid="project-share-badge">
          {view.badgeLabel}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * Getting a link you can send, from the surface you are already looking at.
 *
 * The neighbouring "open in browser" action is loopback by design, and it was
 * the only thing here that looked like sharing — so people pressed it, copied
 * `127.0.0.1`, and sent it to someone who could never open it. This one is
 * explicitly about the public internet, which is also why it never starts
 * without the confirmation: by the time a link exists the machine is already
 * published.
 */
export function ShareProjectButton({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const share = useWorkspaceShareState();
  const [isOpen, setIsOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const trigger = describeProjectShareTrigger({ state: share.state, isDesktop: share.isDesktop });
  const tunnel = describeWorkspaceShare(share.state);
  const url = buildTunnelProjectUrl({ shareUrl: tunnel.url, environmentId, projectId });
  const diagnostics = formatWorkspaceShareDiagnostics(share.state.diagnostics, 3);

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Live link copied",
        description: "It works while this computer is sharing, and stops working when it is not.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy the link",
        description: error.message,
      });
    },
  });

  const handlePrimaryAction = useCallback(() => {
    if (tunnel.primaryAction === "stop") {
      void share.stop();
      return;
    }
    setIsConfirmOpen(true);
  }, [share, tunnel.primaryAction]);

  const handleConfirmStart = useCallback(() => {
    setIsConfirmOpen(false);
    void share.start();
  }, [share]);

  if (trigger.isDisabled) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex">
              <Button
                size="xs"
                variant="outline"
                disabled
                aria-label={trigger.ariaLabel}
                data-testid="project-share-trigger"
                data-share-status={trigger.status}
              >
                <TriggerFace view={trigger} />
              </Button>
            </span>
          }
        />
        {/* The bridge that owns the tunnel lives in the desktop shell, so this
            build cannot publish the machine holding the files. */}
        <TooltipPopup side="bottom">
          Public sharing runs from the T3 Code desktop app, on the computer holding these files.
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={trigger.ariaLabel}
              data-testid="project-share-trigger"
              data-share-status={trigger.status}
            />
          }
        >
          <TriggerFace view={trigger} />
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          side="bottom"
          sideOffset={8}
          className="w-[min(24rem,calc(100vw-2rem))] p-3"
        >
          <div className="flex w-full flex-col gap-3">
            <div>
              <h3 className="text-xs font-medium text-foreground">Send someone a link</h3>
              <p className="text-[10px] text-muted-foreground">
                Three kinds of link, and they do not last the same amount of time.
              </p>
            </div>

            <section
              className="flex flex-col gap-2 rounded-lg border border-border p-2.5"
              data-testid="project-share-tunnel"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tunnel.tone])}
                    />
                    <span
                      className="text-xs font-medium text-foreground"
                      data-testid="project-share-tunnel-headline"
                    >
                      {PROJECT_SHARE_TUNNEL_KIND.title}
                    </span>
                    {tunnel.isBusy ? <Spinner className="size-3 text-muted-foreground" /> : null}
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {PROJECT_SHARE_TUNNEL_KIND.lifetime}
                  </p>
                </div>
                {tunnel.primaryAction || tunnel.isPrimaryActionDisabled ? (
                  <Button
                    size="xs"
                    variant={
                      tunnel.primaryAction === "stop" && tunnel.tone === "live"
                        ? "destructive-outline"
                        : "outline"
                    }
                    disabled={tunnel.isPrimaryActionDisabled}
                    onClick={handlePrimaryAction}
                    data-testid="project-share-primary-action"
                  >
                    {tunnel.primaryActionLabel}
                  </Button>
                ) : null}
              </div>

              {url ? (
                <>
                  <p className="text-[10px] text-muted-foreground">
                    {PROJECT_SHARE_TUNNEL_SCOPE_NOTE}
                  </p>
                  <div
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
                    data-testid="project-share-url"
                  >
                    <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">
                      {url}
                    </code>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => copyToClipboard(url, undefined)}
                      data-testid="project-share-copy"
                    >
                      {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                      {isCopied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </>
              ) : null}

              {tunnel.tone === "warning" || tunnel.tone === "error" ? (
                <p
                  className={cn(
                    "text-[10px]",
                    tunnel.tone === "error" ? "text-destructive" : "text-warning-foreground",
                  )}
                  data-testid="project-share-tunnel-problem"
                >
                  {tunnel.description}
                </p>
              ) : null}

              {diagnostics ? (
                <pre
                  className="max-h-20 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
                  data-testid="project-share-diagnostics"
                >
                  {diagnostics}
                </pre>
              ) : null}

              {share.actionError ? (
                <p
                  className="text-[10px] text-destructive"
                  data-testid="project-share-action-error"
                >
                  {share.actionError}
                </p>
              ) : null}
            </section>

            {/* Named, not offered: both are made elsewhere, and someone who only
                ever sees the tunnel will send a link that dies overnight. */}
            <section className="flex flex-col gap-2" data-testid="project-share-other-kinds">
              {PROJECT_SHARE_OTHER_KINDS.map((kind) => (
                <div key={kind.kind} data-testid={`project-share-kind-${kind.kind}`}>
                  <div className="text-xs font-medium text-muted-foreground">{kind.title}</div>
                  <p className="text-[10px] text-muted-foreground">
                    {kind.lifetime} {kind.source}
                  </p>
                </div>
              ))}
            </section>
          </div>
        </PopoverPopup>
      </Popover>

      <WorkspaceShareConfirmDialog
        open={isConfirmOpen}
        onOpenChange={setIsConfirmOpen}
        onConfirm={handleConfirmStart}
        testId="project-share-confirm"
        confirmTestId="project-share-confirm-start"
      />
    </>
  );
}
