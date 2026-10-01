import {
  resolveWorkspaceSource,
  type OrchestrationProjectOwnership,
  type ServerAuthDescriptor,
  type WorkspaceSource,
} from "@t3tools/contracts";

/**
 * What a project's kind *says*, in the words a person reads when they choose it.
 *
 * The kinds themselves are a contract (`ProjectKind` in
 * `packages/contracts/src/orchestration.ts`) and the server already decides what
 * it will accept. What lives here is the other half: which kinds this instance
 * can honestly offer, and the sentence each one is worth.
 *
 * It is one module rather than two hand-written lists because both surfaces that
 * add a project — the workspace dashboard and the command palette — ask exactly
 * this question, and two copies of the copy would disagree the first time a word
 * changed. The copy is the feature. The confusion this whole thing exists to fix
 * is "I cannot tell what is on my laptop and what is not", and a control that
 * says `hosted` without saying what happens when the lid shuts fixes nothing.
 *
 * Deliberately a plain module with no React in it, in the same spirit as the
 * other `*.logic.ts` files beside it: the rules about which kinds an instance can
 * offer are the part worth testing, and they should be testable without a DOM.
 */

/**
 * The kinds a person may ask for when they create a project.
 *
 * `joined` is absent on purpose and is not an oversight. A joined project is one
 * somebody else shared; it arrives through a share link, and the server refuses
 * `project.create` with that kind outright (`decideProjectKindRefusal` in
 * `apps/server/src/orchestration/projectKindRules.ts`). Offering it here would
 * put a button in front of somebody whose only possible outcome is a refusal
 * sentence. Sharing and creating stay different acts, which is the same line
 * docs/web-and-cloud-scope.md draws between sharing and pairing.
 */
export const CREATABLE_PROJECT_KINDS = ["local", "hosted", "self-hosted"] as const;

export type CreatableProjectKind = (typeof CREATABLE_PROJECT_KINDS)[number];

/**
 * What a project defaults to when nobody has chosen yet.
 *
 * `local` for the same asymmetry `resolveProjectKind` is built on: it is the only
 * one of the kinds that promises less than the truth. A default that quietly
 * uploaded somebody's files would be the worst kind of surprise — it is not
 * undoable by unchecking a box afterwards, because by then the files have left
 * the machine. It is also simply what every project in existence today is.
 */
export const DEFAULT_PROJECT_KIND: CreatableProjectKind = "local";

export interface ProjectKindChoice {
  readonly kind: CreatableProjectKind;
  /** The two or three words on the control itself. */
  readonly label: string;
  /** Where the files live. Present tense, no jargon, no schema words. */
  readonly whereFilesLive: string;
  /** What happens when their computer is off. The sentence people came for. */
  readonly whenComputerIsOff: string;
  /**
   * `true` when this instance can actually make a project of this kind.
   * An unavailable choice is still returned, and still shown, because "hosted
   * is missing" and "hosted is impossible here, and here is why" are very
   * different answers to give somebody hunting for it.
   */
  readonly available: boolean;
  /** Why not, in a sentence, or `null` when it is available. */
  readonly unavailableReason: string | null;
}

/**
 * The copy, written once.
 *
 * Each entry answers the same two questions in the same order, because the
 * comparison is the point: a person reading three of these down a list is trying
 * to work out which one describes what they want, and they can only do that if
 * the three say comparable things.
 */
const PROJECT_KIND_COPY: Record<
  CreatableProjectKind,
  Pick<ProjectKindChoice, "label" | "whereFilesLive" | "whenComputerIsOff">
> = {
  local: {
    label: "On this computer",
    whereFilesLive: "The files stay in this folder, on this computer, and nothing is uploaded.",
    whenComputerIsOff: "Nobody else can reach it, and when this computer is off it is gone.",
  },
  hosted: {
    label: "Hosted on LogicPacks",
    whereFilesLive:
      "The files move to LogicPacks and the work happens there, not on this computer.",
    whenComputerIsOff: "It stays reachable when this computer is off.",
  },
  "self-hosted": {
    label: "Shared from this computer",
    whereFilesLive:
      "The files stay in this folder, on this computer, and people you invite work on them here.",
    whenComputerIsOff: "When this computer is off, nobody can reach it, including you.",
  },
};

/**
 * Why `hosted` is not on offer, when it is not.
 *
 * Both sentences name the thing that is missing rather than the flag that is
 * false, because the person reading them can act on the first and not the
 * second.
 */
const HOSTED_NEEDS_A_WORKSPACE_SERVER =
  "This server holds accounts rather than projects, so it has nowhere to put a hosted project. The projects live on the environment paired with it.";

const HOSTED_NEEDS_A_CLOUD_WORKSPACE =
  "Hosting moves the files into a shared workspace, and this project is not being added to one. Add it to a workspace to host it.";

export interface ProjectKindAvailability {
  /**
   * `this-server` or `paired-environment`, resolved through the contract's
   * `resolveWorkspaceSource` rather than read off the field — the field is
   * optional and its absence means `this-server`.
   */
  readonly workspaceSource: WorkspaceSource;
  /**
   * Whether there is a cloud workspace to sync into at all. Cloud sync is scoped
   * to a tenant workspace (`useProjectCloudSyncScope`: "a project with no
   * ownership is not in a shared workspace at all, and there is nothing to sync
   * it to"), so a project being created outside one has nowhere to be hosted.
   */
  readonly cloudSyncConfigured: boolean;
}

/**
 * The two inputs, derived from what the surfaces already hold.
 *
 * Both callers have an auth descriptor for the environment they are creating on
 * and an ownership for the workspace they are creating into, and neither should
 * be re-deciding what those two mean. `hosted` is cloud sync's `handoff` mode
 * over a workspace that is not this machine (docs/cloud-sync-spec.md), so the
 * question "can this instance host" is exactly "is there a workspace to hand off
 * to, on a server that keeps projects".
 */
export function resolveProjectKindAvailability(input: {
  readonly auth: Pick<ServerAuthDescriptor, "workspaceSource"> | null | undefined;
  readonly ownership: OrchestrationProjectOwnership | null | undefined;
}): ProjectKindAvailability {
  return {
    workspaceSource: resolveWorkspaceSource(input.auth ?? undefined),
    cloudSyncConfigured: input.ownership != null,
  };
}

/**
 * Every creatable kind, in reading order, each with its copy and whether this
 * instance can honestly offer it.
 *
 * `local` is always available, and that is not a special case being smuggled in:
 * a folder on the machine the environment runs on is the one thing that is true
 * of every instance, including one that can do nothing else.
 */
export function resolveProjectKindChoices(
  availability: ProjectKindAvailability,
): readonly ProjectKindChoice[] {
  const hostedRefusal =
    availability.workspaceSource === "paired-environment"
      ? HOSTED_NEEDS_A_WORKSPACE_SERVER
      : !availability.cloudSyncConfigured
        ? HOSTED_NEEDS_A_CLOUD_WORKSPACE
        : null;

  return CREATABLE_PROJECT_KINDS.map((kind) => {
    const unavailableReason = kind === "hosted" ? hostedRefusal : null;
    return {
      kind,
      ...PROJECT_KIND_COPY[kind],
      available: unavailableReason === null,
      unavailableReason,
    };
  });
}

/**
 * Hold a person's choice only for as long as it stays true.
 *
 * Both surfaces let the target change after the choice is made — the palette lets
 * somebody pick an environment and then another one, and the dashboard opens the
 * palette with a kind already chosen for a workspace. A selection that silently
 * survived that would either dispatch a kind the server refuses, or, worse,
 * quietly create a hosted project somewhere the person did not mean. Falling back
 * to `local` is the same understatement the default is: it is always true, and
 * being talked down to `local` costs a correction rather than a surprise upload.
 */
export function resolveSelectedProjectKind(
  availability: ProjectKindAvailability,
  desired: CreatableProjectKind | null | undefined,
): CreatableProjectKind {
  if (desired == null) {
    return DEFAULT_PROJECT_KIND;
  }
  const choice = resolveProjectKindChoices(availability).find((entry) => entry.kind === desired);
  return choice?.available === true ? desired : DEFAULT_PROJECT_KIND;
}

/**
 * The one sentence worth putting under a control, when there is only room for
 * one. Both halves, in the order a person needs them: where it is, then what
 * happens when the laptop shuts.
 */
export function describeProjectKindChoice(choice: ProjectKindChoice): string {
  return `${choice.whereFilesLive} ${choice.whenComputerIsOff}`;
}
