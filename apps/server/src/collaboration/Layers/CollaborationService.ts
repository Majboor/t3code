import {
  CollaborationActivityId,
  CollaborationApprovalId,
  CollaborationError,
  InviteId,
  MembershipId,
  type CollaborationBranchClaim,
  type CollaborationFileTouch,
  type CollaborationMember,
  type CollaborationPresence,
  type CollaborationPromptApproval,
  type CollaborationStreamEvent,
  type CollaborationViewPreferences,
  type CollaborationWorkspaceSettings,
  type TenantInvite,
  type TenantMembership,
  type TenantRole,
  type UserId,
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

/**
 * Read-only is the absence of any role that grants writing, which is what
 * `checkWriteAccessForTurn` already tests for. Restoring write access returns
 * the member to `developer` rather than whatever they held before, because the
 * roles they came in with are not recorded once they are replaced.
 */
const READ_ONLY_ROLES = ["viewer"] as const satisfies ReadonlyArray<TenantRole>;
const WRITE_ROLES = ["developer"] as const satisfies ReadonlyArray<TenantRole>;

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

function workspaceKey(tenantId: string, workspaceId: string): string {
  return `${tenantId}:${workspaceId}`;
}

function scopedKey(tenantId: string, workspaceId: string, suffix: string): string {
  return `${tenantId}:${workspaceId}:${suffix}`;
}

function usageKey(
  tenantId: string,
  workspaceId: string,
  userId: string,
  threadId: string,
): string {
  return `${tenantId}:${workspaceId}:${userId}:${threadId}`;
}

const DEFAULT_APPROVAL_MODE = "open" as const;

/**
 * Settings a workspace has never been configured with. The lead is filled in
 * from whoever the workspace belongs to, and until someone changes the mode,
 * nothing is gated.
 */
function defaultSettings(input: {
  readonly tenantId: CollaborationWorkspaceSettings["tenantId"];
  readonly workspaceId: CollaborationWorkspaceSettings["workspaceId"];
  readonly leadUserId: UserId | null;
  readonly updatedAt: string;
}): CollaborationWorkspaceSettings {
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    leadUserId: input.leadUserId,
    approvalMode: DEFAULT_APPROVAL_MODE,
    approverUserIds: [],
    updatedAt: input.updatedAt,
  };
}

/**
 * A stable colour per person, derived from the id so every client agrees
 * without the server handing out a palette. Hues are spread far enough apart
 * that neighbouring members stay tellable apart.
 */
export function defaultMemberColor(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 70% 55%)`;
}

/** Initials for an avatar, from a name or failing that an email address. */
export function toAvatarInitials(displayName: string): string {
  const nameSource = displayName.includes("@")
    ? (displayName.split("@")[0] ?? displayName)
    : displayName;
  const parts = nameSource.split(/[\s._-]+/).filter((part) => part.length > 0);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials.length > 0 ? initials : "?";
}

/** The lead approves by definition; everyone else has to be named. */
function isApprover(settings: CollaborationWorkspaceSettings, userId: UserId): boolean {
  if (settings.leadUserId === userId) {
    return true;
  }
  return settings.approverUserIds.includes(userId);
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

function newActivityId() {
  return CollaborationActivityId.make(`activity:${crypto.randomUUID()}`);
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
    settings: new Map(
      (persisted.settings ?? []).map((entry) => [
        workspaceKey(entry.tenantId, entry.workspaceId),
        entry,
      ]),
    ),
    approvals: new Map((persisted.approvals ?? []).map((entry) => [entry.id, entry])),
    viewPreferences: new Map(
      (persisted.viewPreferences ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.userId),
        entry,
      ]),
    ),
    branchClaims: new Map(
      (persisted.branchClaims ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.userId),
        entry,
      ]),
    ),
    fileTouches: new Map(
      (persisted.fileTouches ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.path),
        entry,
      ]),
    ),
    memberProfiles: new Map(
      (persisted.memberProfiles ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.userId),
        entry,
      ]),
    ),
    memberUsage: new Map(
      (persisted.memberUsage ?? []).map((entry) => [
        usageKey(entry.tenantId, entry.workspaceId, entry.userId, entry.threadId),
        entry,
      ]),
    ),
  });

  /** The workspace owner is the lead, when the workspace is known at all. */
  const resolveLeadUserId = (workspaceId: string) =>
    repository.loadWorkspaces().pipe(
      Effect.map(
        (snapshot) =>
          snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.ownerUserId ?? null,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const persist = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      repository.saveCollaboration({
        presence: Array.from(state.presence.values()),
        invites: Array.from(state.invites.values()),
        memberships: Array.from(state.memberships.values()),
        activities: state.activities,
        settings: Array.from(state.settings.values()),
        approvals: Array.from(state.approvals.values()),
        viewPreferences: Array.from(state.viewPreferences.values()),
        branchClaims: Array.from(state.branchClaims.values()),
        fileTouches: Array.from(state.fileTouches.values()),
        memberProfiles: Array.from(state.memberProfiles.values()),
        memberUsage: Array.from(state.memberUsage.values()),
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
          id: newActivityId(),
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          userId: actor.userId,
          kind: activityKind,
          hiddenAt: null,
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
        id: newActivityId(),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "invited" as const,
        hiddenAt: null,
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
        id: newActivityId(),
        tenantId: invite.tenantId,
        workspaceId: invite.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "accepted-invite" as const,
        hiddenAt: null,
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
        id: newActivityId(),
        tenantId: invite.tenantId,
        workspaceId: invite.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "revoked-invite" as const,
        hiddenAt: null,
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
      id: newActivityId(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: actor.userId,
      kind: "prompted" as const,
      summary: toPromptSummary(actor, input.prompt),
      hiddenAt: null,
      createdAt: nowIso(),
    };
    return Ref.update(stateRef, (state) => appendActivity(state, activity)).pipe(
      Effect.flatMap(() => persist),
      Effect.tap(() => PubSub.publish(events, { type: "activity-appended", activity })),
      Effect.as({ activity }),
    );
  };

  const listActivity: CollaborationServiceShape["listActivity"] = (actor, input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const limit = Math.min(input.limit ?? DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
        const activities = state.activities.filter(
          (activity) =>
            activity.tenantId === input.tenantId &&
            activity.workspaceId === input.workspaceId &&
            (input.threadId === undefined || activity.threadId === input.threadId) &&
            // Hidden entries stay visible to the person who wrote them.
            (activity.hiddenAt === null || activity.userId === actor.userId),
        );
        return {
          activities: activities.slice(-limit).toReversed(),
        };
      }),
    );

  const setActivityVisibility: CollaborationServiceShape["setActivityVisibility"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const existing = state.activities.find(
        (activity) =>
          activity.id === input.activityId &&
          activity.tenantId === input.tenantId &&
          activity.workspaceId === input.workspaceId,
      );
      if (!existing) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Shared activity was not found.",
        });
      }
      // Your own history is yours to curate; nobody else edits it for you.
      if (existing.userId !== actor.userId) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the author can change what they share.",
        });
      }

      const updated = { ...existing, hiddenAt: input.hidden ? nowIso() : null };
      yield* Ref.update(stateRef, (current) => ({
        ...current,
        activities: current.activities.map((activity) =>
          activity.id === updated.id ? updated : activity,
        ),
      }));
      yield* persist;
      yield* PubSub.publish(events, { type: "activity-visibility-changed", activity: updated });

      return { activity: updated };
    });

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
          case "activity-visibility-changed":
            return (
              event.activity.tenantId === input.tenantId &&
              event.activity.workspaceId === input.workspaceId &&
              (input.threadId === undefined || event.activity.threadId === input.threadId)
            );
          case "settings-updated":
            return (
              event.settings.tenantId === input.tenantId &&
              event.settings.workspaceId === input.workspaceId
            );
          case "approval-requested":
          case "approval-decided":
            // Not filtered by thread: the approval queue is workspace-wide, and
            // an approver watching one thread still has to see the others.
            return (
              event.approval.tenantId === input.tenantId &&
              event.approval.workspaceId === input.workspaceId
            );
          case "branch-claimed":
            return (
              event.claim.tenantId === input.tenantId &&
              event.claim.workspaceId === input.workspaceId
            );
          case "branch-released":
            return event.tenantId === input.tenantId && event.workspaceId === input.workspaceId;
          case "member-updated":
            return (
              event.member.tenantId === input.tenantId &&
              event.member.workspaceId === input.workspaceId
            );
          case "member-removed":
            return event.tenantId === input.tenantId && event.workspaceId === input.workspaceId;
          case "files-touched":
            return event.touches.some(
              (touch) =>
                touch.tenantId === input.tenantId && touch.workspaceId === input.workspaceId,
            );
        }
      }),
    );

  /** Reads stored settings, falling back to defaults derived from the workspace. */
  const resolveSettings = Effect.fn("resolveSettings")(function* (input: {
    readonly tenantId: CollaborationWorkspaceSettings["tenantId"];
    readonly workspaceId: CollaborationWorkspaceSettings["workspaceId"];
  }) {
    const state = yield* Ref.get(stateRef);
    const stored = state.settings.get(workspaceKey(input.tenantId, input.workspaceId));
    if (stored) {
      return stored;
    }
    const leadUserId = yield* resolveLeadUserId(input.workspaceId);
    return defaultSettings({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      leadUserId,
      updatedAt: nowIso(),
    });
  });

  const getSettings: CollaborationServiceShape["getSettings"] = (actor, input) =>
    resolveSettings(input).pipe(
      Effect.map((settings) => ({
        settings,
        canManage: isApprover(settings, actor.userId),
      })),
    );

  const updateSettings: CollaborationServiceShape["updateSettings"] = (actor, input) =>
    Effect.gen(function* () {
      const current = yield* resolveSettings(input);
      // A workspace with no owner on record has nobody who could ever qualify,
      // so let the first caller configure it rather than locking it forever.
      if (current.leadUserId !== null && !isApprover(current, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can change collaboration settings.",
        });
      }

      const next: CollaborationWorkspaceSettings = {
        ...current,
        leadUserId: current.leadUserId ?? actor.userId,
        approvalMode: input.approvalMode ?? current.approvalMode,
        approverUserIds: input.approverUserIds ?? current.approverUserIds,
        updatedAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const settings = new Map(state.settings);
        settings.set(workspaceKey(next.tenantId, next.workspaceId), next);
        return { ...state, settings };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "settings-updated", settings: next });

      return {
        settings: next,
        canManage: isApprover(next, actor.userId),
      };
    });

  /** The oldest approved-but-unspent approval this person still holds. */
  const findSpendableApproval = Effect.fn("findSpendableApproval")(function* (
    userId: UserId,
    input: { readonly tenantId: string; readonly workspaceId: string },
  ) {
    const state = yield* Ref.get(stateRef);
    return (
      Array.from(state.approvals.values())
        .filter(
          (approval) =>
            approval.tenantId === input.tenantId &&
            approval.workspaceId === input.workspaceId &&
            approval.requestedByUserId === userId &&
            approval.status === "approved" &&
            approval.consumedAt === null,
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null
    );
  });

  const submitPromptForApproval: CollaborationServiceShape["submitPromptForApproval"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      // Approvers never queue behind themselves, and an open workspace queues
      // nobody, so both cases skip the record entirely.
      if (settings.approvalMode === "open" || isApprover(settings, actor.userId)) {
        return { approval: null, mayRun: true };
      }

      // A prompt that has already been approved and not yet spent is what the
      // author re-sends after being told to wait. Queueing it again would mean
      // they could never actually run it.
      const alreadyApproved = yield* findSpendableApproval(actor.userId, input);
      if (alreadyApproved) {
        return { approval: alreadyApproved, mayRun: true };
      }

      const approval: CollaborationPromptApproval = {
        id: CollaborationApprovalId.make(`approval:${crypto.randomUUID()}`),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        threadId: input.threadId ?? null,
        requestedByUserId: actor.userId,
        requestedByName: actor.displayName,
        prompt: input.prompt,
        mode: settings.approvalMode,
        status: "pending",
        decidedByUserId: null,
        decidedAt: null,
        note: null,
        consumedAt: null,
        createdAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const approvals = new Map(state.approvals);
        approvals.set(approval.id, approval);
        return { ...state, approvals };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "approval-requested", approval });

      // `staged` lets the work happen on the author's own branch and reviews the
      // merge instead; `blocking` holds the prompt until somebody says yes.
      return { approval, mayRun: settings.approvalMode === "staged" };
    });

  const listApprovals: CollaborationServiceShape["listApprovals"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      const state = yield* Ref.get(stateRef);
      const limit = Math.min(input.limit ?? DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
      const approvals = Array.from(state.approvals.values())
        .filter(
          (approval) =>
            approval.tenantId === input.tenantId &&
            approval.workspaceId === input.workspaceId &&
            (input.status === undefined || approval.status === input.status),
        )
        .slice(-limit)
        .toReversed();

      return {
        approvals,
        canDecide: isApprover(settings, actor.userId),
      };
    });

  const decideApproval: CollaborationServiceShape["decideApproval"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      if (!isApprover(settings, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can decide prompt approvals.",
        });
      }

      const state = yield* Ref.get(stateRef);
      const existing = state.approvals.get(input.approvalId);
      if (!existing || existing.workspaceId !== input.workspaceId) {
        return yield* new CollaborationError({
          code: "approval-not-found",
          message: "Prompt approval was not found.",
        });
      }
      if (existing.status !== "pending") {
        return yield* new CollaborationError({
          code: "approval-already-decided",
          message: "Prompt approval has already been decided.",
        });
      }

      const decided: CollaborationPromptApproval = {
        ...existing,
        status: input.decision,
        decidedByUserId: actor.userId,
        decidedAt: nowIso(),
        note: input.note ?? null,
      };

      yield* Ref.update(stateRef, (current) => {
        const approvals = new Map(current.approvals);
        approvals.set(decided.id, decided);
        return { ...current, approvals };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "approval-decided", approval: decided });

      return { approval: decided };
    });

  const consumeApprovalForTurn: CollaborationServiceShape["consumeApprovalForTurn"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      // Only `blocking` withholds the run itself. `staged` deliberately lets the
      // work happen and reviews it at the merge instead.
      if (settings.approvalMode !== "blocking" || isApprover(settings, actor.userId)) {
        return { mayRun: true };
      }

      const spendable = yield* findSpendableApproval(actor.userId, input);
      if (!spendable) {
        return { mayRun: false };
      }

      const consumed: CollaborationPromptApproval = { ...spendable, consumedAt: nowIso() };
      yield* Ref.update(stateRef, (state) => {
        const approvals = new Map(state.approvals);
        approvals.set(consumed.id, consumed);
        return { ...state, approvals };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "approval-decided", approval: consumed });

      return { mayRun: true };
    });

  /**
   * Assembles the roster from what is already recorded: memberships say who
   * belongs, presence says what they are called and whether they are here, and
   * the accepted invite carries the email.
   */
  const buildMembers = Effect.fn("buildMembers")(function* (input: {
    readonly tenantId: CollaborationMember["tenantId"];
    readonly workspaceId: CollaborationMember["workspaceId"];
    /** Whoever is asking always sees their own details in full. */
    readonly viewerUserId?: UserId;
  }) {
    const state = yield* Ref.get(stateRef);
    const settings = yield* resolveSettings(input);

    const presenceByUser = new Map<string, CollaborationPresence>();
    for (const presence of state.presence.values()) {
      if (presence.tenantId !== input.tenantId || presence.workspaceId !== input.workspaceId) {
        continue;
      }
      const existing = presenceByUser.get(presence.userId);
      if (!existing || existing.lastSeenAt < presence.lastSeenAt) {
        presenceByUser.set(presence.userId, presence);
      }
    }

    const emailByUser = new Map<string, string>();
    const joinedByUser = new Map<string, string>();
    for (const invite of state.invites.values()) {
      if (invite.tenantId !== input.tenantId || invite.acceptedAt === null) {
        continue;
      }
      if (invite.workspaceId !== null && invite.workspaceId !== input.workspaceId) {
        continue;
      }
      const membership = Array.from(state.memberships.values()).find(
        (candidate) =>
          candidate.tenantId === invite.tenantId && candidate.createdAt === invite.acceptedAt,
      );
      if (membership) {
        emailByUser.set(membership.userId, invite.email);
        joinedByUser.set(membership.userId, invite.acceptedAt);
      }
    }

    const promptCounts = new Map<string, number>();
    for (const activity of state.activities) {
      if (
        activity.tenantId !== input.tenantId ||
        activity.workspaceId !== input.workspaceId ||
        activity.kind !== "prompted"
      ) {
        continue;
      }
      promptCounts.set(activity.userId, (promptCounts.get(activity.userId) ?? 0) + 1);
    }

    const tokenTotals = new Map<string, number>();
    for (const usage of state.memberUsage.values()) {
      if (usage.tenantId !== input.tenantId || usage.workspaceId !== input.workspaceId) {
        continue;
      }
      tokenTotals.set(usage.userId, (tokenTotals.get(usage.userId) ?? 0) + usage.totalTokens);
    }

    const pendingCounts = new Map<string, number>();
    for (const approval of state.approvals.values()) {
      if (
        approval.tenantId !== input.tenantId ||
        approval.workspaceId !== input.workspaceId ||
        approval.status !== "pending"
      ) {
        continue;
      }
      pendingCounts.set(
        approval.requestedByUserId,
        (pendingCounts.get(approval.requestedByUserId) ?? 0) + 1,
      );
    }

    // Anyone who belongs, plus anyone who has shown up or spent tokens, plus
    // the lead even if they have never reported presence.
    const userIds = new Set<string>();
    for (const membership of state.memberships.values()) {
      if (membership.tenantId === input.tenantId && membership.disabledAt === null) {
        userIds.add(membership.userId);
      }
    }
    for (const userId of presenceByUser.keys()) {
      userIds.add(userId);
    }
    for (const userId of tokenTotals.keys()) {
      userIds.add(userId);
    }
    if (settings.leadUserId) {
      userIds.add(settings.leadUserId);
    }

    return Array.from(userIds).map((userId): CollaborationMember => {
      const typedUserId = userId as CollaborationMember["userId"];
      const presence = presenceByUser.get(userId) ?? null;
      const profile = state.memberProfiles.get(
        scopedKey(input.tenantId, input.workspaceId, userId),
      );
      const membership = Array.from(state.memberships.values()).find(
        (candidate) => candidate.tenantId === input.tenantId && candidate.userId === userId,
      );
      const displayName = profile?.displayName ?? presence?.displayName ?? userId;
      // Silence is not consent: until asked, nothing extra is shared.
      const sharesProfile = profile?.shareProfile ?? false;
      const sharesUsage = profile?.shareUsage ?? false;
      const isViewer = input.viewerUserId === userId;

      return {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: typedUserId,
        displayName,
        email: sharesProfile || isViewer ? (emailByUser.get(userId) ?? null) : null,
        avatarInitials: presence?.avatarInitials ?? toAvatarInitials(displayName),
        color: profile?.color ?? defaultMemberColor(userId),
        colorIsCustom: Boolean(profile?.color),
        roles: membership?.roles ?? [],
        isLead: settings.leadUserId === userId,
        isApprover: isApprover(settings, typedUserId),
        status: presence?.status ?? "offline",
        lastSeenAt: presence?.lastSeenAt ?? null,
        joinedAt: joinedByUser.get(userId) ?? membership?.createdAt ?? null,
        sharesProfile,
        sharesUsage,
        promptCount: sharesUsage || isViewer ? (promptCounts.get(userId) ?? 0) : null,
        pendingApprovalCount:
          sharesUsage || isViewer ? (pendingCounts.get(userId) ?? 0) : null,
        tokensUsed: sharesUsage || isViewer ? (tokenTotals.get(userId) ?? 0) : null,
      };
    });
  });

  const checkWriteAccessForTurn: CollaborationServiceShape["checkWriteAccessForTurn"] = (
    actor,
    input,
  ) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const roles =
          Array.from(state.memberships.values()).find(
            (membership) =>
              membership.tenantId === input.tenantId &&
              membership.userId === actor.userId &&
              membership.disabledAt === null,
          )?.roles ?? [];
        // Nobody is locked out by having no membership recorded; only an
        // explicit viewer-and-nothing-else role is read-only.
        return { mayRun: roles.length === 0 || roles.some((role) => role !== "viewer") };
      }),
    );

  const listMembers: CollaborationServiceShape["listMembers"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      const members = yield* buildMembers({ ...input, viewerUserId: actor.userId });
      return {
        members,
        canManage: isApprover(settings, actor.userId),
        viewerUserId: actor.userId,
      };
    });

  const updateMember: CollaborationServiceShape["updateMember"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      if (!isApprover(settings, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can change member settings.",
        });
      }

      if (input.color !== undefined || input.displayName !== undefined) {
        const key = scopedKey(input.tenantId, input.workspaceId, input.userId);
        yield* Ref.update(stateRef, (state) => {
          const memberProfiles = new Map(state.memberProfiles);
          const existing = memberProfiles.get(key);
          memberProfiles.set(key, {
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            color: input.color ?? existing?.color ?? null,
            displayName: input.displayName ?? existing?.displayName ?? null,
            shareProfile: existing?.shareProfile ?? null,
            shareUsage: existing?.shareUsage ?? null,
            consentAt: existing?.consentAt ?? null,
            updatedAt: nowIso(),
          });
          return { ...state, memberProfiles };
        });
      }

      if (input.isApprover !== undefined) {
        const approvers = new Set(settings.approverUserIds);
        if (input.isApprover) {
          approvers.add(input.userId);
        } else {
          approvers.delete(input.userId);
        }
        yield* updateSettings(actor, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          approverUserIds: [...approvers],
        });
      }

      if (input.readOnly !== undefined) {
        // The lead is the one person who can undo this, so letting them take
        // their own write access away would strand the workspace.
        if (settings.leadUserId === input.userId) {
          return yield* new CollaborationError({
            code: "invalid-membership-rule",
            message: "The workspace lead cannot be made read-only.",
          });
        }

        const roles = input.readOnly ? READ_ONLY_ROLES : WRITE_ROLES;
        yield* Ref.update(stateRef, (state) => {
          const memberships = new Map(state.memberships);
          for (const [id, membership] of memberships) {
            if (membership.tenantId === input.tenantId && membership.userId === input.userId) {
              memberships.set(id, { ...membership, roles });
            }
          }
          return { ...state, memberships };
        });
      }

      yield* persist;
      const members = yield* buildMembers(input);
      const member = members.find((candidate) => candidate.userId === input.userId);
      if (!member) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Workspace member was not found.",
        });
      }
      yield* PubSub.publish(events, { type: "member-updated", member });
      return { member };
    });

  const removeMember: CollaborationServiceShape["removeMember"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      if (!isApprover(settings, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can remove members.",
        });
      }
      // The lead is the one account that cannot be locked out of its own
      // workspace, or nobody would be left who could govern it.
      if (settings.leadUserId === input.userId) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "The workspace lead cannot be removed.",
        });
      }

      const removed = yield* Ref.modify(stateRef, (state) => {
        const memberships = new Map(state.memberships);
        let didRemove = false;
        for (const [id, membership] of memberships) {
          if (membership.tenantId === input.tenantId && membership.userId === input.userId) {
            memberships.delete(id);
            didRemove = true;
          }
        }
        if (!didRemove) {
          return [false, state] as const;
        }

        const presence = new Map(state.presence);
        for (const [key, entry] of presence) {
          if (
            entry.tenantId === input.tenantId &&
            entry.workspaceId === input.workspaceId &&
            entry.userId === input.userId
          ) {
            presence.delete(key);
          }
        }
        return [true, { ...state, memberships, presence }] as const;
      });

      if (!removed) {
        return { removed: false };
      }

      yield* persist;
      yield* PubSub.publish(events, {
        type: "member-removed",
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      return { removed: true };
    });

  const recordUsage: CollaborationServiceShape["recordUsage"] = (actor, input) =>
    Effect.gen(function* () {
      const key = usageKey(input.tenantId, input.workspaceId, actor.userId, input.threadId);
      const changed = yield* Ref.modify(stateRef, (state) => {
        const existing = state.memberUsage.get(key);
        // A thread's total only ever climbs, so a stale or repeated report is
        // ignored rather than counted twice.
        if (existing && existing.totalTokens >= input.totalTokens) {
          return [false, state] as const;
        }
        const memberUsage = new Map(state.memberUsage);
        memberUsage.set(key, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          threadId: input.threadId,
          totalTokens: input.totalTokens,
          updatedAt: nowIso(),
        });
        return [true, { ...state, memberUsage }] as const;
      });

      if (changed) {
        yield* persist;
      }

      const members = yield* buildMembers({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        viewerUserId: actor.userId,
      });
      const member = members.find((candidate) => candidate.userId === actor.userId);
      if (!member) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Workspace member was not found.",
        });
      }
      if (changed && member.sharesUsage) {
        // Only broadcast a total the workspace is allowed to see; the caller
        // still gets their own back either way.
        yield* PubSub.publish(events, { type: "member-updated", member });
      }

      return { member };
    });

  const getConsent: CollaborationServiceShape["getConsent"] = (actor, input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const profile = state.memberProfiles.get(
          scopedKey(input.tenantId, input.workspaceId, actor.userId),
        );
        if (!profile || profile.consentAt === null) {
          return { consent: null };
        }
        return {
          consent: {
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            userId: actor.userId,
            shareProfile: profile.shareProfile ?? false,
            shareUsage: profile.shareUsage ?? false,
            decidedAt: profile.consentAt,
          },
        };
      }),
    );

  const updateConsent: CollaborationServiceShape["updateConsent"] = (actor, input) =>
    Effect.gen(function* () {
      const decidedAt = nowIso();
      const key = scopedKey(input.tenantId, input.workspaceId, actor.userId);
      yield* Ref.update(stateRef, (state) => {
        const memberProfiles = new Map(state.memberProfiles);
        const existing = memberProfiles.get(key);
        memberProfiles.set(key, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          color: existing?.color ?? null,
          displayName: existing?.displayName ?? null,
          shareProfile: input.shareProfile,
          shareUsage: input.shareUsage,
          consentAt: decidedAt,
          updatedAt: decidedAt,
        });
        return { ...state, memberProfiles };
      });
      yield* persist;

      const members = yield* buildMembers(input);
      const member = members.find((candidate) => candidate.userId === actor.userId);
      if (member) {
        yield* PubSub.publish(events, { type: "member-updated", member });
      }

      return {
        consent: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          shareProfile: input.shareProfile,
          shareUsage: input.shareUsage,
          decidedAt,
        },
      };
    });

  const getViewPreferences: CollaborationServiceShape["getViewPreferences"] = (actor, input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => ({
        preferences: state.viewPreferences.get(
          scopedKey(input.tenantId, input.workspaceId, actor.userId),
        ) ?? {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          showOthersPrompts: true,
          showOthersFiles: true,
          updatedAt: nowIso(),
        },
      })),
    );

  const updateViewPreferences: CollaborationServiceShape["updateViewPreferences"] = (actor, input) =>
    Effect.gen(function* () {
      const { preferences: current } = yield* getViewPreferences(actor, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
      });
      const next: CollaborationViewPreferences = {
        ...current,
        showOthersPrompts: input.showOthersPrompts ?? current.showOthersPrompts,
        showOthersFiles: input.showOthersFiles ?? current.showOthersFiles,
        updatedAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const viewPreferences = new Map(state.viewPreferences);
        viewPreferences.set(
          scopedKey(next.tenantId, next.workspaceId, next.userId),
          next,
        );
        return { ...state, viewPreferences };
      });
      yield* persist;

      // Deliberately not broadcast: this is one person's own view filter.
      return { preferences: next };
    });

  const claimBranch: CollaborationServiceShape["claimBranch"] = (actor, input) =>
    Effect.gen(function* () {
      const claim: CollaborationBranchClaim = {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
        displayName: actor.displayName,
        branch: input.branch,
        baseBranch: input.baseBranch,
        worktreePath: input.worktreePath,
        createdAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const branchClaims = new Map(state.branchClaims);
        branchClaims.set(scopedKey(claim.tenantId, claim.workspaceId, claim.userId), claim);
        return { ...state, branchClaims };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "branch-claimed", claim });

      return { claim };
    });

  const listBranchClaims: CollaborationServiceShape["listBranchClaims"] = (actor, input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const claims = Array.from(state.branchClaims.values()).filter(
          (claim) => claim.tenantId === input.tenantId && claim.workspaceId === input.workspaceId,
        );
        return {
          claims,
          mine: claims.find((claim) => claim.userId === actor.userId) ?? null,
          viewerDisplayName: actor.displayName,
        };
      }),
    );

  const releaseBranch: CollaborationServiceShape["releaseBranch"] = (actor, input) =>
    Effect.gen(function* () {
      const key = scopedKey(input.tenantId, input.workspaceId, actor.userId);
      const released = yield* Ref.modify(stateRef, (state) => {
        if (!state.branchClaims.has(key)) {
          return [false, state] as const;
        }
        const branchClaims = new Map(state.branchClaims);
        branchClaims.delete(key);
        return [true, { ...state, branchClaims }] as const;
      });

      if (!released) {
        return { released: false };
      }

      yield* persist;
      yield* PubSub.publish(events, {
        type: "branch-released",
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
      });

      return { released: true };
    });

  const touchFiles: CollaborationServiceShape["touchFiles"] = (actor, input) =>
    Effect.gen(function* () {
      const touchedAt = nowIso();
      const touches: ReadonlyArray<CollaborationFileTouch> = input.paths.map((path) => ({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
        displayName: actor.displayName,
        path,
        touchedAt,
      }));

      if (touches.length === 0) {
        return { touches };
      }

      yield* Ref.update(stateRef, (state) => {
        const fileTouches = new Map(state.fileTouches);
        for (const touch of touches) {
          fileTouches.set(scopedKey(touch.tenantId, touch.workspaceId, touch.path), touch);
        }
        return { ...state, fileTouches };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "files-touched", touches });

      return { touches };
    });

  const listFileTouches: CollaborationServiceShape["listFileTouches"] = (input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => ({
        touches: Array.from(state.fileTouches.values()).filter(
          (touch) =>
            touch.tenantId === input.tenantId && touch.workspaceId === input.workspaceId,
        ),
      })),
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
    setActivityVisibility,
    stream,
    getSettings,
    updateSettings,
    submitPromptForApproval,
    consumeApprovalForTurn,
    checkWriteAccessForTurn,
    listApprovals,
    decideApproval,
    getViewPreferences,
    updateViewPreferences,
    claimBranch,
    listBranchClaims,
    releaseBranch,
    touchFiles,
    listFileTouches,
    listMembers,
    updateMember,
    removeMember,
    recordUsage,
    getConsent,
    updateConsent,
  } satisfies CollaborationServiceShape;
});

export const CollaborationServiceLive = Layer.effect(
  CollaborationService,
  makeCollaborationService,
);
