import type {
  CollaborationActivity,
  CollaborationPresence,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitBranchIcon,
  HandCoinsIcon,
  KeyRoundIcon,
  MessageSquarePlusIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { CollaborationGovernance } from "../../hooks/useCollaborationGovernance";
import type { ProviderSharing } from "../../hooks/useProviderSharing";
import type { ProviderUsage } from "../../hooks/useProviderUsageRequests";
import { cn } from "../../lib/utils";
import { CollaborationBranchSection } from "./CollaborationBranchSection";
import {
  CollaborationBranchClaims,
  CollaborationGovernancePanel,
  CollaborationWorkingPills,
} from "./CollaborationGovernancePanel";
import {
  CollaborationAvatar,
  CollaborationPeople,
  type CollaborationRoster,
} from "./CollaborationPeople";
import {
  buildCollaborationOverview,
  closeCollaborationSection,
  COLLABORATION_PANEL_ROOT,
  COLLABORATION_SECTION_TITLE,
  openCollaborationSection,
  presenceInitials,
  resolveVisibleSection,
  type CollaborationOverviewRow,
  type CollaborationPanelNav,
  type CollaborationSectionId,
} from "./collaborationPanel.logic";
import { memberColorForUserId } from "./collaborationRoster.logic";
import { findContention } from "./contention.logic";
import { ProviderSharingSection } from "./ProviderSharingSection";
import { ProviderUsageRequestsView } from "./ProviderUsageRequests";
import { UsageSparkline } from "./usage/UsageBarSeries";
import { USAGE_PALETTE } from "./usage/usagePalette";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const SECTION_ICON: Record<CollaborationSectionId, LucideIcon> = {
  activity: ActivityIcon,
  people: UsersRoundIcon,
  approvals: ShieldCheckIcon,
  branch: GitBranchIcon,
  sharing: KeyRoundIcon,
  requests: HandCoinsIcon,
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The collaboration popover, as an overview you can read in one look and one
 * section at a time behind it.
 *
 * Six sections stacked in 22rem was six things all shouting at the same volume,
 * and the panel had stopped answering the question people open it with — is
 * anything happening, and is any of it waiting on me. Every row here answers
 * that in a line; the section behind it is the one that was there before,
 * unchanged, with every control it always had.
 */
export function CollaborationPanel({
  activities,
  baseBranch,
  environmentId,
  governance,
  onManageSharing,
  onShareActivity,
  onToggleActivityHidden,
  presence,
  presentCount,
  roster,
  sharing,
  usage,
  workspaceRoot,
  workspaceTitle,
}: {
  readonly activities: readonly CollaborationActivity[];
  readonly baseBranch: string | null;
  readonly environmentId: EnvironmentId;
  readonly governance: CollaborationGovernance;
  /** Opens the admin roster, which genuinely does not fit in a popover. */
  readonly onManageSharing: () => void;
  readonly onShareActivity: (prompt: string) => Promise<void>;
  readonly onToggleActivityHidden: (activity: CollaborationActivity) => void;
  /** Everybody in the thread who is not offline. */
  readonly presence: readonly CollaborationPresence[];
  readonly presentCount: number;
  readonly roster: CollaborationRoster;
  readonly sharing: ProviderSharing;
  readonly usage: ProviderUsage;
  readonly workspaceRoot: string | null;
  readonly workspaceTitle: string | null;
}) {
  const [nav, setNav] = useState<CollaborationPanelNav>(COLLABORATION_PANEL_ROOT);

  const overview = sharing.overview;
  const rows = buildCollaborationOverview({
    now: Date.now(),
    activities,
    presence,
    members: roster.loaded ? roster.members : null,
    governance: {
      loaded: governance.settings !== null,
      approvalMode: governance.settings?.approvalMode ?? null,
      pendingApprovalCount: governance.pendingApprovals.length,
      canDecide: governance.canDecide,
      // The same window the governance section draws from, so the preview and
      // the section it opens can never disagree about who is where.
      contendedCount: findContention(governance.touches, { now: Date.now() }).length,
      branchClaims: governance.branchClaims,
      myBranchClaim: governance.myBranchClaim,
    },
    sharing: overview,
    // Both halves come off different calls, and the row needs the viewer's own
    // accounts to say anything true about what they can and cannot run.
    requests:
      overview && usage.loaded
        ? {
            requests: usage.requests,
            canRespond: usage.canRespond,
            viewerUserId: overview.viewerUserId,
            viewerAccounts: overview.viewerAccounts,
          }
        : null,
  });

  const section = resolveVisibleSection(nav, rows);

  if (section === null) {
    return (
      <div className={USAGE_PALETTE} data-testid="collaboration-panel">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Collaboration</div>
          <div className="text-[10px] text-muted-foreground">{presentCount} present</div>
        </div>
        <div
          // `starting:` gives the swap back from a section a direction without
          // a keyframe of its own; the popover owns the open animation.
          key="overview"
          className="mt-2 divide-y divide-border/50 transition-[opacity,translate] duration-150 starting:-translate-x-1 starting:opacity-0"
          data-testid="collaboration-overview"
        >
          {rows.map((row) => (
            <OverviewRow
              key={row.id}
              row={row}
              governance={governance}
              presence={presence}
              onOpen={() => setNav(openCollaborationSection(row.id))}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={USAGE_PALETTE} data-testid="collaboration-panel">
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          className="-ml-1.5"
          aria-label="Back to the collaboration overview"
          data-testid="collaboration-panel-back"
          onClick={() => setNav(closeCollaborationSection())}
        >
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
        <div className="min-w-0 flex-1 truncate text-right text-sm font-medium">
          {COLLABORATION_SECTION_TITLE[section]}
        </div>
      </div>

      <div
        key={section}
        className="mt-3 border-t border-border pt-3 transition-[opacity,translate] duration-150 starting:translate-x-1 starting:opacity-0"
        data-testid="collaboration-section"
        data-section={section}
      >
        {section === "activity" ? (
          <ActivitySection
            activities={activities}
            viewerUserId={governance.viewerUserId}
            onShare={onShareActivity}
            onToggleHidden={onToggleActivityHidden}
          />
        ) : null}

        {section === "people" ? (
          <div className="grid gap-3">
            <CollaborationWorkingPills presence={presence} />
            <CollaborationPeople roster={roster} />
          </div>
        ) : null}

        {section === "approvals" ? <CollaborationGovernancePanel governance={governance} /> : null}

        {section === "branch" ? (
          <div className="grid gap-3">
            <CollaborationBranchSection
              environmentId={environmentId}
              governance={governance}
              workspaceRoot={workspaceRoot}
              baseBranch={baseBranch}
              displayName={governance.viewerDisplayName}
            />
            <CollaborationBranchClaims
              governance={governance}
              environmentId={environmentId}
              workspaceRoot={workspaceRoot}
            />
          </div>
        ) : null}

        {section === "sharing" ? (
          <ProviderSharingSection
            sharing={sharing}
            workspaceTitle={workspaceTitle}
            onManage={onManageSharing}
          />
        ) : null}

        {section === "requests" && overview ? (
          <ProviderUsageRequestsView
            usage={usage}
            workspaceLabel={workspaceTitle?.trim() || "this workspace"}
            viewerUserId={overview.viewerUserId}
            viewerAccounts={overview.viewerAccounts}
            workspaceAccounts={overview.workspaceAccounts}
          />
        ) : null}
      </div>
    </div>
  );
}

function OverviewRow({
  governance,
  onOpen,
  presence,
  row,
}: {
  governance: CollaborationGovernance;
  onOpen: () => void;
  presence: readonly CollaborationPresence[];
  row: CollaborationOverviewRow;
}) {
  const Icon = SECTION_ICON[row.id];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-2.5 py-2 text-left transition-colors hover:bg-muted/40"
      data-testid={`collaboration-row-${row.id}`}
      data-section={row.id}
      data-attention={row.attention ? "true" : "false"}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
          row.attention
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border/70 bg-muted/40 text-muted-foreground group-hover:text-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{row.title}</span>
          {row.badge !== null ? (
            <span
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground"
              data-testid="collaboration-overview-badge"
            >
              {row.badge}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-[10px]",
            row.quiet ? "text-muted-foreground/70" : "text-muted-foreground",
          )}
        >
          {row.summary}
        </span>
      </span>

      <RowPreview row={row} presence={presence} governance={governance} />

      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

/**
 * The small visual beside a row, where the data has a shape.
 *
 * Only two rows do. Activity is a count over time, which is a chart; presence
 * is a handful of people, which is their faces. Everything else — an approval
 * mode, a branch name, a pair of switches — is a fact rather than a
 * distribution, and drawing it as a chart would be decoration pretending to be
 * information.
 */
function RowPreview({
  governance,
  presence,
  row,
}: {
  governance: CollaborationGovernance;
  presence: readonly CollaborationPresence[];
  row: CollaborationOverviewRow;
}) {
  if (row.id === "activity") {
    if (!row.sparkline) {
      return null;
    }
    return (
      <UsageSparkline
        ariaLabel={`${row.sparkline.total} shared updates, oldest to newest`}
        bars={row.sparkline.buckets.map((bucket) => ({
          key: bucket.key,
          value: bucket.count,
          title: `${bucket.count} update${bucket.count === 1 ? "" : "s"} around ${formatTime(new Date(bucket.startedAt).toISOString())}`,
        }))}
        className="shrink-0"
      />
    );
  }

  if (row.id === "people" && presence.length > 0) {
    const shown = presence.slice(0, 3);
    const rest = presence.length - shown.length;
    return (
      <span
        className="flex shrink-0 items-center gap-1"
        data-testid="collaboration-presence-cluster"
      >
        <span className="flex -space-x-1.5">
          {shown.map((entry) => (
            <CollaborationAvatar
              key={entry.userId}
              size="xs"
              showStatus
              member={{
                displayName: entry.displayName,
                avatarInitials: presenceInitials(entry),
                color:
                  governance.memberColorByUserId.get(entry.userId) ??
                  memberColorForUserId(entry.userId),
                status: entry.status,
              }}
            />
          ))}
        </span>
        {rest > 0 ? <span className="text-[10px] text-muted-foreground">+{rest}</span> : null}
      </span>
    );
  }

  return null;
}

/**
 * What has been shared in this thread, and the box for adding to it.
 *
 * The composer sits here rather than on the overview because sharing a prompt
 * is what puts an entry in this list — the two belong to the same act, and a
 * text box on a screen of one-line summaries would be the one thing on it that
 * was not a summary.
 */
function ActivitySection({
  activities,
  onShare,
  onToggleHidden,
  viewerUserId,
}: {
  activities: readonly CollaborationActivity[];
  onShare: (prompt: string) => Promise<void>;
  onToggleHidden: (activity: CollaborationActivity) => void;
  viewerUserId: string | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <Textarea
        size="sm"
        value={prompt}
        placeholder="Share a prompt with this thread"
        onChange={(event) => setPrompt(event.currentTarget.value)}
      />
      <div className="mt-2 flex justify-end">
        <Button
          size="xs"
          disabled={busy || prompt.trim().length === 0}
          onClick={() => {
            setBusy(true);
            onShare(prompt.trim())
              .then(() => setPrompt(""))
              .catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not share prompt",
                  description: error instanceof Error ? error.message : "The request failed.",
                });
              })
              .finally(() => setBusy(false));
          }}
        >
          <MessageSquarePlusIcon className="size-3.5" />
          Share
        </Button>
      </div>

      <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto border-t border-border pt-3 pr-1">
        {activities.length > 0 ? (
          activities.map((activity) => (
            <div key={activity.id} className="text-xs">
              <div className="text-foreground">{activity.summary}</div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span>
                  {activity.kind} · {formatTime(activity.createdAt)}
                </span>
                {activity.userId === viewerUserId ? (
                  <button
                    type="button"
                    data-testid="collaboration-activity-visibility"
                    className="rounded px-1 text-[10px] underline-offset-2 hover:underline"
                    onClick={() => onToggleHidden(activity)}
                  >
                    {activity.hiddenAt === null ? "Hide from others" : "Hidden — show again"}
                  </button>
                ) : null}
              </div>
            </div>
          ))
        ) : (
          <div className="text-xs text-muted-foreground">No shared activity yet.</div>
        )}
      </div>
    </div>
  );
}
