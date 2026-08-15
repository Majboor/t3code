import type {
  CollaborationConsentResult,
  CollaborationConsentUpdateInput,
  EnvironmentId,
  OrchestrationProjectOwnership,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";

/**
 * One (tenant, workspace) a consent record can be written against, plus the
 * environment whose connection can write it.
 */
export interface UsagePrivacyScope {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly tenantName: string;
  readonly workspaceName: string;
  readonly label: string;
}

interface ScopedProjectLike {
  readonly environmentId: EnvironmentId;
  readonly ownership?: OrchestrationProjectOwnership | null | undefined;
}

/** Stable across re-renders so it can back a `<Select value>`. */
function scopeKey(
  environmentId: EnvironmentId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
): string {
  return `${environmentId}::${tenantId}::${workspaceId}`;
}

/**
 * The workspaces this session could set a usage-sharing choice in.
 *
 * Settings is not scoped to a project the way the thread header is, so the
 * scopes have to come from what the session can already see: the ownership
 * stamped on its projects. Projects without ownership are skipped rather than
 * guessed at — a local project belongs to no workspace, and inventing a
 * workspace id for it would write consent nobody can read.
 */
export function listUsagePrivacyScopes(
  projects: readonly ScopedProjectLike[],
): readonly UsagePrivacyScope[] {
  const byKey = new Map<string, UsagePrivacyScope>();
  for (const project of projects) {
    const ownership = project.ownership;
    if (!ownership) continue;
    const key = scopeKey(project.environmentId, ownership.tenantId, ownership.workspaceId);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      environmentId: project.environmentId,
      tenantId: ownership.tenantId,
      workspaceId: ownership.workspaceId,
      tenantName: ownership.tenantDisplayName,
      workspaceName: ownership.workspaceTitle,
      label: `${ownership.tenantDisplayName} · ${ownership.workspaceTitle}`,
    });
  }
  return [...byKey.values()];
}

/**
 * Which workspace the toggle is currently talking about.
 *
 * With several workspaces this stays null until the person picks one. Consent
 * is per workspace, so defaulting to whichever project loaded first would show
 * one workspace's answer and silently write another's.
 */
export function resolveUsagePrivacyScope(
  scopes: readonly UsagePrivacyScope[],
  selectedKey: string | null,
): UsagePrivacyScope | null {
  if (selectedKey !== null) {
    return scopes.find((scope) => scope.key === selectedKey) ?? null;
  }
  return scopes.length === 1 ? (scopes[0] ?? null) : null;
}

/** Keeps a stored selection only while it still names a workspace we can see. */
export function reconcileSelectedScopeKey(
  scopes: readonly UsagePrivacyScope[],
  selectedKey: string | null,
): string | null {
  if (selectedKey === null) return null;
  return scopes.some((scope) => scope.key === selectedKey) ? selectedKey : null;
}

export interface UsageSharingState {
  /** Where to draw the switch right now. */
  readonly shareUsage: boolean;
  /** Carried, never rendered — the update input needs it back unchanged. */
  readonly shareProfile: boolean;
  /** False when this is the workspace default rather than a stated choice. */
  readonly isDecided: boolean;
}

/**
 * `effective` is the whole answer: the server already folded the defaults in,
 * including usage sharing being on for anyone who was never asked. `consent`
 * only survives here as the decided/defaulted distinction, which the copy uses.
 */
export function deriveUsageSharingState(result: CollaborationConsentResult): UsageSharingState {
  return {
    shareUsage: result.effective.shareUsage,
    shareProfile: result.effective.shareProfile,
    isDecided: result.effective.isDecided,
  };
}

/**
 * `updateConsent` writes both flags at once, so the profile flag has to be sent
 * back exactly as it stands. Sending anything else here — a literal `false`, or
 * a stale copy — turns a usage decision into an email-sharing decision.
 *
 * For an undecided member `state.shareProfile` is the default rather than their
 * choice, and writing it back changes nothing they can observe: it stores the
 * value that already applied to them.
 */
export function buildUsageConsentUpdate(input: {
  readonly scope: UsagePrivacyScope;
  readonly state: UsageSharingState;
  readonly shareUsage: boolean;
}): CollaborationConsentUpdateInput {
  return {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    shareProfile: input.state.shareProfile,
    shareUsage: input.shareUsage,
  };
}

/**
 * The line under the toggle. It has to be honest about two things the switch
 * cannot show: whether this is a default or their own choice, and that turning
 * it off hides the numbers from members, not from the workspace's bill.
 */
export function describeUsageSharing(state: UsageSharingState, scope: UsagePrivacyScope): string {
  if (state.shareUsage) {
    return state.isDecided
      ? `Shared with ${scope.workspaceName}. You chose this.`
      : `Shared with ${scope.workspaceName}. This is the default — you have not changed it.`;
  }
  return `Hidden from other members of ${scope.workspaceName}. You still see your own numbers, and workspace billing still counts them.`;
}
