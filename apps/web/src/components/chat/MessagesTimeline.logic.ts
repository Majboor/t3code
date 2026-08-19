import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type CollaborationMembers } from "../../hooks/useCollaborationMembers";
import {
  memberColorForUserId,
  UNKNOWN_MEMBER_INITIALS,
  UNKNOWN_MEMBER_NAME,
} from "../collaboration/collaborationRoster.logic";
import { type MessageId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

/**
 * How to draw the person a message came from.
 *
 * Always complete: a name, initials and a colour, whether or not the roster
 * this browser holds happens to know who the author is.
 */
export interface MessageAuthorLabel {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarInitials: string;
  readonly color: string;
  /** The reader themself. Their own name, drawn the same way everyone else's is. */
  readonly isViewer: boolean;
  /** False when the roster had no entry and this label was derived from the id. */
  readonly isKnown: boolean;
}

/**
 * The label to draw on a message, or null when there is honestly nothing to say.
 *
 * Two rules, and the second one is the whole point:
 *
 * A message the server did not attribute — the assistant, one written before
 * authors were recorded, one this browser has only just added optimistically —
 * has no author to name, so it stays bare rather than being guessed at.
 *
 * A message that *does* name an author is always labelled, even when the roster
 * this browser holds has never heard of them. It used to fall through to null
 * there, which looks like a missing decoration but is worse than that: an
 * unlabelled message reads as the reader's own, so a colleague who had been
 * removed from the workspace — or whose roster entry simply had not arrived yet
 * — had every message they ever wrote quietly re-attributed to whoever was
 * reading. "Someone else", in the colour their id has always hashed to, is both
 * honest and stable.
 *
 * Two things are still worth suppressing. A solo thread: with nobody else in
 * the workspace, naming yourself on every line is noise and nothing more, so
 * the reader's own messages are labelled only once somebody else is in the
 * roster. And a roster that has not answered yet: without it this browser does
 * not even know its own user id, so every message — including the reader's own
 * — would come out as a stranger's. Silence is the honest answer there, and it
 * is why `useCollaborationMembers` retries rather than giving up on a roster it
 * could not fetch first time.
 */
export function resolveMessageAuthor(
  message: Pick<ChatMessage, "authorUserId">,
  members: CollaborationMembers,
): MessageAuthorLabel | null {
  const authorUserId = message.authorUserId;
  if (!authorUserId) {
    return null;
  }

  // No roster yet. Not even the reader's own id is known, so every message
  // would come out as a stranger's — say nothing until there is something true
  // to say.
  if (members.viewerUserId === null) {
    return null;
  }

  const isViewer = authorUserId === members.viewerUserId;
  if (isViewer && !hasOtherMembers(members)) {
    return null;
  }

  const member = members.byUserId.get(authorUserId);
  if (member) {
    return {
      userId: member.userId,
      displayName: member.displayName,
      avatarInitials: member.avatarInitials,
      color: member.color,
      isViewer,
      isKnown: true,
    };
  }

  return {
    userId: authorUserId,
    displayName: UNKNOWN_MEMBER_NAME,
    avatarInitials: UNKNOWN_MEMBER_INITIALS,
    color: memberColorForUserId(authorUserId),
    isViewer,
    isKnown: false,
  };
}

/** Whether this workspace holds anybody other than the person reading. */
function hasOtherMembers(members: CollaborationMembers): boolean {
  for (const userId of members.byUserId.keys()) {
    if (userId !== members.viewerUserId) {
      return true;
    }
  }
  return false;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return a.groupedEntries === (b as typeof a).groupedEntries;

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
