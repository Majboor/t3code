import type {
  EnvironmentId,
  ProviderAccountId,
  ProviderAuthKind,
  ProviderConnectedAccount,
  ProviderUsageRequestReason,
  ProviderWorkspaceAccount,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HandCoinsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useProviderUsageRequests, type ProviderUsage } from "../../hooks/useProviderUsageRequests";
import { cn } from "../../lib/utils";
import { PROVIDER_LABEL, PROVIDERS } from "./providerSharing.logic";
import {
  describeAskReason,
  describeUsageFailure,
  defaultAskReason,
  formatNames,
  pickDefaultAccount,
  readIncomingRequests,
  readPossibleResponders,
  readViewerUsage,
  type IncomingUsageRequest,
  type ViewerUsageRequest,
} from "./providerUsageRequests.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const NOTE_MAX_LENGTH = 140;

const REASON_CHOICES: ReadonlyArray<{
  readonly value: ProviderUsageRequestReason;
  readonly label: string;
}> = [
  { value: "asked", label: "I'd rather use theirs" },
  { value: "limit-reached", label: "I've hit my limit" },
];

interface ComposeState {
  readonly provider: ProviderAuthKind;
  readonly reason: ProviderUsageRequestReason;
  readonly note: string;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function report(error: unknown, fallbackTitle: string, providerLabel: string) {
  const notice = describeUsageFailure(error, { fallbackTitle, providerLabel });
  toastManager.add({
    type: notice.tone,
    title: notice.title,
    description: notice.description,
  });
}

export interface ProviderUsageRequestsProps {
  /** What people call this workspace; every request is scoped to it. */
  readonly workspaceLabel: string;
  readonly viewerUserId: string;
  /** Only genuinely connected accounts — the same list the switches use. */
  readonly viewerAccounts: readonly ProviderConnectedAccount[];
  /** Admin-only, and empty for everybody else; used to name who could answer. */
  readonly workspaceAccounts: readonly ProviderWorkspaceAccount[];
}

/**
 * The half of provider sharing that starts from not having anything: asking a
 * workspace to lend you an account, and answering somebody who asked.
 *
 * Reads its own requests, which is what anybody rendering it on its own wants.
 * The collaboration popover summarises them on a row before anybody opens the
 * section, so it holds the hook itself and draws {@link ProviderUsageRequestsView}
 * rather than fetching the same list twice.
 */
export function ProviderUsageRequests({
  environmentId,
  tenantId,
  workspaceId,
  ...props
}: ProviderUsageRequestsProps & {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}) {
  const usage = useProviderUsageRequests({ environmentId, tenantId, workspaceId });
  return <ProviderUsageRequestsView {...props} usage={usage} />;
}

export function ProviderUsageRequestsView({
  usage,
  workspaceLabel,
  viewerUserId,
  viewerAccounts,
  workspaceAccounts,
}: ProviderUsageRequestsProps & { usage: ProviderUsage }) {
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [grantAccounts, setGrantAccounts] = useState<Record<string, ProviderAccountId>>({});
  const [showOptional, setShowOptional] = useState(false);

  // Nothing has loaded, or this server does not answer these calls: say nothing
  // rather than tell somebody nobody has asked them for anything.
  if (!usage.loaded) {
    return null;
  }

  const views = PROVIDERS.map((provider) =>
    readViewerUsage({
      requests: usage.requests,
      viewerUserId,
      provider,
      hasOwnAccount: viewerAccounts.some((account) => account.provider === provider),
    }),
  );
  // Somebody who can already run turns is not offered an ask they did not go
  // looking for; somebody who cannot is the entire point of this panel.
  const blocking = views.filter((view) => view.state !== "none" || !view.hasOwnAccount);
  const optional = views.filter((view) => view.state === "none" && view.hasOwnAccount);
  const incoming = readIncomingRequests({
    requests: usage.requests,
    viewerUserId,
    viewerAccounts,
  });

  const send = (view: ViewerUsageRequest, draft: ComposeState) => {
    const label = PROVIDER_LABEL[view.provider];
    const note = draft.note.trim();
    setBusyKey(view.provider);
    usage
      .ask({
        provider: view.provider,
        reason: draft.reason,
        // Null rather than omitted: an emptied field is the person saying they
        // have nothing to add, and the server stores that as no note.
        note: note.length > 0 ? note : null,
      })
      .then(() => setCompose(null))
      .catch((error: unknown) => report(error, `Could not ask for ${label}`, label))
      .finally(() => setBusyKey(null));
  };

  const renderCompose = (view: ViewerUsageRequest, draft: ComposeState): ReactNode => {
    const label = PROVIDER_LABEL[view.provider];
    return (
      <div
        className="mt-1.5 grid gap-1"
        data-testid="provider-usage-compose"
        data-provider={view.provider}
      >
        {/* Only someone who already has an account has two honest reasons to
            pick between; without one there is only the one fact. */}
        {view.hasOwnAccount ? (
          <div className="grid grid-cols-2 gap-1">
            {REASON_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                aria-pressed={draft.reason === choice.value}
                className={cn(
                  "truncate rounded-md border px-2 py-1 text-[10px] transition-colors",
                  draft.reason === choice.value
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setCompose({ ...draft, reason: choice.value })}
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : null}
        <Input
          size="sm"
          value={draft.note}
          maxLength={NOTE_MAX_LENGTH}
          aria-label={`Note for your ${label} request`}
          placeholder="Add a line (optional)"
          data-testid="provider-usage-note"
          onChange={(event) => setCompose({ ...draft, note: event.currentTarget.value })}
        />
        <div className="flex gap-1">
          <Button
            size="xs"
            disabled={busyKey === view.provider}
            data-testid="provider-usage-send"
            data-provider={view.provider}
            onClick={() => send(view, draft)}
          >
            Send request
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busyKey === view.provider}
            onClick={() => setCompose(null)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  };

  const renderAskButton = (view: ViewerUsageRequest, text: string): ReactNode => {
    const draft = compose?.provider === view.provider ? compose : null;
    if (draft) {
      return renderCompose(view, draft);
    }
    return (
      <Button
        size="xs"
        variant="outline"
        className="mt-1.5"
        data-testid="provider-usage-ask"
        data-provider={view.provider}
        onClick={() =>
          setCompose({
            provider: view.provider,
            reason: defaultAskReason(view.hasOwnAccount),
            note: "",
          })
        }
      >
        {text}
      </Button>
    );
  };

  const renderViewerRow = (view: ViewerUsageRequest): ReactNode => {
    const label = PROVIDER_LABEL[view.provider];
    const responders = readPossibleResponders({
      workspaceAccounts,
      provider: view.provider,
      viewerUserId,
    });

    if (view.state === "pending" && view.request) {
      const request = view.request;
      return (
        <div
          key={view.provider}
          data-testid="provider-usage-mine"
          data-provider={view.provider}
          data-state="pending"
        >
          <div className="text-xs font-medium text-foreground">Waiting on {label}</div>
          <div className="text-[10px] leading-4 text-muted-foreground">
            Asked at {formatTime(request.createdAt)}.{" "}
            {responders.length > 0
              ? `${formatNames(responders)} could answer it.`
              : `Anyone in ${workspaceLabel} with a ${label} account can answer.`}
          </div>
          {request.note ? (
            <div className="truncate text-[10px] text-muted-foreground">“{request.note}”</div>
          ) : null}
          {/* They asked because they had nothing and have connected one since;
              nothing else in the panel would tell them they are unblocked. */}
          {view.askedThenConnected ? (
            <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              You have connected your own {label} since asking, so your turns already run. Withdraw
              if you no longer need theirs.
            </div>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            className="mt-1.5"
            disabled={busyKey === request.id}
            data-testid="provider-usage-withdraw"
            data-provider={view.provider}
            onClick={() => {
              setBusyKey(request.id);
              usage
                .withdraw(request.id)
                .catch((error: unknown) =>
                  report(error, `Could not withdraw your ${label} request`, label),
                )
                .finally(() => setBusyKey(null));
            }}
          >
            Withdraw
          </Button>
        </div>
      );
    }

    if (view.state === "granted") {
      return (
        <div
          key={view.provider}
          data-testid="provider-usage-mine"
          data-provider={view.provider}
          data-state="granted"
        >
          <div className="text-xs font-medium text-foreground">{label} granted</div>
          <div className="text-[10px] leading-4 text-muted-foreground">
            Somebody in {workspaceLabel} lent you theirs. Your {label} turns run on their account
            now — send a prompt and it will go through.
          </div>
        </div>
      );
    }

    if (view.state === "declined") {
      return (
        <div
          key={view.provider}
          data-testid="provider-usage-mine"
          data-provider={view.provider}
          data-state="declined"
        >
          <div className="text-xs font-medium text-foreground">{label} request declined</div>
          <div className="text-[10px] leading-4 text-muted-foreground">
            Nobody took it on.{" "}
            {view.hasOwnAccount ? (
              `Your own ${label} still runs your turns.`
            ) : (
              <>
                Connect your own at{" "}
                <Link
                  to="/settings/connections"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Settings → Connections
                </Link>
                , or ask again with more detail.
              </>
            )}
          </div>
          {renderAskButton(view, "Ask again")}
        </div>
      );
    }

    if (!view.hasOwnAccount) {
      return (
        <div
          key={view.provider}
          data-testid="provider-usage-mine"
          data-provider={view.provider}
          data-state="none"
        >
          <div className="text-xs font-medium text-foreground">No {label} account</div>
          <div className="text-[10px] leading-4 text-muted-foreground">
            Your {label} turns are refused until you connect one or somebody here lends you theirs.
          </div>
          {renderAskButton(view, `Ask the workspace for ${label} usage`)}
        </div>
      );
    }

    return (
      <div
        key={view.provider}
        data-testid="provider-usage-mine"
        data-provider={view.provider}
        data-state="none"
      >
        <div className="text-xs font-medium text-foreground">Use the workspace's {label}</div>
        <div className="text-[10px] leading-4 text-muted-foreground">
          You can already run {label} turns on your own account.
        </div>
        {renderAskButton(view, `Ask for ${label} anyway`)}
      </div>
    );
  };

  const renderIncoming = (entry: IncomingUsageRequest): ReactNode => {
    const { request } = entry;
    const label = PROVIDER_LABEL[request.provider];
    const chosenId = grantAccounts[request.id] ?? entry.defaultAccountId;
    const chosen =
      entry.accounts.find((account) => account.accountId === chosenId) ??
      pickDefaultAccount(entry.accounts);
    const busy = busyKey === request.id;

    const decide = (decision: "grant" | "decline") => {
      setBusyKey(request.id);
      usage
        .respond({
          requestId: request.id,
          decision,
          accountId: decision === "grant" ? (chosen?.accountId ?? null) : null,
        })
        .catch((error: unknown) =>
          report(error, `Could not answer ${request.requesterDisplayName}`, label),
        )
        .finally(() => setBusyKey(null));
    };

    return (
      <div
        key={request.id}
        className="rounded-md border border-border p-2"
        data-testid="provider-usage-incoming"
        data-provider={request.provider}
        data-request={request.id}
      >
        <div className="text-xs text-foreground">
          <span className="font-medium">{request.requesterDisplayName}</span> is asking for {label}
        </div>
        <div className="text-[10px] leading-4 text-muted-foreground">
          {describeAskReason(request.reason, label)} · {formatTime(request.createdAt)}
        </div>
        {request.note ? (
          <div className="mt-1 text-[10px] leading-4 text-foreground">“{request.note}”</div>
        ) : null}

        {/* Requirement 3's picker, again: with one account there is nothing to
            choose, and the sentence below has to name whichever it is. */}
        {entry.accounts.length > 1 ? (
          <div
            className="mt-1.5 grid grid-cols-2 gap-1"
            data-testid="provider-usage-grant-picker"
            data-request={request.id}
          >
            {entry.accounts.map((account) => {
              const isSelected = account.accountId === chosen?.accountId;
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
                  onClick={() =>
                    setGrantAccounts((current) => ({
                      ...current,
                      [request.id]: account.accountId,
                    }))
                  }
                >
                  {account.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Said before the click, not after: granting does not just close a
            row. The server switches this person's share on and gives the
            requester access, and every turn they then run is billed to the
            responder's own subscription. */}
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          {entry.canGrant ? (
            <>
              Granting shares your {label}
              {chosen ? ` (${chosen.label})` : ""} with {workspaceLabel} and lets{" "}
              {request.requesterDisplayName} run turns on it. Their turns spend your subscription
              until you switch the share off above.
            </>
          ) : (
            <>You have no {label} account to lend, so only Decline can do anything here.</>
          )}
        </p>

        <div className="mt-1.5 flex gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !entry.canGrant}
            data-testid="provider-usage-grant"
            data-request={request.id}
            onClick={() => decide("grant")}
          >
            Grant
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            data-testid="provider-usage-decline"
            data-request={request.id}
            onClick={() => decide("decline")}
          >
            Decline
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div data-testid="provider-usage-requests">
      <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <HandCoinsIcon className="size-3.5" />
        Usage requests
      </div>

      <div className="grid gap-2.5">
        {blocking.map(renderViewerRow)}
        {showOptional ? optional.map(renderViewerRow) : null}
      </div>

      {optional.length > 0 && !showOptional ? (
        <button
          type="button"
          className="mt-1 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          data-testid="provider-usage-ask-anyway"
          onClick={() => setShowOptional(true)}
        >
          Ask for a workspace account anyway
        </button>
      ) : null}

      {/* `canRespond` is the server's word on whether this person has anything
          to lend. An empty list is not the same answer. */}
      {usage.canRespond ? (
        <div className="mt-3" data-testid="provider-usage-inbox">
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Asking to use your accounts
          </div>
          {incoming.length > 0 ? (
            <div className="grid gap-1.5">{incoming.map(renderIncoming)}</div>
          ) : (
            <p className="text-[10px] leading-4 text-muted-foreground">
              Nobody has asked. Requests from people in {workspaceLabel} who cannot run turns land
              here.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
