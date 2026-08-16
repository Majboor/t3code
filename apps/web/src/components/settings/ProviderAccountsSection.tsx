import {
  CheckIcon,
  ExternalLinkIcon,
  LoaderIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readSupabaseBrowserAccessToken } from "../../environments/primary/auth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { cn } from "../../lib/utils";
import {
  accountConnected,
  defaultAccountOf,
  formatConnectedAt,
  parseConnections,
  PROVIDER_LABELS,
  suggestedAccountName,
  type Connection,
  type ProviderAccount,
  type ProviderName,
} from "./providerAccounts.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The provider accounts somebody has, in a list.
 *
 * Connecting used to ask for a thread, open a terminal in it, and expect the
 * person to read a CLI, run a status command and paste its output back. The
 * server drives both CLIs now and hands back only the two things a person needs
 * — where to go, and what to type — so signing in is still two buttons.
 *
 * What changed is that one credential per provider is no longer the shape of
 * the truth: a person may hold two subscriptions, and a workspace may be lent
 * one of them. So this page has to answer a question it never could before —
 * *which* account do my own turns run on — and give them a way to make the
 * second account that the collaboration panel offers to contribute.
 */

/** What the server printed for a sign-in that is currently in progress. */
type SignInSession = {
  readonly provider: ProviderName;
  readonly label: string;
  /** Which account this sign-in is filling, which is not always the default. */
  readonly accountId: string;
  readonly accountLabel: string | null;
  readonly url: string | null;
  readonly code: string | null;
  readonly wantsCode: boolean;
};

/** One action runs at a time, named so only its own button spins. */
function actionKey(provider: ProviderName, accountId: string | null, action: string): string {
  return `${provider}/${accountId ?? "-"}/${action}`;
}

const spinner = <LoaderIcon className="size-3.5 animate-spin" />;

async function callProviderAuth(
  path: string,
  init?: { readonly method?: "GET" | "POST"; readonly body?: unknown },
): Promise<{ readonly ok: boolean; readonly data: Record<string, unknown> }> {
  // The cookie alone is not enough everywhere: a Supabase-backed deployment
  // authenticates with a bearer token the cookie knows nothing about, and
  // sending only the cookie there gets a 401 on every call.
  const accessToken = readSupabaseBrowserAccessToken();
  const headers: Record<string, string> = {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
  };
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(`/api/provider-auth/${path}`), {
    method: init?.method ?? "GET",
    credentials: "include",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

function errorFrom(data: Record<string, unknown>, fallback: string): string {
  return typeof data["error"] === "string" ? data["error"] : fallback;
}

interface AccountRowHandlers {
  readonly startRename: (account: ProviderAccount) => void;
  readonly changeRename: (value: string) => void;
  readonly cancelRename: () => void;
  readonly saveRename: (account: ProviderAccount) => void;
  readonly makeDefault: (account: ProviderAccount) => void;
  readonly test: (account: ProviderAccount) => void;
  readonly reconnect: (account: ProviderAccount) => void;
  readonly disconnect: (account: ProviderAccount) => void;
}

function AccountRow({
  connection,
  account,
  busyKey,
  rename,
  testOutput,
  on,
}: {
  readonly connection: Connection;
  readonly account: ProviderAccount;
  readonly busyKey: string | null;
  /** The name being typed, when this row is the one being renamed. */
  readonly rename: string | null;
  readonly testOutput: string | null;
  readonly on: AccountRowHandlers;
}) {
  const busy = (action: string): boolean =>
    busyKey === actionKey(account.provider, account.accountId, action);
  const disabled = busyKey !== null;
  const connectedAt = formatConnectedAt(account.createdAt);

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2"
      data-testid="provider-account-row"
      data-provider={account.provider}
      data-account={account.accountId}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {rename === null ? (
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-xs font-medium text-foreground">{account.label}</span>
              {account.isDefault ? (
                <span className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  Your turns
                </span>
              ) : null}
              {account.connected ? null : (
                <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Not connected
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {account.connected
                ? connectedAt
                  ? `Connected ${connectedAt}`
                  : "Connected"
                : "Signed out. Reconnect to use this account again."}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Input
              value={rename}
              autoComplete="off"
              spellCheck={false}
              // Clearing the box is a real instruction: the server drops the
              // name and goes back to the email, or the position, it derives.
              placeholder="Leave empty to use the derived name"
              aria-label={`Name for ${account.label}`}
              className="h-7 text-xs"
              onChange={(event) => on.changeRename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  on.saveRename(account);
                }
                if (event.key === "Escape") {
                  on.cancelRename();
                }
              }}
            />
            <Button
              size="xs"
              disabled={busyKey !== null}
              aria-label="Save the name"
              onClick={() => on.saveRename(account)}
            >
              <CheckIcon className="size-3.5" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busyKey !== null}
              aria-label="Cancel renaming"
              onClick={on.cancelRename}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        )}

        {rename === null ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {account.connected && !account.isDefault ? (
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => on.makeDefault(account)}
              >
                {busy("default") ? spinner : null}
                Use for my turns
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Rename ${account.label}`}
              onClick={() => on.startRename(account)}
            >
              <PencilIcon className="size-3.5" />
            </Button>
            {account.connected ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => on.test(account)}
              >
                {busy("test") ? spinner : <PlayIcon className="size-3.5" />}
                Test
              </Button>
            ) : (
              <Button size="xs" disabled={disabled} onClick={() => on.reconnect(account)}>
                {busy("connect") ? spinner : <ExternalLinkIcon className="size-3.5" />}
                Reconnect
              </Button>
            )}
            {account.connected ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={disabled}
                onClick={() => on.disconnect(account)}
              >
                {busy("disconnect") ? spinner : null}
                Disconnect
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* A status is not evidence — `claude auth status` reports a working
          setup-token login as signed out — so the only honest check is running
          something on this one account and showing what came back. */}
      {testOutput === null ? null : (
        <pre
          className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
          data-testid="provider-account-test-output"
        >
          {testOutput}
        </pre>
      )}

      {account.isDefault && connection.accounts.length > 1 ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          Your own {connection.label} turns run on this account.
        </div>
      ) : null}
    </div>
  );
}

export function ProviderAccountsSection() {
  const [connections, setConnections] = useState<readonly Connection[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [signInSession, setSignInSession] = useState<SignInSession | null>(null);
  const [code, setCode] = useState("");
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [renaming, setRenaming] = useState<{
    readonly provider: ProviderName;
    readonly accountId: string;
    readonly value: string;
  } | null>(null);
  const [newNames, setNewNames] = useState<Partial<Record<ProviderName, string>>>({});
  const [testOutput, setTestOutput] = useState<{
    readonly provider: ProviderName;
    readonly accountId: string;
    readonly output: string;
  } | null>(null);
  // Codex finishes on its own once the browser is done, so the page has to
  // watch for it. The flag stops a watch outliving the panel that started it.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<readonly Connection[] | null> => {
    setIsRefreshing(true);
    try {
      const { ok, data } = await callProviderAuth("connections");
      if (!isMountedRef.current) {
        return null;
      }
      if (!ok) {
        setErrorMessage(errorFrom(data, "Failed to load provider connections."));
        return null;
      }
      const loaded = parseConnections(data);
      setConnections(loaded);
      setErrorMessage(null);
      return loaded;
    } catch {
      if (isMountedRef.current) {
        setErrorMessage("Failed to reach the server.");
      }
      return null;
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Codex has no submit step — it completes when the browser does. Polling is
   * the only way to notice; without it the panel sat on the sign-in screen
   * through a login that had already succeeded.
   *
   * It waits on the one account being filled, never on the provider. Somebody
   * connecting their second subscription is already connected, so a watch on
   * the provider would announce success before the browser had even opened.
   */
  const watchUntilConnected = useCallback(
    async (provider: ProviderName, accountId: string, accountLabel: string) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        if (!isMountedRef.current) {
          return;
        }
        const loaded = await refresh();
        if (loaded !== null && accountConnected(loaded, provider, accountId)) {
          setSignInSession(null);
          setStatusMessage(`${accountLabel} connected.`);
          return;
        }
      }
      if (isMountedRef.current) {
        setErrorMessage(
          `${PROVIDER_LABELS[provider]} sign-in did not complete. Start it again for a fresh code.`,
        );
      }
    },
    [refresh],
  );

  const startSignIn = useCallback(
    async (
      provider: ProviderName,
      options: {
        readonly accountId?: string;
        readonly newAccount?: boolean;
        readonly label?: string;
      } = {},
    ) => {
      setBusyKey(
        actionKey(provider, options.accountId ?? null, options.newAccount ? "new" : "connect"),
      );
      setErrorMessage(null);
      setStatusMessage(null);
      setSignInSession(null);
      setTestOutput(null);
      setCode("");
      try {
        const { ok, data } = await callProviderAuth("start", {
          method: "POST",
          body: {
            provider,
            ...(options.newAccount === true ? { newAccount: true } : {}),
            ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
            ...(options.label === undefined || options.label.length === 0
              ? {}
              : { label: options.label }),
          },
        });
        if (!isMountedRef.current) {
          return;
        }
        if (!ok) {
          setErrorMessage(errorFrom(data, "Failed to start the sign-in."));
          return;
        }
        const url = typeof data["url"] === "string" ? data["url"] : null;
        if (url === null) {
          setErrorMessage(
            `${PROVIDER_LABELS[provider]} did not return a sign-in link. Try again in a moment.`,
          );
          return;
        }
        // The account is the server's to name: asking for a new one creates an
        // id the browser could not have known, and nothing else identifies it.
        const accountId =
          typeof data["accountId"] === "string" ? data["accountId"] : (options.accountId ?? null);
        const accountLabel = typeof data["accountLabel"] === "string" ? data["accountLabel"] : null;
        const providerLabel =
          typeof data["label"] === "string" ? data["label"] : PROVIDER_LABELS[provider];
        if (accountId === null) {
          setErrorMessage(`${providerLabel} did not say which account it is signing in.`);
          return;
        }
        const wantsCode = data["wantsCode"] === true;
        setNewNames((previous) => ({ ...previous, [provider]: "" }));
        setSignInSession({
          provider,
          label: providerLabel,
          accountId,
          accountLabel,
          url,
          code: typeof data["code"] === "string" ? data["code"] : null,
          wantsCode,
        });
        if (!wantsCode) {
          void watchUntilConnected(provider, accountId, accountLabel ?? providerLabel);
        }
      } catch {
        if (isMountedRef.current) {
          setErrorMessage("Failed to reach the server.");
        }
      } finally {
        if (isMountedRef.current) {
          setBusyKey(null);
        }
      }
    },
    [watchUntilConnected],
  );

  const submitCode = useCallback(async () => {
    if (!signInSession || code.trim().length === 0) {
      return;
    }
    const name = signInSession.accountLabel ?? signInSession.label;
    setIsSubmittingCode(true);
    setErrorMessage(null);
    try {
      const { ok, data } = await callProviderAuth("code", {
        method: "POST",
        body: {
          provider: signInSession.provider,
          code: code.trim(),
          accountId: signInSession.accountId,
        },
      });
      if (!isMountedRef.current) {
        return;
      }
      if (!ok) {
        setErrorMessage(errorFrom(data, "The code was not accepted."));
        return;
      }
      if (data["connected"] === true) {
        setSignInSession(null);
        setCode("");
        setStatusMessage(`${name} connected.`);
        await refresh();
        return;
      }
      setErrorMessage(
        data["failed"] === true
          ? `${name} rejected that code. Start the sign-in again for a fresh one.`
          : `${name} did not return a token. Start the sign-in again.`,
      );
    } catch {
      if (isMountedRef.current) {
        setErrorMessage("Failed to reach the server.");
      }
    } finally {
      if (isMountedRef.current) {
        setIsSubmittingCode(false);
      }
    }
  }, [code, refresh, signInSession]);

  /** Every edit to an account is the same round trip: post, then re-read. */
  const mutate = useCallback(
    async (input: {
      readonly key: string;
      readonly path: "account" | "logout";
      readonly body: Record<string, unknown>;
      readonly failure: string;
      readonly success: string;
    }) => {
      setBusyKey(input.key);
      setErrorMessage(null);
      setStatusMessage(null);
      try {
        const { ok, data } = await callProviderAuth(input.path, {
          method: "POST",
          body: input.body,
        });
        if (!isMountedRef.current) {
          return;
        }
        if (!ok) {
          setErrorMessage(errorFrom(data, input.failure));
          return;
        }
        // `indexed: false` is deliberately not reported: the credential is on
        // disk and works, and a warning about a table nobody here can see would
        // only make a successful edit look broken.
        setStatusMessage(input.success);
        await refresh();
      } catch {
        if (isMountedRef.current) {
          setErrorMessage("Failed to reach the server.");
        }
      } finally {
        if (isMountedRef.current) {
          setBusyKey(null);
        }
      }
    },
    [refresh],
  );

  const testAccount = useCallback(async (account: ProviderAccount) => {
    setBusyKey(actionKey(account.provider, account.accountId, "test"));
    setErrorMessage(null);
    setStatusMessage(null);
    setTestOutput(null);
    try {
      const { ok, data } = await callProviderAuth("prompt", {
        method: "POST",
        body: {
          provider: account.provider,
          accountId: account.accountId,
          text: "Reply with exactly: OK",
        },
      });
      if (!isMountedRef.current) {
        return;
      }
      if (!ok) {
        setErrorMessage(errorFrom(data, `${account.label} did not answer.`));
        return;
      }
      setTestOutput({
        provider: account.provider,
        accountId: account.accountId,
        output:
          typeof data["output"] === "string" && data["output"].trim().length > 0
            ? data["output"].trim()
            : "The command finished without saying anything.",
      });
    } catch {
      if (isMountedRef.current) {
        setErrorMessage("Failed to reach the server.");
      }
    } finally {
      if (isMountedRef.current) {
        setBusyKey(null);
      }
    }
  }, []);

  const handlers: AccountRowHandlers = {
    startRename: (account) => {
      setTestOutput(null);
      setRenaming({
        provider: account.provider,
        accountId: account.accountId,
        // Prefilled, because an empty box saves as "clear the name" and a rename
        // that silently discarded the name somebody typed would be a trap.
        value: account.label,
      });
    },
    changeRename: (value) => setRenaming((current) => (current ? { ...current, value } : null)),
    cancelRename: () => setRenaming(null),
    saveRename: (account) => {
      const value = renaming?.value.trim() ?? "";
      setRenaming(null);
      void mutate({
        key: actionKey(account.provider, account.accountId, "rename"),
        path: "account",
        body: { provider: account.provider, accountId: account.accountId, label: value },
        failure: "Failed to rename the account.",
        success: value.length === 0 ? "Name cleared." : `${account.label} is now called ${value}.`,
      });
    },
    makeDefault: (account) =>
      void mutate({
        key: actionKey(account.provider, account.accountId, "default"),
        path: "account",
        body: { provider: account.provider, accountId: account.accountId, makeDefault: true },
        failure: "Failed to change which account your turns run on.",
        success: `Your ${PROVIDER_LABELS[account.provider]} turns now run on ${account.label}.`,
      }),
    test: (account) => void testAccount(account),
    reconnect: (account) => void startSignIn(account.provider, { accountId: account.accountId }),
    disconnect: (account) =>
      void mutate({
        key: actionKey(account.provider, account.accountId, "disconnect"),
        path: "logout",
        body: { provider: account.provider, accountId: account.accountId },
        failure: "Failed to disconnect.",
        success: `${account.label} disconnected.`,
      }),
  };

  return (
    <SettingsSection
      title="Provider Accounts"
      headerAction={
        <Button size="xs" variant="outline" disabled={isRefreshing} onClick={() => void refresh()}>
          {isRefreshing ? spinner : <RefreshCwIcon className="size-3.5" />}
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title="Codex and Claude"
        description="Sign in with your own provider accounts, as many of each as you have. Your agent runs use the account marked for your turns, and nobody else's."
        status={
          errorMessage ? (
            <span className="text-destructive">{errorMessage}</span>
          ) : statusMessage ? (
            <span className="text-success">{statusMessage}</span>
          ) : null
        }
      >
        <div className="space-y-3 border-t border-border/60 pt-3 pb-4">
          {connections === null ? (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              Loading connections…
            </div>
          ) : (
            connections.map((connection) => {
              const runsOn = defaultAccountOf(connection);
              const connectBusy = busyKey === actionKey(connection.provider, null, "connect");
              const addBusy = busyKey === actionKey(connection.provider, null, "new");
              return (
                <div
                  key={connection.provider}
                  className="space-y-2.5 rounded-md border border-border bg-background px-3 py-3"
                  data-testid="provider-connection"
                  data-provider={connection.provider}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-foreground">
                          {connection.label}
                        </div>
                        <span
                          className={cn(
                            "rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
                            connection.connected
                              ? "border-success/30 bg-success/10 text-success"
                              : "border-border text-muted-foreground",
                          )}
                        >
                          {connection.connected ? "Connected" : "Not connected"}
                        </span>
                      </div>
                      {/* The question this page could not answer before: with two
                          subscriptions connected, which one is spending. */}
                      <div className="text-xs text-muted-foreground">
                        {runsOn
                          ? `Your ${connection.label} turns run as ${runsOn.label}.`
                          : `${connection.label} turns will not run until you connect an account.`}
                      </div>
                    </div>
                    {connection.accounts.length === 0 ? (
                      <Button
                        size="xs"
                        disabled={busyKey !== null}
                        onClick={() => void startSignIn(connection.provider)}
                      >
                        {connectBusy ? spinner : <ExternalLinkIcon className="size-3.5" />}
                        Open {connection.label} sign-in
                      </Button>
                    ) : null}
                  </div>

                  {connection.accounts.map((account) => (
                    <AccountRow
                      key={account.accountId}
                      connection={connection}
                      account={account}
                      busyKey={busyKey}
                      rename={
                        renaming?.provider === account.provider &&
                        renaming.accountId === account.accountId
                          ? renaming.value
                          : null
                      }
                      testOutput={
                        testOutput?.provider === account.provider &&
                        testOutput.accountId === account.accountId
                          ? testOutput.output
                          : null
                      }
                      on={handlers}
                    />
                  ))}

                  {connection.accounts.length > 0 ? (
                    <div className="space-y-1.5 border-t border-border/60 pt-2.5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          value={newNames[connection.provider] ?? ""}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={suggestedAccountName(connection)}
                          aria-label={`Name for the next ${connection.label} account`}
                          className="h-7 text-xs sm:max-w-56"
                          onChange={(event) =>
                            setNewNames((previous) => ({
                              ...previous,
                              [connection.provider]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void startSignIn(connection.provider, {
                              newAccount: true,
                              label: (newNames[connection.provider] ?? "").trim(),
                            })
                          }
                        >
                          {addBusy ? spinner : <PlusIcon className="size-3.5" />}
                          Connect another {connection.label} account
                        </Button>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {connection.provider === "claude"
                          ? // Claude's sign-in hands back a token and no identity
                            // at all, so a name typed here is the only thing that
                            // will ever tell two accounts apart.
                            "A name is optional — without one it will be called by its position, and you can rename it any time."
                          : "A name is optional — without one it will be called by the email Codex signs in with."}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}

          {signInSession ? (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
              <div className="font-semibold text-foreground">
                Finish signing in to {signInSession.accountLabel ?? signInSession.label}
              </div>
              <a
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                href={signInSession.url ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLinkIcon className="size-3.5" />
                Open the {signInSession.label} sign-in page
              </a>
              {signInSession.code ? (
                <div>
                  <div className="mb-1 text-muted-foreground">Enter this code on that page</div>
                  <div className="rounded-md border border-dashed border-primary bg-background px-3 py-2 text-center font-mono text-lg tracking-[0.2em] text-foreground">
                    {signInSession.code}
                  </div>
                </div>
              ) : null}
              {signInSession.wantsCode ? (
                <div className="space-y-2">
                  <label
                    htmlFor="provider-auth-code"
                    className="block text-xs font-medium text-foreground"
                  >
                    Paste the code the page gives you back
                  </label>
                  <Input
                    id="provider-auth-code"
                    value={code}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      disabled={isSubmittingCode || code.trim().length === 0}
                      onClick={() => void submitCode()}
                    >
                      {isSubmittingCode ? spinner : <CheckIcon className="size-3.5" />}
                      Finish sign-in
                    </Button>
                    <span className="text-muted-foreground">
                      This can take a few seconds to come back.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground">
                  Waiting for you to finish in the browser…
                </div>
              )}
            </div>
          ) : null}

          {/* Sharing is per workspace and this page is not, so it lives in the
              collaboration panel — but somebody who just connected a second
              account did it to lend one, and would otherwise look for it here. */}
          <p className="text-[11px] leading-4 text-muted-foreground">
            These accounts are yours alone. To let a workspace run turns on one of them, open the
            collaboration panel in that workspace and contribute it there — sharing is switched on
            per workspace, not here.
          </p>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
