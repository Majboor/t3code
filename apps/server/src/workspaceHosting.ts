/**
 * Whether this server will host the projects people create on it.
 *
 * @module WorkspaceHosting
 */
import type { WorkspaceSource } from "@t3tools/contracts";

/**
 * The message a person sees when they try to create a project on a server that
 * holds accounts rather than work.
 *
 * Written as advice rather than a denial, because the request is reasonable and
 * the answer is "somewhere else", not "no". Someone hitting this has usually
 * done nothing wrong — an old tab, a CLI pointed at the wrong host — and needs
 * to know where the project *should* go, which "forbidden" would not tell them.
 */
export const PAIRED_ENVIRONMENT_HOSTING_REFUSAL =
  "This server does not host projects. Connect an environment of your own — your laptop, or another machine you run — and create the project there.";

/**
 * Decides whether a command may create a project here.
 *
 * Pure and separated from the socket so the rule can be tested without standing
 * up a websocket, and so there is one statement of it rather than one per
 * entry point. `null` means allowed.
 *
 * Only the command's discriminant matters, so this accepts the narrowest shape
 * that carries it: the check runs before normalization, where the client's
 * command type and the normalized one do not otherwise agree.
 */
export function decideProjectHostingRefusal(input: {
  readonly workspaceSource: WorkspaceSource;
  readonly command: { readonly type: string };
}): string | null {
  if (input.command.type !== "project.create") {
    return null;
  }
  return input.workspaceSource === "paired-environment" ? PAIRED_ENVIRONMENT_HOSTING_REFUSAL : null;
}
