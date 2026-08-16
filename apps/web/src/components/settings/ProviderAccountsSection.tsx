import { CheckIcon, ExternalLinkIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readSupabaseBrowserAccessToken } from "../../environments/primary/auth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Connecting a provider account, in two buttons.
 *
 * This used to ask for a thread, open a terminal in it, and expect the person
 * to read a CLI, run a status command and paste its output back. That is a lot
 * to ask of someone who only wants to sign in, and one of the commands it told
 * them to run could not actually be completed. The server drives both CLIs now
 * and hands back only the two things a person needs — where to go, and what to
 * type — so all that is left here is a button each.
 */

type ProviderName = "codex" | "claude";

type Connection = {
  readonly provider: ProviderName;
  readonly label: string;
  readonly connected: boolean;
};

/** What the server printed for a sign-in that is currently in progress. */
type SignInSession = {
  readonly provider: ProviderName;
  readonly label: string;
  readonly url: string | null;
  readonly code: string | null;
  readonly wantsCode: boolean;
};

const PROVIDER_LABELS: Record<ProviderName, string> = { codex: "Codex", claude: "Claude" };

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

export function ProviderAccountsSection() {
  const [connections, setConnections] = useState<readonly Connection[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<ProviderName | null>(null);
  const [signInSession, setSignInSession] = useState<SignInSession | null>(null);
  const [code, setCode] = useState("");
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
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
      const loaded = (data["connections"] ?? []) as readonly Connection[];
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
   */
  const watchUntilConnected = useCallback(
    async (provider: ProviderName) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        if (!isMountedRef.current) {
          return;
        }
        const loaded = await refresh();
        if (loaded?.find((entry) => entry.provider === provider)?.connected) {
          setSignInSession(null);
          setStatusMessage(`${PROVIDER_LABELS[provider]} connected.`);
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
    async (provider: ProviderName) => {
      setBusyProvider(provider);
      setErrorMessage(null);
      setStatusMessage(null);
      setSignInSession(null);
      setCode("");
      try {
        const { ok, data } = await callProviderAuth("start", { method: "POST", body: { provider } });
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
        const wantsCode = data["wantsCode"] === true;
        setSignInSession({
          provider,
          label: typeof data["label"] === "string" ? data["label"] : PROVIDER_LABELS[provider],
          url,
          code: typeof data["code"] === "string" ? data["code"] : null,
          wantsCode,
        });
        if (!wantsCode) {
          void watchUntilConnected(provider);
        }
      } catch {
        if (isMountedRef.current) {
          setErrorMessage("Failed to reach the server.");
        }
      } finally {
        if (isMountedRef.current) {
          setBusyProvider(null);
        }
      }
    },
    [watchUntilConnected],
  );

  const submitCode = useCallback(async () => {
    if (!signInSession || code.trim().length === 0) {
      return;
    }
    setIsSubmittingCode(true);
    setErrorMessage(null);
    try {
      const { ok, data } = await callProviderAuth("code", {
        method: "POST",
        body: { provider: signInSession.provider, code: code.trim() },
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
        setStatusMessage(`${signInSession.label} connected.`);
        await refresh();
        return;
      }
      setErrorMessage(
        data["failed"] === true
          ? `${signInSession.label} rejected that code. Start the sign-in again for a fresh one.`
          : `${signInSession.label} did not return a token. Start the sign-in again.`,
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

  const disconnect = useCallback(
    async (provider: ProviderName) => {
      setBusyProvider(provider);
      setErrorMessage(null);
      setStatusMessage(null);
      try {
        const { ok, data } = await callProviderAuth("logout", {
          method: "POST",
          body: { provider },
        });
        if (!isMountedRef.current) {
          return;
        }
        if (!ok) {
          setErrorMessage(errorFrom(data, "Failed to disconnect."));
          return;
        }
        setStatusMessage(`${PROVIDER_LABELS[provider]} disconnected.`);
        await refresh();
      } catch {
        if (isMountedRef.current) {
          setErrorMessage("Failed to reach the server.");
        }
      } finally {
        if (isMountedRef.current) {
          setBusyProvider(null);
        }
      }
    },
    [refresh],
  );

  return (
    <SettingsSection
      title="Provider Accounts"
      headerAction={
        <Button size="xs" variant="outline" disabled={isRefreshing} onClick={() => void refresh()}>
          {isRefreshing ? (
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
        description="Sign in with your own provider accounts. Agent runs use the account you connect here, and nobody else's."
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
            connections.map((connection) => (
              <div
                key={connection.provider}
                className="flex flex-col gap-3 rounded-md border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold text-foreground">{connection.label}</div>
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
                  <div className="text-xs text-muted-foreground">
                    {connection.connected
                      ? `Turns on this account run as your ${connection.label} login.`
                      : `${connection.label} turns will not run until you connect an account.`}
                  </div>
                </div>
                {connection.connected ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busyProvider !== null}
                    onClick={() => void disconnect(connection.provider)}
                  >
                    {busyProvider === connection.provider ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : null}
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    disabled={busyProvider !== null}
                    onClick={() => void startSignIn(connection.provider)}
                  >
                    {busyProvider === connection.provider ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <ExternalLinkIcon className="size-3.5" />
                    )}
                    Open {connection.label} sign-in
                  </Button>
                )}
              </div>
            ))
          )}

          {signInSession ? (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
              <div className="font-semibold text-foreground">
                Finish signing in to {signInSession.label}
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
                      {isSubmittingCode ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <CheckIcon className="size-3.5" />
                      )}
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
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
