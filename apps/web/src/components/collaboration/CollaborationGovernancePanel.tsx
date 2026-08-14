import { UsersRoundIcon, CheckIcon, GitBranchIcon, XIcon } from "lucide-react";
import type {
  EnvironmentId,
  CollaborationApprovalMode,
  CollaborationPresence,
  CollaborationPromptApproval,
} from "@t3tools/contracts";
import { useState } from "react";

import type { CollaborationGovernance } from "../../hooks/useCollaborationGovernance";
import { cn } from "../../lib/utils";
import { findContention } from "./contention.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

const APPROVAL_MODES: ReadonlyArray<{
  readonly value: CollaborationApprovalMode;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "open", label: "Open", hint: "Anyone can prompt the agent." },
  { value: "blocking", label: "Needs approval", hint: "Prompts wait for a lead." },
  { value: "staged", label: "Own branch", hint: "Runs, but merges get reviewed." },
];

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function reportFailure(title: string) {
  return (error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    });
  };
}

/**
 * A pill per person that fills while they are actively working, so it reads as
 * progress at a glance rather than another static status dot.
 */
export function CollaborationWorkingPills({
  presence,
}: {
  presence: readonly CollaborationPresence[];
}) {
  if (presence.length === 0) {
    return <div className="text-sm text-muted-foreground">No one else is present.</div>;
  }

  return (
    <div className="grid gap-1.5">
      {presence.map((entry) => (
        <div key={entry.userId} className="flex items-center gap-2">
          <div
            className="relative h-5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
            data-testid="collaboration-working-pill"
            data-status={entry.status}
          >
            {entry.status === "active" ? (
              <span className="absolute inset-y-0 left-0 w-full animate-[collab-fill_2.4s_ease-in-out_infinite] rounded-full bg-primary/25" />
            ) : null}
            <span className="relative flex h-full items-center px-2 text-[10px] font-medium text-foreground">
              <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
              <span className="ml-2 shrink-0 text-muted-foreground">
                {entry.status === "active" ? "working" : entry.status}
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ApprovalRow({
  approval,
  canDecide,
  onDecide,
}: {
  approval: CollaborationPromptApproval;
  canDecide: boolean;
  onDecide: (decision: "approved" | "rejected") => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-md border border-border p-2" data-testid="collaboration-approval-row">
      <div className="text-xs text-foreground">{approval.prompt}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] text-muted-foreground">
          {approval.requestedByName} · {formatTime(approval.createdAt)}
        </div>
        {approval.status === "pending" && canDecide ? (
          <div className="flex shrink-0 gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              aria-label="Approve prompt"
              onClick={() => {
                setBusy(true);
                onDecide("approved");
              }}
            >
              <CheckIcon className="size-3.5" />
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              aria-label="Reject prompt"
              onClick={() => {
                setBusy(true);
                onDecide("rejected");
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">{approval.status}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The governance half of the collaboration popover: who may prompt, what is
 * waiting on a decision, whose branch is whose, and this person's own filter.
 */
export function CollaborationGovernancePanel({
  governance,
  environmentId,
  workspaceRoot,
}: {
  governance: CollaborationGovernance;
  environmentId: EnvironmentId | null;
  /** Needed to merge somebody else's branch; without it the list is read-only. */
  workspaceRoot: string | null;
}) {
  const {
    settings,
    canManage,
    pendingApprovals,
    canDecide,
    preferences,
    branchClaims,
    touches,
    myBranchClaim,
    decide,
    setApprovalMode,
    setViewPreferences,
  } = governance;

  const showOthers = preferences?.showOthersPrompts ?? true;
  // Recomputed on render rather than memoised on `touches`: the window is
  // relative to now, so a memo would keep saying two people are in a file long
  // after they both left.
  const contested = findContention(touches, { now: Date.now() });
  const [merging, setMerging] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, ReadonlyArray<string>>>({});

  /**
   * Lets whoever runs the workspace merge somebody else's branch.
   *
   * The list of branches was previously something to look at. A lead who can
   * see that two people have diverged and cannot do anything about it from
   * here has to leave and find a terminal, which is where the flow ended.
   */
  const mergeClaim = async (branch: string) => {
    if (!environmentId || !workspaceRoot) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;

    setMerging(branch);
    try {
      const result = await api.git.mergeBranch({ cwd: workspaceRoot, branch });
      if (result.status === "conflicts") {
        // Git could not choose and neither can this; name the files instead.
        setConflicts((current) => ({ ...current, [branch]: result.conflictPaths }));
        toastManager.add({
          type: "error",
          title: "Git could not merge that on its own",
          description: `${result.conflictPaths.length} file(s) need somebody to decide.`,
        });
        return;
      }
      setConflicts((current) => {
        const { [branch]: _removed, ...rest } = current;
        return rest;
      });
      toastManager.add({
        type: "success",
        title: result.status === "up-to-date" ? "Already up to date" : `Merged ${branch}`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not merge",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setMerging(null);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium">Collaborative view</div>
            <div className="text-[11px] text-muted-foreground">
              {showOthers ? "Showing everyone's work" : "Showing only your own work"}
            </div>
          </div>
          <Switch
            checked={showOthers}
            aria-label="Toggle collaborative view"
            data-testid="collaboration-view-toggle"
            onCheckedChange={(checked) => {
              // One person's filter: nobody else's view changes.
              setViewPreferences({
                showOthersPrompts: checked,
                showOthersFiles: checked,
              }).catch(reportFailure("Could not change your view"));
            }}
          />
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-muted-foreground">Prompt approvals</div>
        {canManage ? (
          <div className="grid grid-cols-3 gap-1" data-testid="collaboration-approval-modes">
            {APPROVAL_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                title={mode.hint}
                aria-pressed={settings?.approvalMode === mode.value}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] transition-colors",
                  settings?.approvalMode === mode.value
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setApprovalMode(mode.value).catch(
                    reportFailure("Could not change the approval mode"),
                  );
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            {settings?.approvalMode === "open"
              ? "Anyone in this workspace can prompt the agent."
              : settings?.approvalMode === "blocking"
                ? "Your prompts wait for the workspace lead."
                : "Your prompts run on your own branch and are reviewed on merge."}
          </div>
        )}

        <div className="mt-2 grid gap-1.5">
          {pendingApprovals.length > 0 ? (
            pendingApprovals.map((approval) => (
              <ApprovalRow
                key={approval.id}
                approval={approval}
                canDecide={canDecide}
                onDecide={(decision) => {
                  decide(approval.id, decision).catch(reportFailure("Could not decide the prompt"));
                }}
              />
            ))
          ) : (
            <div className="text-[11px] text-muted-foreground">Nothing waiting for a decision.</div>
          )}
        </div>
      </div>

      {contested.length > 0 ? (
        <div className="border-t border-border pt-3" data-testid="collaboration-contention">
          <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-500">
            <UsersRoundIcon className="size-3.5" />
            Two people are in the same file
          </div>
          <div className="grid gap-1">
            {contested.slice(0, 4).map((entry) => (
              <div
                key={entry.path}
                className="text-[11px]"
                data-testid="collaboration-contended-file"
              >
                <span className="font-mono text-foreground">{entry.path}</span>
                <span className="text-muted-foreground">
                  {" — "}
                  {entry.people.map((person) => person.displayName).join(" and ")}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            {myBranchClaim
              ? "You are on your own branch, so your edits are not landing on top of theirs."
              : "Both sets of edits land in the same file, and the last one written wins. Your own branch keeps them apart until somebody merges."}
          </p>
        </div>
      ) : null}

      {branchClaims.length > 0 ? (
        <div className="border-t border-border pt-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Branches</div>
          <div className="grid gap-1">
            {branchClaims.map((claim) => (
              <div
                key={claim.userId}
                className="flex items-center gap-2 text-[11px]"
                data-testid="collaboration-branch-claim"
              >
                <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{claim.branch}</span>
                <span className="shrink-0 text-muted-foreground">{claim.displayName}</span>
                {canManage && workspaceRoot ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={merging !== null}
                    data-testid="collaboration-merge-claim"
                    onClick={() => void mergeClaim(claim.branch)}
                  >
                    {merging === claim.branch ? "Merging…" : "Merge"}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>

          {Object.entries(conflicts).map(([branch, paths]) => (
            <div
              key={branch}
              className="mt-1.5 rounded border border-destructive/40 bg-destructive/5 p-1.5"
              data-testid="collaboration-merge-conflict"
              data-branch={branch}
            >
              <div className="text-[11px] font-medium text-destructive">
                {branch} needs somebody to decide
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                Both sides changed the same lines. Open each file, decide what it should say, and
                commit.
              </div>
              <div className="mt-1 grid gap-0.5">
                {paths.map((path) => (
                  <div key={path} className="truncate font-mono text-[10px] text-foreground">
                    {path}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
