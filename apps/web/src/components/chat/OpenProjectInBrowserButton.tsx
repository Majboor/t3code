import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { buildProjectBrowserUrl, copyLinkAndOpen } from "./OpenProjectInBrowser.logic";

/**
 * In the browser build there is no bridge, and the action stays rather than
 * disappearing: `navigator.clipboard` and the local API's own `window.open`
 * fallback already do both halves, and a header whose buttons come and go with
 * the shell is harder to learn than one that always works.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  const bridge = window.desktopBridge;
  if (bridge) {
    return bridge.writeClipboardText(text);
  }

  if (!navigator.clipboard?.writeText) {
    return false;
  }
  await navigator.clipboard.writeText(text);
  return true;
}

export const OpenProjectInBrowserButton = memo(function OpenProjectInBrowserButton({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const openInBrowser = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Opening links is unavailable." });
      return;
    }

    let url: string;
    try {
      url = buildProjectBrowserUrl({
        environmentId,
        projectId,
        resolveHttpUrl: resolvePrimaryEnvironmentHttpUrl,
      });
    } catch (error: unknown) {
      toastManager.add({
        type: "error",
        title: "Unable to work out this project's address",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }

    void copyLinkAndOpen({
      url,
      copyToClipboard,
      openExternal: (target) => api.shell.openExternal(target),
    }).then(
      ({ copied }) => {
        toastManager.add({
          type: copied ? "success" : "warning",
          title: "Opened this project in your browser",
          description: copied
            ? "The address is on your clipboard, for this machine's browsers."
            : "The address could not be copied, so paste it from the browser instead.",
        });
      },
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to open this project in your browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  }, [environmentId, projectId]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Open this project in your browser"
            data-testid="chat-header-open-in-browser"
            onClick={openInBrowser}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
          />
        }
      >
        <ExternalLinkIcon className="size-3.5" />
      </TooltipTrigger>
      {/* The server usually listens on loopback, so this address is this machine's, not a link to hand out. */}
      <TooltipPopup>
        Open in browser — copies this project&apos;s address and opens it here on this machine
      </TooltipPopup>
    </Tooltip>
  );
});
