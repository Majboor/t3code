import type { DesktopServerExposureState, DesktopWorkspaceShareState } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, GlobeIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogViewport,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  createIdleWorkspaceShareState,
  describeWorkspaceShare,
  formatWorkspaceShareDiagnostics,
  WORKSPACE_SHARE_EXPOSURE_WARNING,
} from "./workspaceSharing.logic";

/**
 * A quick tunnel reaches the server over loopback, so the server sees the whole
 * internet as `127.0.0.1`. Today the desktop server refuses anonymous callers
 * (policy `desktop-managed-local`), which is what keeps this safe — but that same
 * policy offers no pairing tokens, so a guest cannot be let in until the user
 * also enables network access. Both halves of that are stated in the UI below.
 */
const NETWORK_ACCESS_HINT =
  "Turn on Settings → Connections → Network access first. Without it the server has no way to issue a pairing link, so your guest will only ever see a sign-in wall.";

export function WorkspaceSharingPanel() {
  const [shareState, setShareState] = useState<DesktopWorkspaceShareState>(
    createIdleWorkspaceShareState,
  );
  const [exposureState, setExposureState] = useState<DesktopServerExposureState | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.getWorkspaceShareState !== "function") return;

    let cancelled = false;
    void bridge.getWorkspaceShareState().then(
      (next) => {
        if (!cancelled) setShareState(next);
      },
      () => {},
    );
    void bridge.getServerExposureState?.().then(
      (next) => {
        if (!cancelled) setExposureState(next);
      },
      () => {},
    );

    const unsubscribe = bridge.onWorkspaceShareState?.((next) => {
      setShareState(next);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Share link copied",
        description: "Anyone with this link can reach this computer while sharing is on.",
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

  const view = describeWorkspaceShare(shareState);
  const diagnostics = formatWorkspaceShareDiagnostics(shareState.diagnostics);
  const isDesktop = typeof window !== "undefined" && window.desktopBridge !== undefined;

  const runStart = useCallback(async () => {
    setActionError(null);
    const bridge = window.desktopBridge;
    if (!bridge) return;
    try {
      setShareState(await bridge.startWorkspaceShare());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const runStop = useCallback(async () => {
    setActionError(null);
    const bridge = window.desktopBridge;
    if (!bridge) return;
    try {
      setShareState(await bridge.stopWorkspaceShare());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handlePrimaryAction = useCallback(() => {
    if (view.primaryAction === "stop") {
      void runStop();
      return;
    }
    // Never start straight from the button: the confirmation is where the user
    // learns the link is public, and by the time it exists that is already true.
    setIsConfirmOpen(true);
  }, [runStop, view.primaryAction]);

  const handleConfirmStart = useCallback(() => {
    setIsConfirmOpen(false);
    void runStart();
  }, [runStart]);

  if (!isDesktop) {
    return (
      <section className="space-y-3" data-testid="workspace-sharing-panel">
        <Alert variant="info">
          <GlobeIcon aria-hidden />
          <AlertTitle>Sharing runs from the desktop app</AlertTitle>
          <AlertDescription>
            This workspace is served from another machine. Open the T3 Code desktop app on the
            computer holding the files to share it.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="workspace-sharing-panel">
      <div className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                view.tone === "live" && "bg-success",
                view.tone === "pending" && "bg-amber-400",
                view.tone === "error" && "bg-destructive",
                view.tone === "warning" && "bg-warning",
                view.tone === "idle" && "bg-muted-foreground/40",
              )}
            />
            <h3
              className="text-[13px] font-semibold tracking-[-0.01em] text-foreground"
              data-testid="workspace-sharing-headline"
            >
              {view.headline}
            </h3>
            {view.isBusy ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
          </div>
          <p
            className="text-xs leading-relaxed text-muted-foreground/80"
            data-testid="workspace-sharing-description"
          >
            {view.description}
          </p>
        </div>

        {view.primaryAction || view.isPrimaryActionDisabled ? (
          <Button
            size="xs"
            variant={
              view.primaryAction === "stop" && view.tone === "live"
                ? "destructive-outline"
                : "outline"
            }
            disabled={view.isPrimaryActionDisabled}
            onClick={handlePrimaryAction}
            data-testid="workspace-sharing-primary-action"
          >
            {view.primaryActionLabel}
          </Button>
        ) : null}
      </div>

      {view.url ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
          data-testid="workspace-sharing-url"
        >
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {view.url}
          </code>
          <Button
            size="xs"
            variant="outline"
            onClick={() => copyToClipboard(view.url ?? "", undefined)}
            data-testid="workspace-sharing-copy"
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : null}

      {view.url && exposureState?.mode === "local-only" ? (
        <Alert variant="warning" data-testid="workspace-sharing-network-hint">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Your guest cannot sign in yet</AlertTitle>
          <AlertDescription>{NETWORK_ACCESS_HINT}</AlertDescription>
        </Alert>
      ) : null}

      {view.showInstallHint ? (
        <Alert variant="warning" data-testid="workspace-sharing-install-hint">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>cloudflared is required</AlertTitle>
          <AlertDescription>
            Install Cloudflare&apos;s <code className="font-mono">cloudflared</code> command, then
            try again. Sharing needs it to open the tunnel.
          </AlertDescription>
        </Alert>
      ) : null}

      {diagnostics ? (
        <pre
          className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
          data-testid="workspace-sharing-diagnostics"
        >
          {diagnostics}
        </pre>
      ) : null}

      {actionError ? (
        <Alert variant="error" data-testid="workspace-sharing-action-error">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>Could not change sharing</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <AlertDialogPortal>
          <AlertDialogViewport>
            <AlertDialogPopup className="max-w-md" data-testid="workspace-sharing-confirm">
              <AlertDialogHeader>
                <AlertDialogTitle>Put this workspace on the internet?</AlertDialogTitle>
                <AlertDialogDescription>{WORKSPACE_SHARE_EXPOSURE_WARNING}</AlertDialogDescription>
              </AlertDialogHeader>
              <Alert variant="warning" className="mx-4">
                <ShieldAlertIcon aria-hidden />
                <AlertDescription>
                  The link stays live until you stop sharing or quit the app, and a new link is
                  issued every time you start again.
                </AlertDescription>
              </Alert>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button onClick={handleConfirmStart} data-testid="workspace-sharing-confirm-start">
                  Start sharing
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialogViewport>
        </AlertDialogPortal>
      </AlertDialog>
    </section>
  );
}
