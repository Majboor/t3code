import type { AuthSessionState } from "@t3tools/contracts";
import { KeyRoundIcon, Loader2Icon, LogInIcon, UserPlusIcon, UserRoundIcon } from "lucide-react";
import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitLocalPasswordAuth,
  submitServerAuthCredential,
  submitSupabasePasswordAuth,
  type SupabasePasswordAuthMode,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PairingPendingSurface() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex size-14 items-center justify-center rounded-full border border-border bg-secondary">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
        <p className="mt-5 text-sm font-semibold">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-2 text-xl font-semibold">Pairing with this environment</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Validating the pairing link and preparing your session.
        </p>
      </section>
    </div>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const tokenFromUrlRef = useRef<string | null>(peekPairingTokenFromUrl());
  const shouldAutoSubmitPairingToken = !(
    (auth.supabase || auth.localPassword) &&
    isInviteRoutePath()
  );
  const autoPairTokenRef = useRef<string | null>(
    shouldAutoSubmitPairingToken ? tokenFromUrlRef.current : null,
  );
  const [credential, setCredential] = useState(() => tokenFromUrlRef.current ?? "");
  const [supabaseEmail, setSupabaseEmail] = useState("");
  const [supabasePassword, setSupabasePassword] = useState("");
  const [supabaseMode, setSupabaseMode] = useState<SupabasePasswordAuthMode>("login");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [submittingMode, setSubmittingMode] = useState<"pairing" | "supabase" | null>(null);
  const autoSubmitAttemptedRef = useRef(false);
  const hasSupabaseAuth = Boolean(auth.supabase);
  const hasPasswordAuth = hasSupabaseAuth || Boolean(auth.localPassword);
  const isSubmitting = submittingMode !== null;

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setSubmittingMode("pairing");
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setSubmittingMode(null);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const submitSupabaseCredentials = useCallback(
    async (input: { email: string; password: string; mode: SupabasePasswordAuthMode }) => {
      if (!auth.supabase && !auth.localPassword) {
        setErrorMessage("Password auth is not configured for this environment.");
        return;
      }
      setSubmittingMode("supabase");
      setErrorMessage("");

      const authRequest = auth.supabase
        ? submitSupabasePasswordAuth({
            config: auth.supabase,
            email: input.email,
            password: input.password,
            mode: input.mode,
          })
        : submitLocalPasswordAuth({
            email: input.email,
            password: input.password,
            mode: input.mode,
          });
      const submitError = await authRequest.then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setSubmittingMode(null);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [auth.localPassword, auth.supabase, onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  const handleSupabaseSubmit = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitSupabaseCredentials({
        email: supabaseEmail,
        password: supabasePassword,
        mode: supabaseMode,
      });
    },
    [submitSupabaseCredentials, supabaseEmail, supabaseMode, supabasePassword],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  useEffect(() => {
    if (!tokenFromUrlRef.current || shouldAutoSubmitPairingToken) {
      return;
    }
    stripPairingTokenFromUrl();
  }, [shouldAutoSubmitPairingToken]);

  const errorBlock = errorMessage ? (
    <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
      {errorMessage}
    </div>
  ) : null;

  const pairingForm = (
    <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="pairing-token">
          Pairing token
        </label>
        <Input
          id="pairing-token"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={isSubmitting}
          nativeInput
          onChange={(event) => setCredential(event.currentTarget.value)}
          placeholder="Paste token"
          spellCheck={false}
          value={credential}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={isSubmitting} size="sm" type="submit">
          {submittingMode === "pairing" ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <KeyRoundIcon />
          )}
          {submittingMode === "pairing" ? "Pairing..." : "Continue"}
        </Button>
        <Button
          disabled={isSubmitting}
          onClick={() => window.location.reload()}
          size="sm"
          variant="outline"
        >
          Reload app
        </Button>
      </div>
    </form>
  );

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-6 text-foreground sm:px-6">
      <section className="grid w-full max-w-5xl overflow-hidden rounded-lg border border-border bg-card shadow-sm md:min-h-[540px] md:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex min-h-[520px] flex-col justify-center p-6 sm:p-8">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">{APP_DISPLAY_NAME}</span>
            <span className="rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
              DEV
            </span>
          </div>

          <div className="mt-10 flex justify-center">
            <div className="flex size-16 items-center justify-center rounded-full border border-border bg-secondary">
              <UserRoundIcon className="size-7 text-muted-foreground" />
            </div>
          </div>

          {hasPasswordAuth ? (
            <form className="mt-8" onSubmit={(event) => void handleSupabaseSubmit(event)}>
              <div className="grid grid-cols-2 rounded-lg border border-border bg-background p-1">
                <Button
                  aria-pressed={supabaseMode === "login"}
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSupabaseMode("login")}
                  size="sm"
                  type="button"
                  variant={supabaseMode === "login" ? "secondary" : "ghost"}
                >
                  Log in
                </Button>
                <Button
                  aria-pressed={supabaseMode === "signup"}
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => setSupabaseMode("signup")}
                  size="sm"
                  type="button"
                  variant={supabaseMode === "signup" ? "secondary" : "ghost"}
                >
                  Sign up
                </Button>
              </div>

              <div className="mt-5 space-y-2">
                <label className="text-sm font-medium" htmlFor="supabase-email">
                  Email
                </label>
                <Input
                  id="supabase-email"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect="off"
                  disabled={isSubmitting}
                  nativeInput
                  onChange={(event) => setSupabaseEmail(event.currentTarget.value)}
                  placeholder="you@example.com"
                  spellCheck={false}
                  type="email"
                  value={supabaseEmail}
                />
              </div>

              <div className="mt-4 space-y-2">
                <label className="text-sm font-medium" htmlFor="supabase-password">
                  Password
                </label>
                <Input
                  id="supabase-password"
                  autoComplete={supabaseMode === "login" ? "current-password" : "new-password"}
                  disabled={isSubmitting}
                  nativeInput
                  onChange={(event) => setSupabasePassword(event.currentTarget.value)}
                  placeholder="Password"
                  type="password"
                  value={supabasePassword}
                />
              </div>

              {errorBlock}

              <Button className="mt-5 w-full" disabled={isSubmitting} size="lg" type="submit">
                {submittingMode === "supabase" ? (
                  <Loader2Icon className="animate-spin" />
                ) : supabaseMode === "signup" ? (
                  <UserPlusIcon />
                ) : (
                  <LogInIcon />
                )}
                {submittingMode === "supabase"
                  ? "Signing in..."
                  : supabaseMode === "signup"
                    ? "Create account"
                    : "Login"}
              </Button>
            </form>
          ) : (
            <div className="mt-8">
              <h1 className="text-xl font-semibold">Pair with this environment</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {describeAuthGate(auth.bootstrapMethods)}
              </p>
              <div className="mt-5">{pairingForm}</div>
              {errorBlock}
            </div>
          )}

          {hasPasswordAuth ? (
            <details className="mt-5 border-t border-border pt-4 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Use pairing token</summary>
              <div className="mt-4">{pairingForm}</div>
            </details>
          ) : null}

          <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
            {describeSupportedMethods(auth.bootstrapMethods)}
          </p>
        </div>

        <div className="relative hidden overflow-hidden border-l border-border bg-[linear-gradient(125deg,color-mix(in_srgb,var(--background)_98%,var(--color-black))_0%,color-mix(in_srgb,var(--primary)_30%,var(--background))_50%,color-mix(in_srgb,var(--card)_86%,var(--color-white))_100%)] md:block">
          <div className="absolute inset-0 bg-[radial-gradient(40rem_28rem_at_20%_12%,color-mix(in_srgb,var(--color-cyan-300)_48%,transparent),transparent_62%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(34rem_24rem_at_72%_4%,color-mix(in_srgb,var(--color-amber-200)_72%,transparent),transparent_58%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(104deg,transparent_0%,transparent_35%,color-mix(in_srgb,var(--background)_82%,transparent)_36%,color-mix(in_srgb,var(--background)_54%,transparent)_48%,transparent_62%)]" />
          <div className="absolute inset-y-0 left-0 w-[42%] bg-[linear-gradient(94deg,color-mix(in_srgb,var(--background)_48%,transparent),transparent)]" />
          <div className="relative flex h-full flex-col items-end justify-center px-12 text-right">
            <h2 className="text-4xl font-semibold text-white drop-shadow-sm">Welcome.</h2>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/72">
              Sign in, accept your invite, and continue into the workspace.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function isInviteRoutePath(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/invite";
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
