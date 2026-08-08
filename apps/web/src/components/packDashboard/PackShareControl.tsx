import { LinkIcon, LockIcon } from "lucide-react";
import type { PackIdentity, PackVisibility } from "@t3tools/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * The link somebody else can open. Built from the current origin rather than a
 * configured base URL, because the person sharing is on the address their
 * reader will need.
 */
export function buildPackShareUrl(origin: string, packId: PackIdentity["id"]): string {
  return `${origin.replace(/\/+$/, "")}/pack/${packId}`;
}

/**
 * Copies a link to this pack. A private pack is still shareable — the link just
 * will not open for anyone outside the workspace, so the control says that
 * rather than handing over a URL that quietly 404s for the recipient.
 */
export function PackShareControl({
  identity,
  visibility,
  origin = typeof window === "undefined" ? "" : window.location.origin,
}: {
  identity: PackIdentity;
  visibility: PackVisibility;
  origin?: string;
}) {
  const url = buildPackShareUrl(origin, identity.id);
  const qualified = `${identity.publisher.handle}/${identity.name}@${identity.version}`;
  const isPrivate = visibility.scope === "workspace";

  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Link copied",
        description: isPrivate
          ? "This pack is private, so only people in the workspace can open it."
          : `Anyone who can reach this server can open ${qualified}.`,
      });
    },
    onError: (error) => {
      toastManager.add({ type: "error", title: "Could not copy", description: error.message });
    },
  });

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-4"
      data-testid="pack-detail-share"
      data-visibility={visibility.scope}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">Share</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {isPrivate ? (
            <>
              <LockIcon className="size-3 shrink-0" />
              <span>Private, so the link only opens for this workspace.</span>
            </>
          ) : (
            <span className="truncate" data-testid="pack-detail-share-url">
              {url}
            </span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        data-testid="pack-detail-share-copy"
        onClick={() => copyToClipboard(url, "Pack link")}
      >
        <LinkIcon />
        Copy link
      </Button>
    </div>
  );
}
