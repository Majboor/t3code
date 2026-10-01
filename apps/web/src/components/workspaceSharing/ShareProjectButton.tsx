import { APP_BASE_NAME } from "../../branding";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CheckIcon, CloudUploadIcon, CopyIcon, GlobeIcon, LinkIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useProjectTenancy } from "~/hooks/useProjectTenancy";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { mintAndCopyShareLink } from "../shareLinks/mintShareLink";
import {
  CLOUD_SYNC_OFFLINE_QUESTION,
  describeOfflineReachability,
} from "../cloudSync/cloudSync.logic";
import { CloudSyncModePicker } from "../cloudSync/CloudSyncModePicker";
import { useCloudSync } from "../cloudSync/useCloudSync";
import { useProjectCloudSyncScope } from "../cloudSync/useProjectCloudSyncScope";
import {
  buildTunnelProjectUrl,
  describeProjectShareTrigger,
  PROJECT_SHARE_OTHER_KINDS,
  PROJECT_SHARE_TUNNEL_KIND,
  PROJECT_SHARE_TUNNEL_SCOPE_NOTE,
  PROJECT_SHARE_WEB_KIND,
  type ProjectShareTriggerPresentation,
} from "./projectShare.logic";
import { useWorkspaceShareState } from "./useWorkspaceShareState";
import {
  describeWorkspaceShare,
  formatWorkspaceShareDiagnostics,
  isWorkspaceShareLive,
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
  const [isMintingWebLink, setIsMintingWebLink] = useState(false);
  const [isPickingCloudMode, setIsPickingCloudMode] = useState(false);
  const tenancy = useProjectTenancy(environmentId, projectId);

  /*
   * The sync is read only while this popover is open. The Cloud control next to
   * this one already reads it on mount for its badge; a second unconditional
   * reader would double that cost on every header render to answer a question
   * nobody has asked until they press Share.
   */
  const cloudScope = useProjectCloudSyncScope(environmentId, projectId);
  const cloudSync = useCloudSync({ ...cloudScope, enabled: isOpen });

  /**
   * A project outside any shared workspace has nobody to share it with, so the
   * offer is withheld rather than rendered and then refused on click.
   */
  const canShareInWeb = tenancy.tenantId !== null && tenancy.workspaceId !== null;

  /**
   * Mint a workspace link and put it on the clipboard in one act.
   *
   * Workspace scope, not project scope, and the difference is the whole
   * feature: claiming a workspace link makes the visitor a *member*, which is
   * what "use it in the web" means. A project link is served as bytes to a
   * browser with no session and would hand them a read-only copy while the
   * button promised them the workspace.
   *
   * `public` audience because that is the link you send: anyone holding it who
   * signs in can claim it. Naming particular people is a different act with a
   * different payload — see `ShareLinksPanel`, which can take the addresses.
   */
  const handleCopyWebLink = useCallback(async () => {
    if (!canShareInWeb || tenancy.tenantId === null || tenancy.workspaceId === null) {
      return;
    }
    setIsMintingWebLink(true);
    try {
      await mintAndCopyShareLink({
        environmentId,
        failureTitle: "Could not make a web link",
        create: {
          tenantId: tenancy.tenantId,
          workspaceId: tenancy.workspaceId,
          scope: "workspace",
          audience: { kind: "public" },
        },
      });
    } finally {
      setIsMintingWebLink(false);
    }
  }, [canShareInWeb, environmentId, tenancy.tenantId, tenancy.workspaceId]);

  const trigger = describeProjectShareTrigger({ state: share.state, isDesktop: share.isDesktop });
  const tunnel = describeWorkspaceShare(share.state);
  const url = buildTunnelProjectUrl({ shareUrl: tunnel.url, environmentId, projectId });
  const diagnostics = formatWorkspaceShareDiagnostics(share.state.diagnostics, 3);

  /*
   * Sharing starts a tunnel, and the spec starts the sync beside it precisely
   * because the tunnel dies with the laptop. The two do not in fact start
   * together yet, so this is where the gap shows: a person has just been handed
   * a working public link and has no reason to suspect it is temporary. The
   * same sentence the Cloud control uses is answered here, in the panel that
   * produced the link.
   */
  const reachability = describeOfflineReachability({
    sync: cloudSync.sync,
    liveLinkRunning: isWorkspaceShareLive(share.state.status),
  });
  // A project with no workspace has nowhere to sync to, and a `sync` that has
  // not been read yet is not the same as one that does not exist.
  const canKeepCloudCopy =
    cloudScope.tenantId !== null && cloudScope.workspaceId !== null && cloudSync.loaded;
  const showCloudCopySection = canKeepCloudCopy && !cloudSync.readError;
  /*
   * The note points at "the Cloud control beside this one", which is the right
   * advice only while the thing itself is not on screen. When it is, repeating
   * it sends somebody to a second control to do what this one just offered.
   */
  const otherKinds = showCloudCopySection
    ? PROJECT_SHARE_OTHER_KINDS.filter((kind) => kind.kind !== "cloud")
    : PROJECT_SHARE_OTHER_KINDS;

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
          Public sharing runs from the {APP_BASE_NAME} desktop app, on the computer holding these
          files.
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
                Several kinds of link, and they do not last the same amount of time.
              </p>
            </div>

            <section
              className="flex flex-col gap-2 rounded-lg border border-border p-2.5"
              data-testid="project-share-web"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span
                    className="text-xs font-medium text-foreground"
                    data-testid="project-share-web-headline"
                  >
                    {PROJECT_SHARE_WEB_KIND.title}
                  </span>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {PROJECT_SHARE_WEB_KIND.source}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canShareInWeb || isMintingWebLink}
                  onClick={() => void handleCopyWebLink()}
                  data-testid="project-share-web-action"
                >
                  {isMintingWebLink ? (
                    <Spinner className="size-3" />
                  ) : (
                    <LinkIcon className="size-3" aria-hidden />
                  )}
                  {isMintingWebLink ? "Making" : "Copy link"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {canShareInWeb
                  ? "Anyone with this link who signs in joins the workspace and can work in it from a browser. Revoke it any time in the Files panel."
                  : "This project is not in a shared workspace yet, so there is nobody a link could let in."}
              </p>
            </section>

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
                {/* No button at all without the bridge that owns the tunnel:
                    one that cannot do anything when pressed is worse than an
                    absent one, because the person keeps pressing it. */}
                {share.isDesktop && (tunnel.primaryAction || tunnel.isPrimaryActionDisabled) ? (
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

              {share.isDesktop ? null : (
                <p
                  className="text-[10px] text-muted-foreground"
                  data-testid="project-share-tunnel-desktop-only"
                >
                  Runs from the {APP_BASE_NAME} desktop app, on the computer holding these files.
                  The web link above needs nothing installed.
                </p>
              )}

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

            {showCloudCopySection ? (
              <section
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-2.5",
                  reachability.reachable ? "border-border" : "border-amber-500/40 bg-amber-500/8",
                )}
                data-testid="project-share-cloud-copy"
                data-answer={reachability.answer}
              >
                <div>
                  <span className="text-[10px] text-muted-foreground">
                    {CLOUD_SYNC_OFFLINE_QUESTION}
                  </span>
                  <div
                    className="text-xs font-medium text-foreground"
                    data-testid="project-share-cloud-copy-answer"
                  >
                    {reachability.title}
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{reachability.detail}</p>
                </div>

                {/* Offered, never begun on their behalf. Which copy is the real
                    one is the decision this whole feature turns on, so the
                    button opens the question rather than answering it — and the
                    picker behind it preselects neither mode for the same
                    reason. */}
                {cloudSync.sync === null ? (
                  isPickingCloudMode ? (
                    <CloudSyncModePicker
                      busy={cloudSync.busy}
                      onStart={(mode) => void cloudSync.start(mode)}
                    />
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      className="self-start"
                      onClick={() => setIsPickingCloudMode(true)}
                      data-testid="project-share-cloud-copy-offer"
                    >
                      <CloudUploadIcon className="size-3" aria-hidden />
                      Keep a cloud copy
                    </Button>
                  )
                ) : null}
              </section>
            ) : null}

            {/* Named, not offered: both are made elsewhere, and someone who only
                ever sees the tunnel will send a link that dies overnight. */}
            <section className="flex flex-col gap-2" data-testid="project-share-other-kinds">
              {otherKinds.map((kind) => (
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
