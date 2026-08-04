import { LoaderIcon, PlusIcon, RefreshCwIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ProviderAccountConnectInstructions,
  type ProviderAccountConnectScope,
  type ProviderAccountId,
  type ProviderAccountSummary,
  type ProviderKind,
  type ScopedThreadRef,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { selectThreadShellsAcrossEnvironments, useStore } from "../../store";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ProviderConnectSession = {
  provider: ProviderKind;
  accountScope: ProviderAccountConnectScope;
  instructions: ProviderAccountConnectInstructions;
  threadRef: ScopedThreadRef | null;
  terminal: TerminalSessionSnapshot | null;
  statusOutput: string;
};

function formatProviderAccountOwner(account: ProviderAccountSummary): string {
  switch (account.owner.type) {
    case "user":
      return account.sharing === "private" ? "Private user account" : "Shared user account";
    case "tenant":
      return "Tenant shared account";
    case "organization":
      return "Organization shared account";
  }
}

function formatProviderAccountStatus(account: ProviderAccountSummary): string {
  if (account.status === "disabled") {
    return "Disconnected";
  }
  return account.activeSessionCount > 0
    ? `Connected, ${account.activeSessionCount} active session${account.activeSessionCount === 1 ? "" : "s"}`
    : "Connected";
}

function formatProviderAccountProvider(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
  }
}

function formatProviderAccountDate(value: string | null): string {
  if (!value) {
    return "Never";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

// Local loopback backends reject provider account RPCs with this guidance; surface it as an
// informative state instead of an inline error.
function isHostedTenantSessionError(message: string): boolean {
  return message.includes("hosted tenant session");
}

export function ProviderAccountsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const [providerAccounts, setProviderAccounts] = useState<readonly ProviderAccountSummary[]>([]);
  const [providerAccountErrorMessage, setProviderAccountErrorMessage] = useState<string | null>(
    null,
  );
  const [providerConnectSession, setProviderConnectSession] =
    useState<ProviderConnectSession | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [requiresHostedTenant, setRequiresHostedTenant] = useState(false);
  const [isRefreshingProviderAccounts, setIsRefreshingProviderAccounts] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<ProviderKind | null>(null);
  const [confirmingProvider, setConfirmingProvider] = useState<ProviderKind | null>(null);
  const [providerAccountConnectScope, setProviderAccountConnectScope] =
    useState<ProviderAccountConnectScope>("personal");
  const [disconnectingProviderAccountId, setDisconnectingProviderAccountId] =
    useState<ProviderAccountId | null>(null);
  const threadShells = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const providerAuthThreadRef = useMemo<ScopedThreadRef | null>(() => {
    if (!environmentId) {
      return null;
    }
    const environmentThreads = threadShells
      .filter((thread) => thread.environmentId === environmentId)
      .toSorted((left, right) => {
        const leftUpdatedAt = left.updatedAt ?? left.createdAt;
        const rightUpdatedAt = right.updatedAt ?? right.createdAt;
        return rightUpdatedAt.localeCompare(leftUpdatedAt);
      });
    const thread = environmentThreads.find((candidate) => candidate.archivedAt === null);
    return thread ? scopeThreadRef(thread.environmentId, thread.id) : null;
  }, [environmentId, threadShells]);

  const reportProviderAccountError = useCallback((error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    if (isHostedTenantSessionError(message)) {
      setRequiresHostedTenant(true);
      setProviderAccountErrorMessage(null);
      return;
    }
    setProviderAccountErrorMessage(message);
  }, []);

  const refreshProviderAccounts = useCallback(async () => {
    setIsRefreshingProviderAccounts(true);
    setProviderAccountErrorMessage(null);
    setRequiresHostedTenant(false);
    try {
      if (!environmentId) {
        setProviderAccounts([]);
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        setProviderAccounts([]);
        return;
      }
      const result = await api.providerAccounts.list();
      setProviderAccounts(result.accounts);
    } catch (error) {
      reportProviderAccountError(error, "Failed to load provider accounts.");
    } finally {
      setIsRefreshingProviderAccounts(false);
    }
  }, [environmentId, reportProviderAccountError]);

  const disconnectProviderAccount = useCallback(
    async (providerAccountId: ProviderAccountId) => {
      setDisconnectingProviderAccountId(providerAccountId);
      setProviderAccountErrorMessage(null);
      try {
        if (!environmentId) {
          throw new Error("Environment API not found.");
        }
        const api = readEnvironmentApi(environmentId);
        if (!api) {
          throw new Error("Environment API not found.");
        }
        const result = await api.providerAccounts.disconnect({ providerAccountId });
        setProviderAccounts((accounts) =>
          accounts.map((account) => (account.id === result.account.id ? result.account : account)),
        );
        setStatusMessage("Provider account disconnected.");
      } catch (error) {
        reportProviderAccountError(error, "Failed to disconnect provider account.");
      } finally {
        setDisconnectingProviderAccountId(null);
      }
    },
    [environmentId, reportProviderAccountError],
  );

  const connectProviderAccount = useCallback(
    async (provider: ProviderKind, accountScope: ProviderAccountConnectScope) => {
      setConnectingProvider(provider);
      setProviderAccountErrorMessage(null);
      setStatusMessage(null);
      try {
        if (!environmentId) {
          throw new Error("Environment API not found.");
        }
        const api = readEnvironmentApi(environmentId);
        if (!api) {
          throw new Error("Environment API not found.");
        }
        if (providerAuthThreadRef) {
          const result = await api.providerAccounts.openAuthTerminal({
            provider,
            threadId: providerAuthThreadRef.threadId,
            accountScope,
          });
          setProviderConnectSession({
            provider,
            accountScope,
            instructions: result.instructions,
            threadRef: providerAuthThreadRef,
            terminal: result.terminal,
            statusOutput: "",
          });
          setStatusMessage(`${formatProviderAccountProvider(provider)} auth terminal opened.`);
        } else {
          const result = await api.providerAccounts.connect({ provider, accountScope });
          setProviderConnectSession({
            provider,
            accountScope,
            instructions: result.instructions,
            threadRef: null,
            terminal: null,
            statusOutput: "",
          });
          setStatusMessage(
            `${formatProviderAccountProvider(provider)} connect flow prepared. Open a thread to launch the auth terminal.`,
          );
        }
      } catch (error) {
        reportProviderAccountError(error, "Failed to prepare provider connect flow.");
      } finally {
        setConnectingProvider(null);
      }
    },
    [environmentId, providerAuthThreadRef, reportProviderAccountError],
  );

  const confirmProviderAccount = useCallback(async () => {
    if (!providerConnectSession) {
      return;
    }
    const statusOutput = providerConnectSession.statusOutput.trim();
    if (!statusOutput) {
      setProviderAccountErrorMessage("Paste the provider status output before confirming.");
      return;
    }
    if (!providerConnectSession.threadRef) {
      setProviderAccountErrorMessage(
        "Open a thread and start the auth terminal before confirming.",
      );
      return;
    }
    setConfirmingProvider(providerConnectSession.provider);
    setProviderAccountErrorMessage(null);
    setStatusMessage(null);
    try {
      if (!environmentId) {
        throw new Error("Environment API not found.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API not found.");
      }
      const result = await api.providerAccounts.confirm({
        provider: providerConnectSession.provider,
        threadId: providerConnectSession.threadRef.threadId,
        statusOutput,
        accountScope: providerConnectSession.accountScope,
      });
      setProviderAccounts((accounts) => {
        const existingIndex = accounts.findIndex((account) => account.id === result.account.id);
        if (existingIndex === -1) {
          return [result.account, ...accounts];
        }
        return accounts.map((account) =>
          account.id === result.account.id ? result.account : account,
        );
      });
      setProviderConnectSession(null);
      setStatusMessage(
        `${formatProviderAccountProvider(providerConnectSession.provider)} provider account connected.`,
      );
    } catch (error) {
      reportProviderAccountError(error, "Failed to confirm provider account.");
    } finally {
      setConfirmingProvider(null);
    }
  }, [environmentId, providerConnectSession, reportProviderAccountError]);

  useEffect(() => {
    void refreshProviderAccounts();
  }, [refreshProviderAccounts]);

  return (
    <SettingsSection
      title="Provider Accounts"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={isRefreshingProviderAccounts}
          onClick={refreshProviderAccounts}
        >
          {isRefreshingProviderAccounts ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title="Codex and Claude"
        description="Bring your own provider logins. Accounts are scoped to the current tenant session."
        status={
          providerAccountErrorMessage ? (
            <span className="text-destructive">{providerAccountErrorMessage}</span>
          ) : statusMessage ? (
            <span className="text-success">{statusMessage}</span>
          ) : null
        }
      >
        <div className="space-y-3 border-t border-border/60 pt-3 pb-4">
          {requiresHostedTenant ? (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              Provider account linking requires a hosted tenant session. This backend is running in
              local loopback mode, so Codex and Claude use the local CLI logins configured on this
              machine.
            </div>
          ) : (
            <>
              <div className="inline-flex rounded-md border border-border bg-background p-0.5">
                {(["personal", "organization"] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    className={cn(
                      "rounded-sm px-2.5 py-1 text-xs font-medium",
                      providerAccountConnectScope === scope
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setProviderAccountConnectScope(scope)}
                  >
                    {scope === "personal" ? "Personal" : "Organization shared"}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {(["codex", "claudeAgent"] as const).map((provider) => (
                  <Button
                    key={provider}
                    size="xs"
                    variant="outline"
                    disabled={connectingProvider !== null}
                    onClick={() =>
                      void connectProviderAccount(provider, providerAccountConnectScope)
                    }
                  >
                    {connectingProvider === provider ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <PlusIcon className="size-3.5" />
                    )}
                    Connect {formatProviderAccountProvider(provider)}
                  </Button>
                ))}
              </div>
              {providerConnectSession ? (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-foreground">
                      {formatProviderAccountProvider(providerConnectSession.provider)}{" "}
                      {providerConnectSession.accountScope === "organization"
                        ? "organization setup"
                        : "personal setup"}
                    </div>
                    {providerConnectSession.terminal ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <TerminalIcon className="size-3" />
                        {providerConnectSession.terminal.terminalId}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 space-y-2 text-muted-foreground">
                    {providerConnectSession.instructions.steps.map((step) => (
                      <div key={step}>{step}</div>
                    ))}
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-muted-foreground">Auth command</div>
                      <code className="block overflow-x-auto rounded-sm border border-border bg-background px-2 py-1 text-foreground">
                        {providerConnectSession.instructions.authCommand}
                      </code>
                    </div>
                    <div>
                      <div className="mb-1 text-muted-foreground">Status command</div>
                      <code className="block overflow-x-auto rounded-sm border border-border bg-background px-2 py-1 text-foreground">
                        {providerConnectSession.instructions.statusCommand}
                      </code>
                    </div>
                  </div>
                  <div className="mt-2 text-muted-foreground">
                    {providerConnectSession.instructions.verificationHint}
                  </div>
                  <div className="mt-3 space-y-2">
                    <label
                      htmlFor={`provider-status-output-${providerConnectSession.provider}`}
                      className="block text-xs font-medium text-foreground"
                    >
                      Status output
                    </label>
                    <Textarea
                      id={`provider-status-output-${providerConnectSession.provider}`}
                      value={providerConnectSession.statusOutput}
                      onChange={(event) => {
                        const statusOutput = event.target.value;
                        setProviderConnectSession((current) =>
                          current ? { ...current, statusOutput } : current,
                        );
                        if (providerAccountErrorMessage) {
                          setProviderAccountErrorMessage(null);
                        }
                      }}
                      placeholder={providerConnectSession.instructions.statusCommand}
                      className="min-h-24 font-mono text-xs"
                      spellCheck={false}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="xs"
                        disabled={confirmingProvider !== null || !providerConnectSession.threadRef}
                        onClick={() => void confirmProviderAccount()}
                      >
                        {confirmingProvider === providerConnectSession.provider ? (
                          <LoaderIcon className="size-3.5 animate-spin" />
                        ) : null}
                        Confirm status
                      </Button>
                      {!providerConnectSession.threadRef ? (
                        <span className="text-xs text-muted-foreground">
                          Open a thread to launch the auth terminal before confirming.
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
              {providerAccounts.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No provider accounts connected.
                </div>
              ) : (
                providerAccounts.map((account) => {
                  const providerLabel = formatProviderAccountProvider(account.provider);
                  const isDisconnecting = disconnectingProviderAccountId === account.id;
                  const isDisconnected = account.status === "disabled";
                  return (
                    <div
                      key={account.id}
                      className="flex flex-col gap-3 rounded-md border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-semibold text-foreground">
                            {providerLabel}
                          </div>
                          <span
                            className={cn(
                              "rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
                              isDisconnected
                                ? "border-border text-muted-foreground"
                                : "border-success/30 bg-success/10 text-success",
                            )}
                          >
                            {formatProviderAccountStatus(account)}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatProviderAccountOwner(account)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Connected {formatProviderAccountDate(account.createdAt)}
                          {account.disabledAt
                            ? ` · Disconnected ${formatProviderAccountDate(account.disabledAt)}`
                            : ""}
                        </div>
                      </div>
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={isDisconnected || isDisconnecting}
                        onClick={() => void disconnectProviderAccount(account.id)}
                      >
                        {isDisconnecting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                        Disconnect
                      </Button>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
