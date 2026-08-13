import { GitBranchIcon, GitMergeIcon, TriangleAlertIcon } from "lucide-react";
import type {
  EnvironmentId,
  GitCompareBranchesResult,
  GitMergeBranchResult,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import type { CollaborationGovernance } from "../../hooks/useCollaborationGovernance";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Keeps a branch name usable by git and recognisable as a person's. */
function toBranchSlug(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "collaborator";
}

function worktreeSiblingPath(workspaceRoot: string, branchSlug: string): string {
  const normalized = workspaceRoot.replace(/[/\\]+$/, "");
  const separator = normalized.includes("\\") ? "\\" : "/";
  const parent = normalized.slice(0, normalized.lastIndexOf(separator));
  const base = normalized.slice(normalized.lastIndexOf(separator) + 1);
  return `${parent}${separator}${base}-${branchSlug}`;
}

/**
 * Offers a personal branch when the workspace expects one, and once taken,
 * compares it against the shared branch so overlapping edits show up before
 * anyone attempts the merge.
 */
export function CollaborationBranchSection({
  environmentId,
  governance,
  workspaceRoot,
  baseBranch,
  displayName,
}: {
  environmentId: EnvironmentId | null;
  governance: CollaborationGovernance;
  workspaceRoot: string | null;
  baseBranch: string | null;
  displayName: string;
}) {
  const { settings, myBranchClaim, claimBranch } = governance;
  const [creating, setCreating] = useState(false);
  const [comparison, setComparison] = useState<GitCompareBranchesResult | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeOutcome, setMergeOutcome] = useState<GitMergeBranchResult | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Only the mode that puts people on their own branches should nag about it.
  const shouldOfferBranch =
    settings?.approvalMode === "staged" &&
    myBranchClaim === null &&
    workspaceRoot !== null &&
    baseBranch !== null &&
    !dismissed;

  const createBranch = useCallback(async () => {
    if (!environmentId || !workspaceRoot || !baseBranch) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    const slug = toBranchSlug(displayName);
    const branch = `collab/${slug}`;
    const worktreePath = worktreeSiblingPath(workspaceRoot, slug);

    setCreating(true);
    try {
      await api.git.createWorktree({
        cwd: workspaceRoot,
        branch: baseBranch,
        newBranch: branch,
        path: worktreePath,
      });
      await claimBranch({ branch, baseBranch, worktreePath });
      toastManager.add({
        type: "success",
        title: "Branch created",
        description: `${branch} at ${worktreePath}`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create your branch",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setCreating(false);
    }
  }, [baseBranch, claimBranch, displayName, environmentId, workspaceRoot]);

  /**
   * Merges this person's branch into the base it was cut from.
   *
   * A conflict is reported rather than resolved: git could not choose, and
   * neither can this. What it can do is name the files and say plainly that
   * somebody has to decide, which is more than a warning with no next step.
   */
  const mergeIntoBase = useCallback(async () => {
    if (!environmentId || !workspaceRoot || !myBranchClaim) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;

    setMerging(true);
    try {
      const result = await api.git.mergeBranch({
        cwd: workspaceRoot,
        branch: myBranchClaim.branch,
      });
      setMergeOutcome(result);
      if (result.status !== "conflicts") {
        toastManager.add({
          type: "success",
          title:
            result.status === "up-to-date"
              ? `${myBranchClaim.baseBranch} was already up to date`
              : `Merged into ${myBranchClaim.baseBranch}`,
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not merge",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setMerging(false);
    }
  }, [environmentId, myBranchClaim, workspaceRoot]);

  useEffect(() => {
    if (!environmentId || !workspaceRoot || !myBranchClaim) {
      setComparison(null);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    let disposed = false;
    api.git
      .compareBranches({
        cwd: workspaceRoot,
        baseBranch: myBranchClaim.baseBranch,
        headBranch: myBranchClaim.branch,
      })
      .then((result) => {
        if (!disposed) {
          setComparison(result);
        }
      })
      // A repo without those refs yet simply has nothing to compare.
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [environmentId, myBranchClaim, workspaceRoot]);

  if (shouldOfferBranch) {
    return (
      <div
        className="rounded-md border border-primary/40 bg-primary/5 p-2"
        data-testid="collaboration-branch-offer"
      >
        <div className="text-xs font-medium text-foreground">Work on your own branch?</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          This workspace reviews work on merge. Your own branch keeps your changes out of{" "}
          {baseBranch} until then.
        </div>
        <div className="mt-2 flex gap-1">
          <Button
            size="xs"
            disabled={creating}
            data-testid="collaboration-branch-create"
            onClick={() => void createBranch()}
          >
            <GitBranchIcon className="size-3.5" />
            Create branch
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setDismissed(true)}>
            Not now
          </Button>
        </div>
      </div>
    );
  }

  if (!myBranchClaim) {
    return null;
  }

  return (
    <div className="rounded-md border border-border p-2" data-testid="collaboration-branch-compare">
      <div className="flex items-center gap-1.5">
        <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {myBranchClaim.branch}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          vs {myBranchClaim.baseBranch}
        </span>
      </div>
      {comparison ? (
        <>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <GitMergeIcon className="size-3" />
            <span>
              {comparison.aheadCount} ahead · {comparison.behindCount} behind ·{" "}
              {comparison.files.length} files
            </span>
          </div>
          {comparison.overlappingPaths.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-destructive/40 bg-destructive/5 p-1.5"
              data-testid="collaboration-conflict-warning"
            >
              <div className="flex items-center gap-1 text-[11px] font-medium text-destructive">
                <TriangleAlertIcon className="size-3" />
                Both branches changed these files
              </div>
              <div className="mt-1 grid gap-0.5">
                {comparison.overlappingPaths.slice(0, 6).map((path) => (
                  <div key={path} className="truncate font-mono text-[10px] text-foreground">
                    {path}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* A warning with nothing to do about it leaves the reader stuck,
              which is where this section used to end. */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={merging || comparison.aheadCount === 0}
              data-testid="collaboration-merge-branch"
              onClick={() => void mergeIntoBase()}
            >
              <GitMergeIcon className="size-3.5" />
              {merging ? "Merging…" : `Merge into ${myBranchClaim.baseBranch}`}
            </Button>
            {comparison.aheadCount === 0 ? (
              <span className="text-[10px] text-muted-foreground">Nothing to merge yet</span>
            ) : null}
          </div>

          {mergeOutcome ? (
            <div
              className="mt-1.5 rounded border border-border p-1.5 text-[11px]"
              data-testid="collaboration-merge-outcome"
              data-status={mergeOutcome.status}
            >
              {mergeOutcome.status === "conflicts" ? (
                <>
                  <div className="font-medium text-destructive">
                    Git could not merge these on its own
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Both sides changed the same lines. Open each file, decide what it should say,
                    and commit — nothing here can choose for you.
                  </div>
                  <div className="mt-1 grid gap-0.5">
                    {mergeOutcome.conflictPaths.map((path) => (
                      <div key={path} className="truncate font-mono text-[10px] text-foreground">
                        {path}
                      </div>
                    ))}
                  </div>
                </>
              ) : mergeOutcome.status === "up-to-date" ? (
                <span className="text-muted-foreground">
                  {myBranchClaim.baseBranch} already has everything on this branch.
                </span>
              ) : (
                <span className="text-foreground">
                  Merged into {myBranchClaim.baseBranch}.
                </span>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
