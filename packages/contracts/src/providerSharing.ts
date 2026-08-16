import { Schema } from "effect";

import {
  IsoDateTime,
  ProviderAccountId,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";

/**
 * The providers the on-disk provider-auth store knows about, named the way the
 * store names its directories (`provider-auth/<slug>/codex`, `.../claude`).
 *
 * Deliberately not `ProviderKind` from `orchestration.ts`, which spells the
 * second one `claudeAgent`: that literal is the orchestration runtime's name
 * for an agent, and it is persisted in threads and events. These two travel
 * together but change for different reasons — a new agent runtime does not
 * imply a new credential directory — so they stay separate rather than one
 * being derived from the other. Anything crossing between them must map
 * explicitly, which is the point.
 */
export const ProviderAuthKind = Schema.Literals(["codex", "claude"]);
export type ProviderAuthKind = typeof ProviderAuthKind.Type;

/** What a single member runs on: their own credential, or the workspace's. */
export const ProviderAccessMode = Schema.Literals(["own", "workspace"]);
export type ProviderAccessMode = typeof ProviderAccessMode.Type;

/** What members get by default when no grant names them individually. */
export const ProviderPolicyMode = Schema.Literals(["own", "shared"]);
export type ProviderPolicyMode = typeof ProviderPolicyMode.Type;

/**
 * One credential a user has connected. `label` is how a person tells two of
 * their own accounts apart; the token, cookie or auth.json behind it never
 * leaves the server, so nothing on this struct — or any struct in this file —
 * carries credential material.
 */
export const ProviderConnectedAccount = Schema.Struct({
  accountId: ProviderAccountId,
  provider: ProviderAuthKind,
  label: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  /** The one used when nothing names an account explicitly. */
  isDefault: Schema.Boolean,
});
export type ProviderConnectedAccount = typeof ProviderConnectedAccount.Type;

/**
 * An owner's decision to let one workspace run turns on one of their accounts.
 *
 * Keyed by workspace rather than tenant because a tenant is a billing and
 * identity boundary while a workspace is the unit people actually work in:
 * someone contributing their personal Claude account to one team's workspace
 * has said nothing about the other workspaces in the same tenant. Widening the
 * key to the tenant would silently hand every workspace the credential.
 *
 * `enabled: false` is kept rather than deleted so the switch survives a policy
 * still pointing at this account — the off switch has to be able to win.
 */
export const ProviderAccountShare = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  ownerUserId: UserId,
  provider: ProviderAuthKind,
  accountId: ProviderAccountId,
  enabled: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ProviderAccountShare = typeof ProviderAccountShare.Type;

/**
 * The workspace-wide default for one provider, and which contributed account
 * `shared` mode actually runs on. Both pointers are null under `own` mode, and
 * a `shared` policy whose named account has been unshared or disconnected is
 * not repaired here — resolution falls back at turn time instead, so a
 * momentary disconnect does not quietly rewrite an admin's choice.
 */
export const ProviderWorkspacePolicy = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  provider: ProviderAuthKind,
  mode: ProviderPolicyMode,
  sharedOwnerUserId: Schema.NullOr(UserId),
  sharedAccountId: Schema.NullOr(ProviderAccountId),
  updatedAt: IsoDateTime,
});
export type ProviderWorkspacePolicy = typeof ProviderWorkspacePolicy.Type;

/** An admin's per-member override of the workspace default. */
export const ProviderMemberGrant = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  provider: ProviderAuthKind,
  access: ProviderAccessMode,
  updatedAt: IsoDateTime,
});
export type ProviderMemberGrant = typeof ProviderMemberGrant.Type;

/**
 * One roster row per connected account in the workspace, so an admin can pick
 * the account a `shared` policy runs on without having to ask each owner what
 * they have. It joins the account index to the member list, which is why it
 * carries `displayName` — the roster is the only place both are known.
 *
 * Admin-only, and labels only: knowing that Ana has a "work" Codex account is
 * what an admin needs to choose one; the credential itself is never part of
 * the answer, and no field here can be widened into one.
 */
export const ProviderWorkspaceAccount = Schema.Struct({
  userId: UserId,
  displayName: TrimmedNonEmptyString,
  provider: ProviderAuthKind,
  accountId: ProviderAccountId,
  label: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  /** The owner has switched this account on for this workspace. */
  isShared: Schema.Boolean,
  /** The workspace policy currently names this account. */
  isWorkspaceDefault: Schema.Boolean,
});
export type ProviderWorkspaceAccount = typeof ProviderWorkspaceAccount.Type;

export class ProviderSharingError extends Schema.TaggedErrorClass<ProviderSharingError>()(
  "ProviderSharingError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "forbidden",
      "workspace-not-found",
      "member-not-found",
      "account-not-found",
      /** A policy named an account whose owner has not shared it here. */
      "account-not-shared",
      /** `shared` mode with no account named, or `own` mode with one. */
      "invalid-policy",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProviderSharingOverviewGetInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type ProviderSharingOverviewGetInput = typeof ProviderSharingOverviewGetInput.Type;

/**
 * One read that powers the whole panel. Split into viewer-scoped and
 * workspace-scoped halves because every member may see what applies to them,
 * while the last three fields are an admin view of other people's accounts and
 * come back empty — not omitted — for everyone else, so the client renders the
 * same shape either way and never infers permission from a missing field.
 */
export const ProviderSharingOverviewResult = Schema.Struct({
  viewerUserId: UserId,
  /** Whether the viewer may set the policy and other members' grants. */
  canManage: Schema.Boolean,
  viewerAccounts: Schema.Array(ProviderConnectedAccount),
  viewerShares: Schema.Array(ProviderAccountShare),
  /** Only the grants naming the viewer: what actually applies to them. */
  viewerGrants: Schema.Array(ProviderMemberGrant),
  policies: Schema.Array(ProviderWorkspacePolicy),
  /** Every member's grant. Empty unless `canManage`. */
  grants: Schema.Array(ProviderMemberGrant),
  /** Empty unless `canManage`. */
  workspaceAccounts: Schema.Array(ProviderWorkspaceAccount),
});
export type ProviderSharingOverviewResult = typeof ProviderSharingOverviewResult.Type;

/**
 * No `ownerUserId`: the caller is always the owner. Letting the input name a
 * different one would make contributing someone else's credential a matter of
 * editing a field.
 */
export const ProviderSharingShareUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  provider: ProviderAuthKind,
  accountId: ProviderAccountId,
  enabled: Schema.Boolean,
});
export type ProviderSharingShareUpdateInput = typeof ProviderSharingShareUpdateInput.Type;

export const ProviderSharingShareUpdateResult = Schema.Struct({
  share: ProviderAccountShare,
});
export type ProviderSharingShareUpdateResult = typeof ProviderSharingShareUpdateResult.Type;

/**
 * The two pointers are optional-and-nullable rather than plain optional: an
 * explicit null clears the pinned account when switching back to `own`, which
 * an absent field cannot express against a stored row.
 */
export const ProviderSharingPolicyUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  provider: ProviderAuthKind,
  mode: ProviderPolicyMode,
  sharedOwnerUserId: Schema.optional(Schema.NullOr(UserId)),
  sharedAccountId: Schema.optional(Schema.NullOr(ProviderAccountId)),
});
export type ProviderSharingPolicyUpdateInput = typeof ProviderSharingPolicyUpdateInput.Type;

export const ProviderSharingPolicyUpdateResult = Schema.Struct({
  policy: ProviderWorkspacePolicy,
});
export type ProviderSharingPolicyUpdateResult = typeof ProviderSharingPolicyUpdateResult.Type;

export const ProviderSharingMemberUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  provider: ProviderAuthKind,
  access: ProviderAccessMode,
});
export type ProviderSharingMemberUpdateInput = typeof ProviderSharingMemberUpdateInput.Type;

export const ProviderSharingMemberUpdateResult = Schema.Struct({
  grant: ProviderMemberGrant,
});
export type ProviderSharingMemberUpdateResult = typeof ProviderSharingMemberUpdateResult.Type;
