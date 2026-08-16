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
