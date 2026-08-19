import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { memo, useCallback } from "react";

import {
  createBrowserHandoffCredential,
  resolvePrimaryEnvironmentHttpUrl,
} from "~/environments/primary";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { buildProjectBrowserUrl, handOffProjectToBrowser } from "./OpenProjectInBrowser.logic";

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

/**
 * The clipboard never gets the sign-in credential, so say so rather than let
 * someone discover it by pasting the address somewhere and being asked to pair.
 */
function describeClipboard(handedOff: boolean): string {
  return handedOff
    ? "That browser was signed in for you. The clipboard has the plain address, so any other browser will still ask to pair."
    : "The address is on your clipboard, for this machine's browsers.";
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

    void handOffProjectToBrowser({
      url,
      // Only the desktop shell opens a browser that is a stranger to this session.
      // Without the bridge the "browser" is another tab of this one, and it
      // already has the cookie.
      mintPairingCredential: window.desktopBridge
        ? async () => (await createBrowserHandoffCredential()).credential
        : undefined,
      copyToClipboard,
      openExternal: (target) => api.shell.openExternal(target),
    }).then(
      (outcome) => {
        if (outcome.status === "not-opened") {
          toastManager.add({
            type: "error",
            title: "Unable to sign your browser in",
            description: `${outcome.reason} Nothing was opened, because the page would have turned you away.`,
          });
          return;
        }

        toastManager.add({
          type: outcome.copied ? "success" : "warning",
          title: "Opened this project in your browser",
          description: outcome.copied
            ? describeClipboard(outcome.handedOff)
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
        Open in browser — signs your browser in and opens this project here on this machine
      </TooltipPopup>
    </Tooltip>
  );
});
