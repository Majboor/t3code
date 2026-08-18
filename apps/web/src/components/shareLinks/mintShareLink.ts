import type { EnvironmentId, ShareLink, ShareLinkCreateInput } from "@t3tools/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";
import {
  buildShareLinkUrl,
  describeMintedShareLink,
  describeShareLinkFailure,
} from "./shareLinks.logic";

export interface MintedShareLink {
  readonly link: ShareLink;
  /** Built here from the token; nothing can rebuild it once this value is dropped. */
  readonly url: string;
  /** False when the clipboard refused, which is the caller's cue to show `url`. */
  readonly copied: boolean;
}

async function writeToClipboard(value: string): Promise<boolean> {
  if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a link and put it on the clipboard in one act.
 *
 * These are one function rather than two because `create` hands back the token
 * once and no later call returns it: between the reply and the clipboard write
 * there is the only copy of a URL that already grants access to something. A
 * caller that forgot to copy would leave a live public link nobody can use and
 * that only shows up in the list as a row with no way to reach it.
 *
 * Returns null when the link was never made; a link that was made but not
 * copied comes back with `copied: false` so the caller can show the URL, which
 * is the last chance anyone has to read it.
 */
export async function mintAndCopyShareLink(input: {
  readonly environmentId: EnvironmentId;
  readonly create: ShareLinkCreateInput;
  readonly failureTitle: string;
}): Promise<MintedShareLink | null> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    toastManager.add({
      type: "error",
      title: input.failureTitle,
      description: "This workspace is not connected right now.",
    });
    return null;
  }

  let link: ShareLink;
  try {
    const result = await api.shareLinks.create(input.create);
    link = result.link;
  } catch (error: unknown) {
    const notice = describeShareLinkFailure(error, { fallbackTitle: input.failureTitle });
    toastManager.add({
      type: notice.tone,
      title: notice.title,
      description: notice.description,
    });
    return null;
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = buildShareLinkUrl(link.token, origin);
  const copied = await writeToClipboard(url);
  const notice = describeMintedShareLink({ scope: link.scope, copied });
  toastManager.add({ type: notice.tone, title: notice.title, description: notice.description });

  return { link, url, copied };
}
