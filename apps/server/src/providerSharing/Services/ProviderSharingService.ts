import type {
  ProviderSharingError,
  ProviderSharingMemberUpdateInput,
  ProviderSharingMemberUpdateResult,
  ProviderSharingOverviewGetInput,
  ProviderSharingOverviewResult,
  ProviderSharingPolicyUpdateInput,
  ProviderSharingPolicyUpdateResult,
  ProviderSharingShareUpdateInput,
  ProviderSharingShareUpdateResult,
  UserId,
} from "@t3tools/contracts";
import { Context, type Effect } from "effect";

/**
 * Whoever the panel is being drawn for.
 *
 * Structurally the collaboration actor, and deliberately so: the admin roster
 * is the collaboration member list joined to the account index, so the same
 * person has to be recognisable to both. Nothing here is taken from the wire —
 * the caller's identity comes from the session, which is what makes
 * "contribute my account" a statement the sender can only make about
 * themselves.
 */
export interface ProviderSharingActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
}

export interface ProviderSharingServiceShape {
  /**
   * One read behind the whole panel. The workspace-scoped halves come back
   * empty rather than absent for a member who may not manage, so the client
   * renders the same shape for everybody.
   */
  readonly getOverview: (
    actor: ProviderSharingActor,
    input: ProviderSharingOverviewGetInput,
  ) => Effect.Effect<ProviderSharingOverviewResult, ProviderSharingError>;

  /** The caller lends, or stops lending, one of their own accounts. */
  readonly updateShare: (
    actor: ProviderSharingActor,
    input: ProviderSharingShareUpdateInput,
  ) => Effect.Effect<ProviderSharingShareUpdateResult, ProviderSharingError>;

  /** An admin picks what the workspace runs on by default. */
  readonly updatePolicy: (
    actor: ProviderSharingActor,
    input: ProviderSharingPolicyUpdateInput,
  ) => Effect.Effect<ProviderSharingPolicyUpdateResult, ProviderSharingError>;

  /** An admin overrides that default for one member. */
  readonly updateMemberAccess: (
    actor: ProviderSharingActor,
    input: ProviderSharingMemberUpdateInput,
  ) => Effect.Effect<ProviderSharingMemberUpdateResult, ProviderSharingError>;
}

export class ProviderSharingService extends Context.Service<
  ProviderSharingService,
  ProviderSharingServiceShape
>()("t3/providerSharing/Services/ProviderSharingService") {}
