import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { shouldShowProviderStatus } from "./providerStatusBanner.logic";
import { memo, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, LoaderIcon } from "lucide-react";
import { readSupabaseBrowserAccessToken } from "../../environments/primary/auth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import {
  defaultAccountOf,
  parseConnections,
  type Connection,
  type ProviderAccount,
  type ProviderName,
} from "../settings/providerAccounts.logic";

/**
 * The provider's own words for "you are not signed in" name a CLI command —
 * `codex login`, `claude auth login` — because they are written for someone
 * sitting at that machine's terminal. A person using T3 in a browser cannot
 * run them and has no reason to know Connections is where the same thing is
 * offered, so the banner says where to go.
 */
function isNotAuthenticated(message: string | null): boolean {
  return message !== null && /not authenticated/i.test(message);
}

/**
 * `ProviderKind` (what a turn runs) and `ProviderName` (what the account
 * store files a login under) name the same two providers differently — see
 * `providerAuthProviderOf` on the server, which this mirrors.
 *
 * Returns `null` for a provider with no OAuth-connect model at all (GLM: the
 * credential is the caller's own LogicPacks gateway key, resolved
 * automatically at session start, never a "connect your account" flow).
 * Forcing GLM into the `"claude"` bucket here (the bug this replaced) made
 * every fresh signup — who has never connected a Claude account, which is
 * irrelevant to GLM — read as "no GLM account connected", even though GLM's
 * own `status.status` was already `"ready"`.
 */
function accountProviderNameOf(provider: ServerProvider["provider"]): ProviderName | null {
  if (provider === "codex") return "codex";
  if (provider === "claudeAgent") return "claude";
  return null;
}

async function fetchConnections(): Promise<readonly Connection[]> {
  const accessToken = readSupabaseBrowserAccessToken();
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/provider-auth/connections"), {
    credentials: "include",
    ...(accessToken ? { headers: { authorization: `Bearer ${accessToken}` } } : {}),
  });
  if (!response.ok) {
    return [];
  }
  const data: unknown = await response.json().catch(() => null);
  return parseConnections(data);
}

/**
 * Picking which of this person's own accounts answers for this thread next.
 *
 * A turn re-resolves its account fresh every time it starts (see
 * `resolveProviderAccount` on the server), so there is no per-thread pin to
 * undo — the whole fix for "my chat is stuck on a dead account" is making it
 * easy to change which account is the default, from wherever the failure was
 * actually seen. Settings can do this too; this is the same edit, offered at
 * the point of pain.
 */
function AccountSwitcher({
  provider,
  accounts,
  currentAccountId,
  onSwitched,
}: {
  readonly provider: ProviderName;
  readonly accounts: readonly ProviderAccount[];
  readonly currentAccountId: string | null;
  readonly onSwitched: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTo = async (accountId: string) => {
    if (accountId === currentAccountId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const accessToken = readSupabaseBrowserAccessToken();
      const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/provider-auth/account"), {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ provider, accountId, makeDefault: true }),
      });
      if (!response.ok) {
        setError("Couldn't switch accounts. Try again from Settings → Connections.");
        return;
      }
      onSwitched();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  if (accounts.length < 2) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Run on:</span>
      {accounts.map((account) => (
        <button
          key={account.accountId}
          type="button"
          disabled={busy}
          onClick={() => void switchTo(account.accountId)}
          className={`rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 ${
            account.accountId === currentAccountId
              ? "border-foreground/40 bg-foreground/10 font-medium"
              : "border-border hover:bg-foreground/5"
          }`}
        >
          {account.label}
        </button>
      ))}
      {busy ? <LoaderIcon className="size-3 animate-spin" /> : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const [connections, setConnections] = useState<readonly Connection[] | null>(null);

  const providerKind = status?.provider ?? null;
  const providerName = providerKind === null ? null : accountProviderNameOf(providerKind);
  useEffect(() => {
    if (providerName === null) {
      return;
    }
    let cancelled = false;
    void fetchConnections().then((result) => {
      if (!cancelled) {
        setConnections(result);
      }
    });
    return () => {
      cancelled = true;
    };
    // Re-checked whenever the active provider changes, and once more whenever
    // an account switch below reports success, via `refetch`.
  }, [providerName]);

  if (!status || status.status === "disabled") {
    return null;
  }

  const connection =
    providerName === null
      ? null
      : (connections?.find((entry) => entry.provider === providerName) ?? null);
  const connectedAccounts = connection?.accounts.filter((account) => account.connected) ?? [];
  const myDefault = connection ? defaultAccountOf(connection) : null;

  /**
   * The turn-level health check the rest of this banner reads is one process
   * wide, not one person wide — it answers "does the box have a working
   * login", not "does this signed-in person". A workspace where somebody
   * else's account is healthy would otherwise read as all clear to a person
   * with nothing connected at all, right up until they sent a message and it
   * refused. Once the per-account list has loaded, it is trusted over the
   * broader status for exactly that one question.
   *
   * Only meaningful for a provider that actually has an OAuth-connect model
   * (`providerName !== null`) — GLM's credential is automatic, so there is
   * nothing to "connect" and this never applies to it.
   */
  const noAccountForMe =
    providerName !== null &&
    connections !== null &&
    connection !== null &&
    connectedAccounts.length === 0;

  if (
    !shouldShowProviderStatus({
      status: status.status,
      viewerConnectedAccounts: connections === null ? null : connectedAccounts.length,
      noAccountForMe,
    })
  ) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage = noAccountForMe
    ? `No ${providerLabel} account is connected for you.`
    : status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const message = noAccountForMe ? null : (status.message ?? null);

  return (
    <div className="pt-3 mx-auto max-w-3xl" data-tour="provider-status-banner">
      <Alert variant={noAccountForMe || status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription title={message ?? defaultMessage}>
          <span className="line-clamp-3">{message ?? defaultMessage}</span>
          {providerName !== null && (noAccountForMe || isNotAuthenticated(message)) ? (
            <Link
              to="/settings/connections"
              className="mt-1 inline-block font-medium underline underline-offset-2"
              data-testid="provider-status-connect-link"
            >
              Connect {providerLabel}
            </Link>
          ) : null}
          {providerName === null ? null : (
            <AccountSwitcher
              provider={providerName}
              accounts={connectedAccounts}
              currentAccountId={myDefault?.accountId ?? null}
              onSwitched={() => {
                void fetchConnections().then(setConnections);
              }}
            />
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
});
