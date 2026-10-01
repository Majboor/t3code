import type {
  ProviderAccessMode,
  ProviderAuthKind,
  ProviderConnectedAccount,
  ProviderPolicyMode,
  ProviderSharingOverviewResult,
  ProviderWorkspaceAccount,
} from "@t3tools/contracts";

/**
 * Claude first because it is the provider people are most likely to be paying
 * for personally, and therefore the one the contribute switch is about.
 */
export const PROVIDERS: readonly ProviderAuthKind[] = ["claude", "codex"];

export const PROVIDER_LABEL: Record<ProviderAuthKind, string> = {
  claude: "Claude",
  codex: "Codex",
};

export interface ViewerProviderSharing {
  readonly provider: ProviderAuthKind;
  /** Only genuinely connected accounts — the server sends nothing else. */
  readonly accounts: readonly ProviderConnectedAccount[];
  readonly isSharing: boolean;
  /** The account the switch contributes, or would contribute if switched on. */
  readonly selectedAccount: ProviderConnectedAccount | null;
  /**
   * Sharing is on but the contributed account has since been disconnected. The
   * workspace gets nothing from it, and only the owner can see why.
   */
  readonly sharedAccountMissing: boolean;
  /** What this person's own turns run on here, by the server's own precedence. */
  readonly access: ProviderAccessMode;
}

/**
 * What one provider looks like to the person reading the panel.
 *
 * `access` repeats the server's rule — an explicit grant wins, otherwise the
 * workspace default — rather than inventing a second one, because a panel that
 * disagrees with the turn is worse than a panel that says nothing.
 */
export function readViewerSharing(
  overview: ProviderSharingOverviewResult,
  provider: ProviderAuthKind,
): ViewerProviderSharing {
  const accounts = overview.viewerAccounts.filter((account) => account.provider === provider);
  const share = overview.viewerShares.find((entry) => entry.provider === provider) ?? null;
  const shared = share ? (accounts.find((a) => a.accountId === share.accountId) ?? null) : null;
  const fallback = accounts.find((account) => account.isDefault) ?? accounts[0] ?? null;
  const isSharing = share?.enabled === true;

  const policy = overview.policies.find((entry) => entry.provider === provider) ?? null;
  const grant = overview.viewerGrants.find((entry) => entry.provider === provider) ?? null;

  return {
    provider,
    accounts,
    isSharing,
    selectedAccount: shared ?? fallback,
    sharedAccountMissing: isSharing && shared === null,
    access: grant?.access ?? (policy?.mode === "shared" ? "workspace" : "own"),
  };
}

export interface WorkspaceProviderPolicy {
  readonly provider: ProviderAuthKind;
  readonly mode: ProviderPolicyMode;
  /** The account the policy names, when it is still in the workspace roster. */
  readonly account: ProviderWorkspaceAccount | null;
  /**
   * `no-account` — the named account is gone entirely (disconnected).
   * `not-shared` — it is still connected but its owner has withdrawn it.
   * Either way turns fall back to each member's own account.
   */
  readonly problem: "no-account" | "not-shared" | null;
  /** The accounts an admin may point the workspace at right now. */
  readonly candidates: readonly ProviderWorkspaceAccount[];
}

export function readWorkspacePolicy(
  overview: ProviderSharingOverviewResult,
  provider: ProviderAuthKind,
): WorkspaceProviderPolicy {
  const policy = overview.policies.find((entry) => entry.provider === provider) ?? null;
  const forProvider = overview.workspaceAccounts.filter((account) => account.provider === provider);
  const named =
    policy?.sharedOwnerUserId && policy.sharedAccountId
      ? (forProvider.find(
          (account) =>
            account.userId === policy.sharedOwnerUserId &&
            account.accountId === policy.sharedAccountId,
        ) ?? null)
      : null;
  const mode = policy?.mode ?? "own";

  return {
    provider,
    mode,
    account: named,
    problem:
      mode !== "shared"
        ? null
        : named === null
          ? "no-account"
          : named.isShared
            ? null
            : "not-shared",
    candidates: forProvider.filter((account) => account.isShared),
  };
}

export interface MemberProviderAccess {
  readonly access: ProviderAccessMode;
  /** False when nothing names this person and they follow the workspace default. */
  readonly isExplicit: boolean;
}

export function readMemberAccess(
  overview: ProviderSharingOverviewResult,
  userId: string,
  provider: ProviderAuthKind,
): MemberProviderAccess {
  const grant = overview.grants.find(
    (entry) => entry.userId === userId && entry.provider === provider,
  );
  if (grant) {
    return { access: grant.access, isExplicit: true };
  }
  const policy = overview.policies.find((entry) => entry.provider === provider) ?? null;
  return { access: policy?.mode === "shared" ? "workspace" : "own", isExplicit: false };
}

export interface WorkspaceBacking {
  /** Which providers' turns this workspace currently runs on their account. */
  readonly providers: readonly ProviderAuthKind[];
  /**
   * `null` for a member who cannot see the workspace roster. The policy names
   * the owner to everybody, but only an admin is sent the account index that
   * turns a user id into a name, so the badge stays unnamed rather than
   * printing a raw id at somebody who has no way to read it.
   */
  readonly displayName: string | null;
  /**
   * The account labels backing each provider, in `providers` order. Labels
   * only — the credential itself is never part of the overview, and nothing
   * here may be widened into one. Empty for a member who cannot see the roster.
   */
  readonly accountLabels: readonly string[];
  readonly isViewer: boolean;
  /**
   * The policy still names them but the account has been disconnected or
   * withdrawn, so turns are already falling back to each member's own. Only an
   * admin can see this: without the roster there is no account to compare the
   * policy against, and guessing would accuse a working contributor of a fault.
   */
  readonly broken: boolean;
}

export interface WorkspaceCarrier extends WorkspaceBacking {
  readonly userId: string;
}

interface CarrierDraft {
  providers: ProviderAuthKind[];
  labels: string[];
  broken: boolean;
  name: string | null;
}

/**
 * Who is actually paying for this workspace's turns.
 *
 * Read off `policies`, not off `isWorkspaceDefault`, for two reasons. The
 * policy is sent to every member while the account roster is admin-only, so
 * this is the one rule that answers the question for everybody. And it is the
 * same rule the turn resolver uses — `shared` mode with an owner named — so a
 * badge can never claim somebody's quota is being spent when it is not; the
 * roster flag is set from the policy's pointers without checking the mode, so
 * it can still be true on an account a policy has stopped spending.
 *
 * Sharing an account and backing the workspace are deliberately kept apart
 * here. Somebody who has switched their account on has offered it; until the
 * policy names it, nothing of theirs is being spent, and badging the offer
 * would point the whole workspace's gratitude — and its "can I have some too" —
 * at the wrong person.
 */
export function readWorkspaceCarriers(
  overview: ProviderSharingOverviewResult,
): readonly WorkspaceCarrier[] {
  const byUser = new Map<string, CarrierDraft>();

  for (const provider of PROVIDERS) {
    const policy = overview.policies.find((entry) => entry.provider === provider) ?? null;
    if (!policy || policy.mode !== "shared" || policy.sharedOwnerUserId === null) {
      continue;
    }
    const ownerId = policy.sharedOwnerUserId as string;
    const account =
      policy.sharedAccountId === null
        ? null
        : (overview.workspaceAccounts.find(
            (entry) =>
              entry.provider === provider &&
              (entry.userId as string) === ownerId &&
              entry.accountId === policy.sharedAccountId,
          ) ?? null);

    const draft = byUser.get(ownerId) ?? { providers: [], labels: [], broken: false, name: null };
    draft.providers.push(provider);
    if (account) {
      draft.labels.push(account.label);
      draft.name = account.displayName;
      // `isShared` false is the owner having withdrawn the account under a
      // policy that still points at it: turns fall back, and an admin is the
      // only person who can put it right, so only they are told.
      draft.broken = draft.broken || !account.isShared;
    } else if (overview.canManage) {
      // The roster is visible and still has no such account: it is gone.
      draft.broken = true;
    }
    byUser.set(ownerId, draft);
  }

  return [...byUser.entries()].map(([userId, draft]) => ({
    userId,
    providers: draft.providers,
    displayName: draft.name,
    accountLabels: draft.labels,
    isViewer: userId === (overview.viewerUserId as string),
    broken: draft.broken,
  }));
}

/**
 * The badge for one roster row, or null when that person carries nothing.
 *
 * Separate from {@link readWorkspaceCarriers} so a member list can ask about
 * one person without re-deriving the rule, and so the two can never disagree:
 * this is a lookup into that same answer, not a second implementation of it.
 */
export function readMemberBacking(
  overview: ProviderSharingOverviewResult,
  userId: string,
): WorkspaceBacking | null {
  return readWorkspaceCarriers(overview).find((entry) => entry.userId === userId) ?? null;
}

/**
 * What the badge says. One short phrase, because it sits on a roster row next
 * to a name and has to be readable at a glance: "Backing Claude", or both.
 */
export function describeBacking(backing: WorkspaceBacking): string {
  const names = backing.providers.map((provider) => PROVIDER_LABEL[provider]);
  return `Backing ${names.length === 2 ? `${names[0]} and ${names[1]}` : names.join("")}`;
}
