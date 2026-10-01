/**
 * Which project kinds `project.create` is allowed to be asked for.
 *
 * @module ProjectKindRules
 */
import type { ProjectKind } from "@t3tools/contracts";

/**
 * The message a person sees when they try to *create* a joined project.
 *
 * Joining is an act with another person in it. The kind records that somebody
 * else owns the work and this account was let in, so a self-declared `joined`
 * project would be a claim about a relationship that does not exist — the row
 * would say "somebody shared this with you" with nobody on the other end, and
 * everything the product then offers on the strength of that (ask the owner,
 * leave the project, see who else is in it) would point at nothing.
 *
 * Phrased as a redirection rather than a denial, the same way
 * `PAIRED_ENVIRONMENT_HOSTING_REFUSAL` is: whoever hit this wants a project and
 * there is a way to get one, so the message spends its words on which act they
 * actually need rather than on the word "invalid".
 */
export const JOINED_PROJECT_CREATE_REFUSAL =
  "A joined project is what accepting a share link produces, not something you create. Ask whoever owns the project for a share link, or create your own as local, hosted, or self-hosted.";

/**
 * Decides whether a `project.create` may ask for this kind. `null` means yes.
 *
 * Pure, and deliberately not a method on anything, so the rule can be stated
 * once and checked twice: at the socket, before normalization has created a
 * workspace directory nobody is going to use, and again in the decider, which
 * every entry point reaches — the CLI and the SDK dispatch straight into the
 * engine, so a rule only the websocket knows is one `t3 project add` away from
 * being untrue. That is the same two-call-site shape
 * `decideProjectHostingRefusal` already uses, for the same reason.
 *
 * `hosted` gets no rule here even though it is refusable. A server whose
 * `workspaceSource` is `paired-environment` holds no workspaces at all, so
 * `decideProjectHostingRefusal` already turns away *every* `project.create`
 * there whatever its kind; a kind-specific copy of that rule would only be a
 * second place to keep in step with the first.
 *
 * An absent or null kind is allowed, and has to be: it is what every client
 * built before kinds existed sends.
 */
export function decideProjectKindRefusal(input: {
  readonly kind: ProjectKind | null | undefined;
}): string | null {
  return input.kind === "joined" ? JOINED_PROJECT_CREATE_REFUSAL : null;
}
