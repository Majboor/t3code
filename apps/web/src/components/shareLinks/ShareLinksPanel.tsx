import type {
  EnvironmentId,
  ProjectId,
  ShareLink,
  ShareLinkScope,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { CopyIcon, LinkIcon, UsersIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { useShareLinks } from "./useShareLinks";
import {
  describeShareLinkScope,
  describeShareLinkState,
  describeShareLinkViews,
  formatShareLinkTime,
  readShareLinkState,
  selectShareLinksForPanel,
  shareLinkTitle,
} from "./shareLinks.logic";

/**
 * The links this project and its workspace have handed out.
 *
 * Two separate creation blocks, not one control with a scope picker: a project
 * link publishes files to anyone holding a URL, a workspace link brings a
 * stranger inside as a collaborator, and the panel says which is which above
 * each button rather than after the fact.
 *
 * No row can show its URL. The token comes back from `create` alone, so a link
 * is copied at the instant it is made and afterwards this panel can only report
 * that it exists, what it reaches, and whether it still works.
 */
export function ShareLinksPanel({
  environmentId,
  tenantId,
  workspaceId,
  projectId,
  projectLabel,
  workspaceLabel,
  onClose,
}: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;
  projectLabel: string;
  workspaceLabel: string;
  onClose?: () => void;
}) {
  const shareLinks = useShareLinks({ environmentId, tenantId, workspaceId, projectId });
  const [labels, setLabels] = useState<Partial<Record<ShareLinkScope, string>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** The one URL a clipboard refused, kept only until somebody has read it. */
  const [uncopied, setUncopied] = useState<string | null>(null);
  const nowIso = new Date().toISOString();

  const visible = selectShareLinksForPanel(shareLinks.links, projectId);

  const mint = (scope: ShareLinkScope) => {
    setBusyKey(scope);
    void shareLinks
      .mint({ scope, label: labels[scope] ?? null })
      .then((minted) => {
        if (!minted) {
          return;
        }
        setLabels((current) => ({ ...current, [scope]: "" }));
        // Kept only when the clipboard refused it. The token is not in any
        // later reply, so this render is the last place the URL can be read.
        setUncopied(minted.copied ? null : minted.url);
      })
      .finally(() => setBusyKey(null));
  };

  const renderCreate = (scope: "project" | "workspace"): ReactNode => {
    const copy = describeShareLinkScope(scope, { projectLabel, workspaceLabel });
    const blocked = scope === "project" && projectId === null;
    return (
      <div
        className="rounded-md border border-border p-2"
        data-testid="share-links-create"
        data-scope={scope}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {scope === "workspace" ? (
            <UsersIcon className="size-3.5 shrink-0" />
          ) : (
            <LinkIcon className="size-3.5 shrink-0" />
          )}
          {scope === "workspace" ? "Invite a collaborator" : "Share the whole project"}
        </div>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{copy.consequence}</p>
        <div className="mt-1.5 flex items-center gap-1">
          <Input
            size="sm"
            value={labels[scope] ?? ""}
            aria-label={`Name this ${scope} link`}
            placeholder="Name it, for your own list (optional)"
            data-testid="share-links-label"
            data-scope={scope}
            onChange={(event) => setLabels({ ...labels, [scope]: event.currentTarget.value })}
          />
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={busyKey !== null || blocked}
            data-testid="share-links-mint"
            data-scope={scope}
            onClick={() => mint(scope)}
          >
            {copy.action}
          </Button>
        </div>
        {blocked ? (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Open a project first — there is nothing to point a project link at.
          </p>
        ) : null}
      </div>
    );
  };

  const renderRow = (link: ShareLink): ReactNode => {
    const state = readShareLinkState(link, nowIso);
    const copy = describeShareLinkScope(link.scope, { projectLabel, workspaceLabel });
    return (
      <div
        key={link.id}
        className={cn("rounded-md border border-border p-2", state !== "active" && "opacity-72")}
        data-testid="share-links-row"
        data-link={link.id}
        data-state={state}
        data-scope={link.scope}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {shareLinkTitle(link)}
          </span>
          <span className="shrink-0 rounded-sm border border-border px-1 text-[10px] text-muted-foreground">
            {copy.badge}
          </span>
          {state !== "active" ? (
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              data-testid="share-links-row-state"
            >
              {state === "revoked" ? "Revoked" : "Expired"}
            </span>
          ) : null}
        </div>
        <div className="text-[10px] leading-4 text-muted-foreground">
          Made {formatShareLinkTime(link.createdAt)} · {describeShareLinkViews(link)}
        </div>
        <div className="text-[10px] leading-4 text-muted-foreground">
          {describeShareLinkState(link, nowIso)}
        </div>
        {/* The URL is not here and cannot be: `create` returned the token once
            and `list` never does. Saying so is better than a copy button that
            would have nothing to copy. */}
        <div className="text-[10px] leading-4 text-muted-foreground">
          The URL was copied when it was made. It cannot be shown again — revoke this and make a new
          one if it was lost.
        </div>
        {state === "active" ? (
          <Button
            size="xs"
            variant="outline"
            className="mt-1.5"
            disabled={busyKey === link.id}
            data-testid="share-links-revoke"
            data-link={link.id}
            onClick={() => {
              setBusyKey(link.id);
              void shareLinks.revoke(link.id).finally(() => setBusyKey(null));
            }}
          >
            Revoke
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="border-b border-border/50 px-3 py-2" data-testid="share-links-panel">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-foreground">Share links</div>
        {onClose ? (
          <Button size="icon-xs" variant="ghost" aria-label="Close share links" onClick={onClose}>
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {uncopied ? (
        <div
          className="mb-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2"
          data-testid="share-links-uncopied"
        >
          <div className="text-xs font-medium text-foreground">Copy this now</div>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            The clipboard refused it and nothing can fetch this URL again.
          </p>
          <div className="mt-1.5 flex min-w-0 items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">
              {uncopied}
            </code>
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              data-testid="share-links-uncopied-copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(uncopied)
                  .then(() => setUncopied(null))
                  .catch(() =>
                    toastManager.add({
                      type: "error",
                      title: "Still could not copy",
                      description: "Select the URL above and copy it by hand.",
                    }),
                  );
              }}
            >
              <CopyIcon className="size-3" />
              Copy
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        {renderCreate("project")}
        {renderCreate("workspace")}
      </div>

      <div className="mt-2 grid gap-1.5">
        {!shareLinks.loaded ? (
          <p className="text-[10px] text-muted-foreground">Reading this workspace's links…</p>
        ) : visible.length === 0 ? (
          <p
            className="text-[10px] leading-4 text-muted-foreground"
            data-testid="share-links-empty"
          >
            No links yet. Nothing in {projectLabel} is reachable without an account until you make
            one.
          </p>
        ) : (
          visible.map(renderRow)
        )}
      </div>
    </div>
  );
}
