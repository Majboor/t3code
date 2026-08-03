import type {
  CollaborationActivity,
  CollaborationActivityListInput,
  CollaborationActivityListResult,
  CollaborationError,
  CollaborationInviteAcceptInput,
  CollaborationInviteAcceptResult,
  CollaborationInviteCreateInput,
  CollaborationInviteCreateResult,
  CollaborationInviteListInput,
  CollaborationInviteListResult,
  CollaborationInviteRevokeInput,
  CollaborationInviteRevokeResult,
  CollaborationPresenceListInput,
  CollaborationPresenceListResult,
  CollaborationPresenceUpsertInput,
  CollaborationPresenceUpsertResult,
  CollaborationSharedPromptRecordInput,
  CollaborationSharedPromptRecordResult,
  CollaborationStreamEvent,
  CollaborationStreamInput,
  TenantInvite,
  TenantMembership,
  UserId,
} from "@t3tools/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface CollaborationActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
}

export interface CollaborationServiceShape {
  readonly upsertPresence: (
    actor: CollaborationActor,
    input: CollaborationPresenceUpsertInput,
  ) => Effect.Effect<CollaborationPresenceUpsertResult, CollaborationError>;

  readonly listPresence: (
    input: CollaborationPresenceListInput,
  ) => Effect.Effect<CollaborationPresenceListResult, CollaborationError>;

  readonly createInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteCreateInput,
  ) => Effect.Effect<CollaborationInviteCreateResult, CollaborationError>;

  readonly listInvites: (
    input: CollaborationInviteListInput,
  ) => Effect.Effect<CollaborationInviteListResult, CollaborationError>;

  readonly acceptInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteAcceptInput,
  ) => Effect.Effect<CollaborationInviteAcceptResult, CollaborationError>;

  readonly revokeInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteRevokeInput,
  ) => Effect.Effect<CollaborationInviteRevokeResult, CollaborationError>;

  readonly recordSharedPrompt: (
    actor: CollaborationActor,
    input: CollaborationSharedPromptRecordInput,
  ) => Effect.Effect<CollaborationSharedPromptRecordResult, CollaborationError>;

  readonly listActivity: (
    input: CollaborationActivityListInput,
  ) => Effect.Effect<CollaborationActivityListResult, CollaborationError>;

  readonly stream: (
    input: CollaborationStreamInput,
  ) => Stream.Stream<CollaborationStreamEvent, CollaborationError>;
}

export interface CollaborationState {
  readonly presence: ReadonlyMap<string, CollaborationPresenceUpsertResult["presence"]>;
  readonly invites: ReadonlyMap<string, TenantInvite>;
  readonly memberships: ReadonlyMap<string, TenantMembership>;
  readonly activities: ReadonlyArray<CollaborationActivity>;
}

export class CollaborationService extends Context.Service<
  CollaborationService,
  CollaborationServiceShape
>()("t3/collaboration/Services/CollaborationService") {}
