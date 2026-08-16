import type {
  CollaborationMember,
  EnvironmentId,
  ProviderAccessMode,
  ProviderAuthKind,
  ProviderPolicyMode,
  ProviderSharingOverviewResult,
  ProviderWorkspaceAccount,
  TenantId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useCollaborationMembers } from "../../hooks/useCollaborationMembers";
import type { ProviderSharing } from "../../hooks/useProviderSharing";
import { cn } from "../../lib/utils";
import { CollaborationAvatar } from "./CollaborationPeople";
import {
  PROVIDER_LABEL,
  PROVIDERS,
  readMemberAccess,
  readWorkspacePolicy,
} from "./providerSharing.logic";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function reportFailure(title: string) {
  return (error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    });
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function accountName(account: ProviderWorkspaceAccount): string {
  return `${account.displayName} · ${account.label}`;
}

function Choice({
  selected,
  className,
  ...rest
}: React.ComponentProps<"button"> & { selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "truncate rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-50",
        selected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
        className,
      )}
      {...rest}
    />
  );
}

function PolicyBlock({
  overview,
  provider,
  sharing,
}: {
  overview: ProviderSharingOverviewResult;
  provider: ProviderAuthKind;
  sharing: ProviderSharing;
}) {
  const [busy, setBusy] = useState(false);
  const view = readWorkspacePolicy(overview, provider);
  const label = PROVIDER_LABEL[provider];

  const write = (patch: {
    mode: ProviderPolicyMode;
    sharedOwnerUserId?: UserId | null;
    sharedAccountId?: ProviderWorkspaceAccount["accountId"] | null;
  }) => {
    setBusy(true);
    sharing
      .setPolicy({ provider, ...patch })
      .catch(reportFailure(`Could not change what this workspace runs ${label} on`))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="rounded-md border border-border/70 p-3"
      data-testid="provider-sharing-policy"
      data-provider={provider}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="flex gap-1">
          <Choice
            selected={view.mode === "own"}
            disabled={busy}
            data-testid="provider-sharing-policy-own"
            onClick={() => {
              if (view.mode !== "own") {
                // Explicit nulls, not absent fields: absent means "leave as is",
                // which would keep the workspace pinned to somebody's account.
                write({ mode: "own", sharedOwnerUserId: null, sharedAccountId: null });
              }
            }}
          >
            Members' own
          </Choice>
          <Choice
            selected={view.mode === "shared"}
            disabled={busy || view.candidates.length === 0}
            title={
              view.candidates.length === 0
                ? `Nobody has contributed a ${label} account to this workspace yet.`
                : undefined
            }
            data-testid="provider-sharing-policy-shared"
            onClick={() => {
              const first = view.candidates[0];
              if (view.mode === "shared" || !first) return;
              write({
                mode: "shared",
                sharedOwnerUserId: first.userId,
                sharedAccountId: first.accountId,
              });
            }}
          >
            One shared account
          </Choice>
        </div>
      </div>

      {view.mode === "shared" ? (
        <div className="mt-2 grid gap-1.5">
          <div className="text-[10px] text-muted-foreground">Runs on</div>
          <div className="flex flex-wrap gap-1">
            {view.candidates.map((account) => (
              <Choice
                key={`${account.userId}:${account.accountId}`}
                selected={
                  account.userId === view.account?.userId &&
                  account.accountId === view.account.accountId
                }
                disabled={busy}
                data-testid="provider-sharing-policy-account"
                onClick={() =>
                  write({
                    mode: "shared",
                    sharedOwnerUserId: account.userId,
                    sharedAccountId: account.accountId,
                  })
                }
              >
                {accountName(account)}
              </Choice>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Everyone runs {label} on their own account, and anyone without one is refused.
        </div>
      )}

      {view.candidates.length === 0 ? (
        <div className="mt-2 text-[10px] leading-4 text-muted-foreground">
          No {label} account has been contributed here. Someone has to switch on “Contribute my{" "}
          {label}” in the collaboration panel first.
        </div>
      ) : null}

      {view.problem ? (
        <div
          className="mt-2 flex gap-1.5 rounded border border-destructive/40 bg-destructive/5 p-2"
          data-testid="provider-sharing-policy-problem"
        >
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
          <div className="text-[10px] leading-4 text-muted-foreground">
            <span className="font-medium text-destructive">
              {view.problem === "not-shared"
                ? `The ${label} account this workspace runs on is no longer contributed.`
                : `The ${label} account this workspace runs on is no longer connected.`}
            </span>{" "}
            New turns fall back to each member's own account, and are refused for anyone without
            one. Pick another account, or switch back to members' own.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MemberRow({
  overview,
  member,
  sharing,
}: {
  overview: ProviderSharingOverviewResult;
  member: CollaborationMember;
  sharing: ProviderSharing;
}) {
  const [busy, setBusy] = useState(false);

  const write = (provider: ProviderAuthKind, access: ProviderAccessMode) => {
    setBusy(true);
    sharing
      .setMemberAccess({ userId: member.userId, provider, access })
      .catch(reportFailure(`Could not change what ${member.displayName} runs on`))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="rounded-md border border-border/70 px-2 py-2"
      data-testid="provider-sharing-member-row"
      data-user={member.userId}
    >
      <div className="flex items-center gap-2">
        <CollaborationAvatar member={member} showStatus />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {member.displayName}
        </span>
      </div>
      <div className="mt-1.5 grid gap-1">
        {PROVIDERS.map((provider) => {
          const access = readMemberAccess(overview, member.userId, provider);
          return (
            <div key={provider} className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[10px] text-muted-foreground">
                {PROVIDER_LABEL[provider]}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                {access.isExplicit ? "Set for this person" : "Following the workspace default"}
              </span>
              <div className="flex shrink-0 gap-1">
                <Choice
                  selected={access.access === "own"}
                  disabled={busy}
                  data-testid="provider-sharing-member-own"
                  data-provider={provider}
                  onClick={() => write(provider, "own")}
                >
                  Their own
                </Choice>
                <Choice
                  selected={access.access === "workspace"}
                  disabled={busy}
                  data-testid="provider-sharing-member-workspace"
                  data-provider={provider}
                  onClick={() => write(provider, "workspace")}
                >
                  Workspace account
                </Choice>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The dialog's contents, split out so the member roster is only fetched and
 * subscribed to while the dialog is open — everything inside a closed
 * `DialogPopup` is unmounted.
 */
function ProviderSharingDialogBody({
  environmentId,
  tenantId,
  workspaceId,
  workspaceLabel,
  sharing,
}: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
  workspaceLabel: string;
  sharing: ProviderSharing;
}) {
  const { byUserId } = useCollaborationMembers({ environmentId, tenantId, workspaceId });
  const members = useMemo(
    () =>
      [...byUserId.values()].toSorted((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    [byUserId],
  );

  const overview = sharing.overview;

  return (
    <>
      <DialogTitle>Provider accounts in {workspaceLabel}</DialogTitle>
      <p className="mt-1 text-xs text-muted-foreground">
        Changes here apply to {workspaceLabel} only, and stop new turns rather than turns already
        running.
      </p>

      {!overview ? (
        <div className="mt-4 text-xs text-muted-foreground">Loading…</div>
      ) : !overview.canManage ? (
        // The server sends admin-only fields as empty arrays, so without this
        // a demoted admin would see three convincing but empty sections.
        <div className="mt-4 text-xs text-muted-foreground">
          Only a workspace admin can choose what this workspace runs on.
        </div>
      ) : (
        <>
          <section className="mt-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              What this workspace runs on
            </div>
            <div className="grid gap-2">
              {PROVIDERS.map((provider) => (
                <PolicyBlock
                  key={provider}
                  overview={overview}
                  provider={provider}
                  sharing={sharing}
                />
              ))}
            </div>
          </section>

          <section className="mt-5">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Who uses which account
            </div>
            <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
              Anyone on the workspace account spends the owner's subscription. Anyone on their own
              is refused a turn until they connect one.
            </p>
            {members.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">
                Nobody else has joined this workspace yet.
              </div>
            ) : (
              <div className="grid gap-1.5">
                {members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    overview={overview}
                    member={member}
                    sharing={sharing}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="mt-5">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Accounts connected here
            </div>
            <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
              Names and labels only — credentials never leave the server.
            </p>
            {overview.workspaceAccounts.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">
                Nobody in this workspace has connected a Claude or Codex account yet.
              </div>
            ) : (
              <div className="grid gap-1">
                {overview.workspaceAccounts.map((account) => (
                  <div
                    key={`${account.userId}:${account.provider}:${account.accountId}`}
                    className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1.5"
                    data-testid="provider-sharing-workspace-account"
                    data-provider={account.provider}
                  >
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                      {account.displayName}
                      <span className="text-muted-foreground">
                        {" · "}
                        {PROVIDER_LABEL[account.provider]} · {account.label}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatDate(account.createdAt)}
                    </span>
                    {account.isShared ? (
                      <Badge size="sm" variant="success">
                        Contributed
                      </Badge>
                    ) : (
                      <Badge size="sm" variant="outline">
                        Private
                      </Badge>
                    )}
                    {account.isWorkspaceDefault ? (
                      <Badge size="sm" variant="info">
                        Workspace default
                      </Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

/**
 * The admin half of provider sharing: whose subscription the workspace runs on,
 * who is allowed to use it, and every account connected here.
 *
 * It is a dialog rather than more of the popover because a roster and a
 * per-person, per-provider matrix do not fit in 22rem, and it is rendered as a
 * sibling of the popover so that opening it does not unmount it.
 */
export function ProviderSharingDialog({
  environmentId,
  tenantId,
  workspaceId,
  workspaceTitle,
  sharing,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
  workspaceTitle: string | null;
  sharing: ProviderSharing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogPanel data-testid="provider-sharing-dialog">
          <ProviderSharingDialogBody
            environmentId={environmentId}
            tenantId={tenantId}
            workspaceId={workspaceId}
            workspaceLabel={workspaceTitle?.trim() || "this workspace"}
            sharing={sharing}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
