import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { setPairingTokenOnUrl } from "~/pairingUrl";

export type OpenProjectInBrowserOutcome =
  | { readonly status: "opened"; readonly copied: boolean; readonly handedOff: boolean }
  | { readonly status: "not-opened"; readonly copied: boolean; readonly reason: string };

/**
 * The address a browser needs is the app's own HTTP base URL, not a guess: the
 * desktop app starts its server on whatever port was free, so anything
 * hand-built from `localhost` is wrong the first time that port moves.
 */
export function buildProjectBrowserUrl(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  resolveHttpUrl: (pathname: string) => string;
}): string {
  const pathname = `/project/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(
    input.projectId,
  )}`;
  return input.resolveHttpUrl(pathname);
}

/**
 * Puts the credential in the fragment, never the query string. A fragment is not
 * sent to the server, does not reach an access log, and is not attached to the
 * `Referer` of anything the page later links to; the query string is all three.
 * It is the same placement the startup pairing URL uses.
 */
export function buildProjectHandoffUrl(input: {
  readonly url: string;
  readonly credential: string;
}): string {
  return setPairingTokenOnUrl(new URL(input.url), input.credential).toString();
}

/**
 * Opens a project in a browser that holds none of our cookies.
 *
 * Three things happen in this order, and the order is the point:
 *
 * 1. The clipboard gets the *plain* address, written while the click still counts
 *    as a user gesture — a clipboard write after an await is refused by browsers.
 *    The plain address is also the only one that is safe and honest to hand out:
 *    the credential below is single use, so a copied hand-off link would work for
 *    whoever opened it first and silently dead-end for everyone after, and a
 *    credential on the clipboard is a credential in every paste buffer, snippet
 *    manager, and screenshot on the machine.
 * 2. A credential is minted, but only when `mintPairingCredential` is supplied —
 *    the caller supplies it only when the target browser is a different agent from
 *    this one. A new tab of the same browser already carries the session cookie,
 *    and minting there would put an owner credential into that browser's history
 *    to buy nothing.
 * 3. Only then is anything opened. A failed mint returns `not-opened` rather than
 *    launching a browser at a page that will refuse the person standing there.
 */
export async function handOffProjectToBrowser(input: {
  url: string;
  mintPairingCredential?: (() => Promise<string>) | undefined;
  copyToClipboard: (text: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
}): Promise<OpenProjectInBrowserOutcome> {
  let copied = false;
  try {
    copied = await input.copyToClipboard(input.url);
  } catch {
    copied = false;
  }

  let target = input.url;
  let handedOff = false;
  if (input.mintPairingCredential) {
    let credential: string;
    try {
      credential = await input.mintPairingCredential();
    } catch (error: unknown) {
      return {
        status: "not-opened",
        copied,
        reason:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The server would not issue a sign-in credential for your browser.",
      };
    }

    target = buildProjectHandoffUrl({ url: input.url, credential });
    handedOff = true;
  }

  await input.openExternal(target);
  return { status: "opened", copied, handedOff };
}
