import {
  CollaborationError,
  InviteId,
  MembershipId,
  type CollaborationStreamEvent,
  type TenantInvite,
  type TenantMembership,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  type CollaborationActor,
  CollaborationService,
  type CollaborationServiceShape,
  type CollaborationState,
} from "../Services/CollaborationService.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";

const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function presenceKey(input: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly userId: string;
}): string {
  return [input.tenantId, input.workspaceId, input.threadId ?? "", input.userId].join(":");
}

function inviteAcceptUrlPath(inviteId: string): string {
  const search = new URLSearchParams([["invite", inviteId]]);
  return `/invite?${search.toString()}`;
}

function validateInviteScope(input: {
  readonly scope: "tenant" | "workspace" | "project";
  readonly workspaceId: string | null;
}) {
  if ((input.scope === "workspace" || input.scope === "project") && input.workspaceId === null) {
    return Effect.fail(
      new CollaborationError({
        code: "invalid-membership-rule",
        message: "Workspace-scoped collaboration invites must include a workspace.",
      }),
    );
  }
  return Effect.void;
}

function toPromptSummary(actor: CollaborationActor, prompt: string): string {
  const normalizedPrompt = prompt.trim().replace(/\s+/g, " ");
  const excerpt =
    normalizedPrompt.length > 96
      ? `${normalizedPrompt.slice(0, 93).trimEnd()}...`
      : normalizedPrompt;
  return `${actor.displayName} shared a prompt: ${excerpt}`;
}

function appendActivity(
  state: CollaborationState,
  activity: CollaborationState["activities"][number],
): CollaborationState {
  return {
    ...state,
    activities: [...state.activities.slice(-999), activity],
  };
}

const makeCollaborationService = Effect.gen(function* () {
  const repository = yield* TenancyRepository;
  const persisted = yield* repository.loadCollaboration().pipe(
    Effect.mapError(
      (cause) =>
        new CollaborationError({
          code: "invalid-membership-rule",
          message: "Failed to load persisted collaboration state.",
          cause,
        }),
    ),
  );
  const events = yield* PubSub.unbounded<CollaborationStreamEvent>();
  const stateRef = yield* Ref.make<CollaborationState>({
    presence: new Map(
      persisted.presence.map((presence) => [
        presenceKey({
          tenantId: presence.tenantId,
          workspaceId: presence.workspaceId,
          threadId: presence.threadId,
          userId: presence.userId,
        }),
        presence,
      ]),
    ),
    invites: new Map(persisted.invites.map((invite) => [invite.id, invite])),
    memberships: new Map(
      persisted.memberships
        .filter((membership) => membership.organizationId === null)
        .map((membership) => [membership.id, membership]),
    ),
    activities: persisted.activities,
  });

  const persist = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      repository.saveCollaboration({
        presence: Array.from(state.presence.values()),
        invites: Array.from(state.invites.values()),
        memberships: Array.from(state.memberships.values()),
        activities: state.activities,
      }),
    ),
    Effect.mapError(
      (cause) =>
        new CollaborationError({
          code: "invalid-membership-rule",
          message: "Failed to persist collaboration state.",
          cause,
        }),
    ),
  );

  const upsertPresence: CollaborationServiceShape["upsertPresence"] = (actor, input) => {
    const createdAt = nowIso();
    const presence = {
      userId: actor.userId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      displayName: actor.displayName,
      ...(actor.avatarInitials ? { avatarInitials: actor.avatarInitials } : {}),
      status: input.status,
      lastSeenAt: createdAt,
    };
    return Ref.update(stateRef, (state) => {
      const nextPresence = new Map(state.presence);
      nextPresence.set(
        presenceKey({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          userId: actor.userId,
        }),
        presence,
      );

      const activityKind = input.status === "offline" ? "left" : "joined";
      return appendActivity(
        {
          ...state,
          presence: nextPresence,
        },
        {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          userId: actor.userId,
          kind: activityKind,
          summary:
            input.status === "offline"
              ? `${actor.displayName} left the workspace.`
              : `${actor.displayName} is present in the workspace.`,
          createdAt,
        },
      );
    }).pipe(
      Effect.flatMap(() => persist),
      Effect.tap(() => PubSub.publish(events, { type: "presence-upserted", presence })),
      Effect.as({ presence }),
    );
  };

  const listPresence: CollaborationServiceShape["listPresence"] = (input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => ({
        users: Array.from(state.presence.values()).filter(
          (presence) =>
            presence.tenantId === input.tenantId &&
            presence.workspaceId === input.workspaceId &&
            (input.threadId === undefined || presence.threadId === input.threadId),
        ),
      })),
    );

  const createInvite: CollaborationServiceShape["createInvite"] = (actor, input) =>
    Effect.gen(function* () {
      yield* validateInviteScope(input);
      const createdAt = nowIso();
      const invite: TenantInvite = {
        id: InviteId.make(`invite:${crypto.randomUUID()}`),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        invitedByUserId: actor.userId,
        email: input.email,
        scope: input.scope,
        roles: input.roles,
        createdAt,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        revokedAt: null,
      };

      const activity = {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "invited" as const,
        summary: `${actor.displayName} invited ${input.email}.`,
        createdAt,
      };

      yield* Ref.update(stateRef, (state) => {
        const invites = new Map(state.invites);
        invites.set(invite.id, invite);
        return appendActivity(
          {
            ...state,
            invites,
          },
          activity,
        );
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "invite-created", invite });
      yield* PubSub.publish(events, { type: "activity-appended", activity });

      return {
        invite,
        acceptUrlPath: inviteAcceptUrlPath(invite.id),
      };
    });

  const listInvites: CollaborationServiceShape["listInvites"] = (input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => ({
        invites: Array.from(state.invites.values()).filter(
          (invite) =>
            invite.tenantId === input.tenantId &&
            (input.workspaceId === undefined || invite.workspaceId === input.workspaceId),
        ),
      })),
    );

  const acceptInvite: CollaborationServiceShape["acceptInvite"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const invite = state.invites.get(input.inviteId);
      if (!invite) {
        return yield* new CollaborationError({
          code: "invalid-invite",
          message: "Collaboration invite was not found.",
        });
      }

      if (invite.revokedAt !== null) {
        return yield* new CollaborationError({
          code: "invite-revoked",
          message: "Collaboration invite has been revoked.",
        });
      }

      if (invite.acceptedAt !== null) {
        return yield* new CollaborationError({
          code: "invite-accepted",
          message: "Collaboration invite has already been accepted.",
        });
      }

      if (Date.parse(invite.expiresAt) <= Date.now()) {
        return yield* new CollaborationError({
          code: "invite-expired",
          message: "Collaboration invite has expired.",
        });
      }

      const acceptedAt = nowIso();
      const acceptedInvite = {
        ...invite,
        acceptedAt,
      };
      const membership: TenantMembership = {
        id: MembershipId.make(`membership:${crypto.randomUUID()}`),
        tenantId: invite.tenantId,
        userId: actor.userId,
        organizationId: null,
        roles: invite.roles,
        createdAt: acceptedAt,
        disabledAt: null,
      };
      const invites = new Map(state.invites);
      const memberships = new Map(state.memberships);
      invites.set(acceptedInvite.id, acceptedInvite);
      memberships.set(membership.id, membership);

      const activity = {
        tenantId: invite.tenantId,
        workspaceId: invite.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "accepted-invite" as const,
        summary: `${actor.displayName} accepted a collaboration invite.`,
        createdAt: acceptedAt,
      };

      yield* Ref.set(
        stateRef,
        appendActivity(
          {
            ...state,
            invites,
            memberships,
          },
          activity,
        ),
      );
      yield* persist;
      yield* PubSub.publish(events, {
        type: "invite-accepted",
        invite: acceptedInvite,
        membership,
      });
      yield* PubSub.publish(events, { type: "activity-appended", activity });

      return {
        invite: acceptedInvite,
        membership,
      };
    });

  const revokeInvite: CollaborationServiceShape["revokeInvite"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const invite = state.invites.get(input.inviteId);
      if (!invite || invite.tenantId !== input.tenantId) {
        return yield* new CollaborationError({
          code: "invalid-invite",
          message: "Collaboration invite was not found.",
        });
      }

      if (invite.revokedAt !== null) {
        return {
          invite,
        };
      }

      if (invite.acceptedAt !== null) {
        return yield* new CollaborationError({
          code: "invite-accepted",
          message: "Accepted collaboration invites cannot be revoked.",
        });
      }

      const revokedAt = nowIso();
      const revokedInvite = {
        ...invite,
        revokedAt,
      };
      const activity = {
        tenantId: invite.tenantId,
        workspaceId: invite.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "revoked-invite" as const,
        summary: `${actor.displayName} revoked an invite for ${invite.email}.`,
        createdAt: revokedAt,
      };

      yield* Ref.update(stateRef, (current) => {
        const invites = new Map(current.invites);
        invites.set(revokedInvite.id, revokedInvite);
        return appendActivity(
          {
            ...current,
            invites,
          },
          activity,
        );
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "invite-revoked", invite: revokedInvite });
      yield* PubSub.publish(events, { type: "activity-appended", activity });

      return {
        invite: revokedInvite,
      };
    });

  const recordSharedPrompt: CollaborationServiceShape["recordSharedPrompt"] = (actor, input) => {
    const activity = {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: actor.userId,
      kind: "prompted" as const,
      summary: toPromptSummary(actor, input.prompt),
      createdAt: nowIso(),
    };
    return Ref.update(stateRef, (state) => appendActivity(state, activity)).pipe(
      Effect.flatMap(() => persist),
      Effect.tap(() => PubSub.publish(events, { type: "activity-appended", activity })),
      Effect.as({ activity }),
    );
  };

  const listActivity: CollaborationServiceShape["listActivity"] = (input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const limit = Math.min(input.limit ?? DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
        const activities = state.activities.filter(
          (activity) =>
            activity.tenantId === input.tenantId &&
            activity.workspaceId === input.workspaceId &&
            (input.threadId === undefined || activity.threadId === input.threadId),
        );
        return {
          activities: activities.slice(-limit).toReversed(),
        };
      }),
    );

  const stream: CollaborationServiceShape["stream"] = (input) =>
    Stream.fromPubSub(events).pipe(
      Stream.filter((event) => {
        switch (event.type) {
          case "presence-upserted":
            return (
              event.presence.tenantId === input.tenantId &&
              event.presence.workspaceId === input.workspaceId &&
              (input.threadId === undefined || event.presence.threadId === input.threadId)
            );
          case "invite-created":
            return (
              event.invite.tenantId === input.tenantId &&
              (event.invite.workspaceId === null || event.invite.workspaceId === input.workspaceId)
            );
          case "invite-accepted":
            return (
              event.invite.tenantId === input.tenantId &&
              (event.invite.workspaceId === null || event.invite.workspaceId === input.workspaceId)
            );
          case "invite-revoked":
            return (
              event.invite.tenantId === input.tenantId &&
              (event.invite.workspaceId === null || event.invite.workspaceId === input.workspaceId)
            );
          case "activity-appended":
            return (
              event.activity.tenantId === input.tenantId &&
              event.activity.workspaceId === input.workspaceId &&
              (input.threadId === undefined || event.activity.threadId === input.threadId)
            );
        }
      }),
    );

  return {
    upsertPresence,
    listPresence,
    createInvite,
    listInvites,
    acceptInvite,
    revokeInvite,
    recordSharedPrompt,
    listActivity,
    stream,
  } satisfies CollaborationServiceShape;
});

export const CollaborationServiceLive = Layer.effect(
  CollaborationService,
  makeCollaborationService,
);
