import type { ProviderAuthKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";

import type { ProviderSharing } from "../../hooks/useProviderSharing";
import { cn } from "../../lib/utils";
import {
  describeBacking,
  PROVIDER_LABEL,
  PROVIDERS,
  readViewerSharing,
  readWorkspaceCarriers,
  type ViewerProviderSharing,
  type WorkspaceCarrier,
} from "./providerSharing.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
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

function ConnectLink({ provider }: { provider: ProviderAuthKind }) {
  return (
    <Link
      to="/settings/connections"
      className="shrink-0 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      data-testid="provider-sharing-connect-link"
      data-provider={provider}
    >
      Connect {PROVIDER_LABEL[provider]}
    </Link>
  );
}

function ProviderRow({
  view,
  workspaceLabel,
  sharing,
}: {
  view: ViewerProviderSharing;
  workspaceLabel: string;
  sharing: ProviderSharing;
}) {
  const [busy, setBusy] = useState(false);
  const label = PROVIDER_LABEL[view.provider];

  const write = (
    accountId: ViewerProviderSharing["accounts"][number]["accountId"],
    enabled: boolean,
  ) => {
    setBusy(true);
    sharing
      .setShare({ provider: view.provider, accountId, enabled })
      .catch(reportFailure(`Could not change what you share with ${workspaceLabel}`))
      .finally(() => setBusy(false));
  };

  // Requirement 2: there is nothing to contribute until an account exists, and
  // the server only ever sends genuinely connected ones — so the absence of a
  // switch here is the same fact the turn checker would report.
  if (view.accounts.length === 0) {
    return (
      <div data-testid="provider-sharing-row" data-provider={view.provider}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-foreground">{label}</div>
          <ConnectLink provider={view.provider} />
        </div>
        <div className="text-[10px] leading-4 text-muted-foreground">
          {view.access === "workspace"
            ? `You have no ${label} account, so your turns run on the workspace's.`
            : `No ${label} account connected, so there is nothing to contribute.`}
        </div>
      </div>
    );
  }

  const selected = view.selectedAccount;

  return (
    <div data-testid="provider-sharing-row" data-provider={view.provider}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">Contribute my {label}</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {view.sharedAccountMissing
              ? "Shared, but that account is no longer connected"
              : view.isSharing
                ? `Shared with ${workspaceLabel}${selected ? ` · ${selected.label}` : ""}`
                : `Not shared with ${workspaceLabel}`}
          </div>
        </div>
        <Switch
          checked={view.isSharing}
          disabled={busy || selected === null}
          aria-label={`Contribute my ${label} to ${workspaceLabel}`}
          data-testid="provider-sharing-toggle"
          data-provider={view.provider}
          onCheckedChange={(checked) => {
            if (selected) {
              write(selected.accountId, checked);
            }
          }}
        />
      </div>

      {/* Requirement 3: a picker over a single account is noise, and there is
          nothing to pick between until something is actually being shared. */}
      {view.isSharing && view.accounts.length > 1 ? (
        <div
          className="mt-1.5 grid grid-cols-2 gap-1"
          data-testid="provider-sharing-account-picker"
          data-provider={view.provider}
        >
          {view.accounts.map((account) => {
            const isSelected = account.accountId === selected?.accountId;
            return (
              <button
                key={account.accountId}
                type="button"
                disabled={busy}
                aria-pressed={isSelected}
                title={account.label}
                className={cn(
                  "truncate rounded-md border px-2 py-1 text-[10px] transition-colors",
                  isSelected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  if (!isSelected) {
                    write(account.accountId, true);
                  }
                }}
              >
                {account.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {view.access === "workspace" ? (
        <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
          Your {label} turns run on the workspace account, not this one.
        </div>
      ) : null}
    </div>
  );
}

/**
 * One person the workspace is currently running on.
 *
 * The roster never showed this, so the only way to find out whose quota was
 * paying for everybody's turns was to open the admin dialog — which most
 * members cannot — and read a policy off it. A name and a badge answer it in
 * a line, next to the switches that decide it.
 *
 * A member who cannot see the account roster gets the badge without the name,
 * because the policy tells everybody that somebody is carrying this and tells
 * only an admin who. Half an answer beats the silence that was here before,
 * and it does not invent the other half.
 */
function CarrierRow({ carrier }: { carrier: WorkspaceCarrier }) {
  const name = carrier.isViewer ? "You" : (carrier.displayName ?? "Another member");

  return (
    <div
      className="flex items-start justify-between gap-2"
      data-testid="provider-sharing-carrier"
      data-user-id={carrier.userId}
      data-viewer={carrier.isViewer ? "true" : "false"}
    >
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-foreground">{name}</div>
        {/* Labels only, never credential material — an account's name is the
            most even an admin is shown, and members are shown none of it. */}
        {carrier.accountLabels.length > 0 ? (
          <div className="truncate text-[10px] text-muted-foreground">
            {carrier.accountLabels.join(" · ")}
          </div>
        ) : null}
      </div>
      <Badge
        size="sm"
        variant={carrier.broken ? "warning" : "success"}
        className="shrink-0"
        data-testid="provider-sharing-backing-badge"
        data-broken={carrier.broken ? "true" : "false"}
      >
        {carrier.broken ? "Backing, but unavailable" : describeBacking(carrier)}
      </Badge>
    </div>
  );
}

/**
 * The compact half of provider sharing: what this person contributes, to this
 * workspace, and how to stop. Anything that needs a roster or a permission
 * matrix lives in the dialog behind Manage — this popover is 22rem wide.
 *
 * The other end of the same exchange — asking somebody to lend you an account —
 * used to hang off the bottom of this section. It is its own row in the
 * collaboration overview now, because stacking the two made a section nobody
 * could take in at a glance, and what you give and what you need are asked at
 * different moments.
 */
export function ProviderSharingSection({
  workspaceTitle,
  sharing,
  onManage,
}: {
  /** What people call this workspace; the switches are scoped to it. */
  workspaceTitle: string | null;
  sharing: ProviderSharing;
  /** Opens the admin dialog. Absent when there is nowhere to open it from. */
  onManage?: (() => void) | undefined;
}) {
  const overview = sharing.overview;
  // Nothing has loaded, or this server does not answer: say nothing rather than
  // claim the person is sharing nothing.
  if (!overview) {
    return null;
  }

  const workspaceLabel = workspaceTitle?.trim() || "this workspace";
  const views = PROVIDERS.map((provider) => readViewerSharing(overview, provider));
  const anySharing = views.some((view) => view.isSharing);
  // Who the workspace policy actually spends. Derived from the same overview
  // the switches above read, so a badge can never disagree with the switch
  // sitting a few pixels from it.
  const carriers = readWorkspaceCarriers(overview);

  return (
    <div data-testid="provider-sharing-section">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">What you contribute</div>
        {overview.canManage && onManage ? (
          <Button
            size="xs"
            variant="outline"
            data-testid="provider-sharing-manage"
            onClick={onManage}
          >
            <SettingsIcon className="size-3.5" />
            Manage
          </Button>
        ) : null}
      </div>

      {/* Requirement 5: sharing is per workspace on the server, and somebody who
          believes they shared everywhere has shared nothing they meant to. */}
      <div className="mb-2 text-[10px] leading-4 text-muted-foreground">
        These switches apply to <span className="text-foreground">{workspaceLabel}</span> only. Your
        other workspaces keep their own.
      </div>

      <div className="grid gap-2.5">
        {views.map((view) => (
          <ProviderRow
            key={view.provider}
            view={view}
            workspaceLabel={workspaceLabel}
            sharing={sharing}
          />
        ))}
      </div>

      {carriers.length > 0 ? (
        <div
          className="mt-3 border-t border-border/60 pt-2"
          data-testid="provider-sharing-carriers"
        >
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Who is carrying {workspaceLabel}
          </div>
          <div className="grid gap-2">
            {carriers.map((carrier) => (
              <CarrierRow key={carrier.userId} carrier={carrier} />
            ))}
          </div>
        </div>
      ) : null}

      {anySharing ? (
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Switching a share off stops new turns from using your account. A turn already running
          keeps it until it finishes.
        </p>
      ) : null}
    </div>
  );
}
