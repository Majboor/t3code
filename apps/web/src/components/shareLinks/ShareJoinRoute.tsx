import type { AuthSessionState, ShareLinkAudienceKind } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  Loader2Icon,
  LogInIcon,
  UserPlusIcon,
  UsersIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import type { ServerAuthGateState } from "../../environments/primary";
import {
  signOutLocalServerSession,
  submitLocalPasswordAuth,
  submitSupabasePasswordAuth,
  type SupabasePasswordAuthMode,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  claimShareLink,
  fetchShareLinkPreview,
  ShareJoinError,
  type ShareJoinFailureKind,
} from "./shareJoin";
import { describeShareLinkJoin } from "./shareLinks.logic";

/**
 * Where a workspace share link lands.
 *
 * The screen this replaces was the pairing form, which asks for a token that
 * trusts a *device*. A share recipient has no such token and no way to get one,
 * so that screen was a dead end with a text field in it. Nothing here can ever
 * render it: this route draws its own sign-in, and the only two things it can
 * ask for are an account and a password.
 *
 * The order is fixed and it matters. The link is described first, to whoever is
 * holding it, so that a person is never asked to make an account before being
 * told what for. Only then is identity asked for, and only then is the claim
 * made — and the claim is the single place any access is granted, on the server,
 * against the address on the account rather than against anything typed here.
 */
export function ShareJoinRoute({
  authGateState,
  token,
}: {
  readonly authGateState: ServerAuthGateState;
  /** Straight out of the URL; null when the visitor arrived without one. */
  readonly token: string | null;
}) {
  const [preview, setPreview] = useState<
    | { readonly status: "loading" }
    | {
        readonly status: "ready";
        readonly audience: ShareLinkAudienceKind;
        readonly label: string | null;
      }
    | { readonly status: "unavailable"; readonly message: string }
  >({ status: "loading" });
  const [claim, setClaim] = useState<
    | { readonly status: "idle" | "claiming" | "joined" }
    | { readonly status: "refused"; readonly kind: ShareJoinFailureKind; readonly message: string }
  >({ status: "idle" });
  const claimedRef = useRef(false);

  const authenticated = authGateState.status === "authenticated";

  useEffect(() => {
    if (token === null) {
      setPreview({ status: "unavailable", message: "This link is not available." });
      return;
    }
    let disposed = false;
    void fetchShareLinkPreview(token)
      .then((result) => {
        if (disposed) return;
        setPreview({ status: "ready", audience: result.audience, label: result.label });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setPreview({
          status: "unavailable",
          message:
            error instanceof ShareJoinError && error.kind === "unavailable"
              ? error.message
              : "This link is not available.",
        });
      });
    return () => {
      disposed = true;
    };
  }, [token]);

  // Claimed as soon as there is somebody to claim as, and exactly once. The
  // guard is a ref rather than state because a re-render between the request
  // and its reply would otherwise start a second join.
  useEffect(() => {
    if (!authenticated || token === null || preview.status !== "ready" || claimedRef.current) {
      return;
    }
    claimedRef.current = true;
    setClaim({ status: "claiming" });
    void claimShareLink(token)
      .then(() => setClaim({ status: "joined" }))
      .catch((error: unknown) => {
        const kind = error instanceof ShareJoinError ? error.kind : "failed";
        setClaim({
          status: "refused",
          kind,
          message: error instanceof Error ? error.message : "Could not open this link.",
        });
      });
  }, [authenticated, preview.status, token]);

  const useAnotherAccount = useCallback(async () => {
    await signOutLocalServerSession().catch(() => undefined);
    window.location.assign(window.location.href);
  }, []);

  const copy =
    preview.status === "ready" ? describeShareLinkJoin(preview.audience, preview.label) : null;

  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground"
      data-testid="share-join"
    >
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <p className="text-sm font-semibold">{APP_DISPLAY_NAME}</p>

        {preview.status === "loading" ? (
          <Pending title="Opening this link" detail="Reading what it points at." />
        ) : preview.status === "unavailable" ? (
          <Dead
            title="This link is not available"
            // Verbatim from the server, which refuses to say whether the link
            // never existed, has lapsed, or was switched off. Guessing which
            // here would invent the distinction the server withholds.
            detail={preview.message}
          />
        ) : (
          <>
            <div className="mt-4 flex items-center gap-2">
              <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="text-base font-semibold" data-testid="share-join-title">
                {copy?.title}
              </h1>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy?.detail}</p>

            {claim.status === "joined" ? (
              <div className="mt-5" data-testid="share-join-joined">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2Icon className="size-4" />
                  You are in
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  This workspace is yours to open now.
                </p>
                <Button className="mt-4" size="sm" onClick={() => window.location.assign("/")}>
                  Open the workspace
                </Button>
              </div>
            ) : claim.status === "claiming" ? (
              <Pending title="Letting you in" detail="Keep this window open." />
            ) : claim.status === "refused" ? (
              <div className="mt-5" data-testid="share-join-refused">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <XCircleIcon className="size-4" />
                  {claim.kind === "wrong-account"
                    ? "This link is not for this account"
                    : "Could not open this link"}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{claim.message}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void useAnotherAccount()}>
                    Use another account
                  </Button>
                </div>
              </div>
            ) : authenticated ? (
              <Pending title="Letting you in" detail="Keep this window open." />
            ) : (
              <ShareJoinSignIn
                auth={authGateState.status === "requires-auth" ? authGateState.auth : undefined}
                audience={preview.audience}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Pending({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="mt-4" data-testid="share-join-pending">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        {title}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function Dead({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="mt-4" data-testid="share-join-dead">
      <div className="flex items-center gap-2 text-sm font-medium">
        <XCircleIcon className="size-4 text-destructive" />
        {title}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Ask whoever sent it for a fresh one.
      </p>
    </div>
  );
}

/**
 * Sign in, or sign up, and nothing else.
 *
 * No pairing-token field, not even folded away behind a disclosure: a pairing
 * token trusts a device that is already trusted, which is a thing this visitor
 * cannot have and would not be helped by. If the environment has no password
 * auth configured at all, that is said plainly rather than papered over with a
 * form nobody can complete.
 */
function ShareJoinSignIn({
  auth,
  audience,
}: {
  readonly auth: AuthSessionState["auth"] | undefined;
  readonly audience: ShareLinkAudienceKind;
}) {
  const [mode, setMode] = useState<SupabasePasswordAuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [offerSignup, setOfferSignup] = useState(false);

  const supabase = auth?.supabase;
  const hasPasswordAuth = Boolean(supabase) || Boolean(auth?.localPassword);

  if (!hasPasswordAuth) {
    return (
      <div className="mt-5" data-testid="share-join-no-auth">
        <div className="flex items-center gap-2 text-sm font-medium">
          <XCircleIcon className="size-4 text-destructive" />
          There is no way to sign in here yet
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          This environment accepts no email sign-in, so a link cannot let anybody new in. Ask
          whoever sent it to turn on password sign-in, or to invite you from inside the workspace.
        </p>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setErrorMessage("");
    try {
      await (supabase
        ? submitSupabasePasswordAuth({ config: supabase, email, password, mode })
        : submitLocalPasswordAuth({ email, password, mode }));
      // A full reload rather than a state update: the session cookie is new,
      // and every gate in the app resolved before it existed. Coming back
      // through the front door is the only way to be sure they all agree.
      window.location.assign(window.location.href);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Sign in failed.";
      setErrorMessage(message);
      // The one hint worth giving, and only in the direction that is safe:
      // "log in failed" never says whether the address exists, so offering to
      // create the account discloses nothing and is what a recipient with no
      // account here actually needs.
      setOfferSignup(mode === "login");
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-5"
      data-testid="share-join-signin"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-2 rounded-lg border border-border bg-background p-1">
        <Button
          aria-pressed={mode === "login"}
          className="w-full"
          disabled={busy}
          onClick={() => setMode("login")}
          size="sm"
          type="button"
          variant={mode === "login" ? "secondary" : "ghost"}
        >
          Sign in
        </Button>
        <Button
          aria-pressed={mode === "signup"}
          className="w-full"
          disabled={busy}
          onClick={() => setMode("signup")}
          size="sm"
          type="button"
          variant={mode === "signup" ? "secondary" : "ghost"}
        >
          Create account
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        <label className="text-sm font-medium" htmlFor="share-join-email">
          Email
        </label>
        <Input
          id="share-join-email"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect="off"
          disabled={busy}
          nativeInput
          onChange={(event) => setEmail(event.currentTarget.value)}
          placeholder="you@example.com"
          spellCheck={false}
          type="email"
          value={email}
        />
        {audience === "restricted" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Use the address this link was sent to. Any other account is refused.
          </p>
        ) : null}
      </div>

      <div className="mt-4 space-y-2">
        <label className="text-sm font-medium" htmlFor="share-join-password">
          Password
        </label>
        <Input
          id="share-join-password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          disabled={busy}
          nativeInput
          onChange={(event) => setPassword(event.currentTarget.value)}
          placeholder="Password"
          type="password"
          value={password}
        />
      </div>

      {errorMessage ? (
        <div
          className="mt-4 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          data-testid="share-join-signin-error"
        >
          {errorMessage}
        </div>
      ) : null}

      {offerSignup && mode === "login" ? (
        <button
          className="mt-2 text-xs text-muted-foreground underline underline-offset-2"
          data-testid="share-join-offer-signup"
          onClick={() => {
            setMode("signup");
            setOfferSignup(false);
            setErrorMessage("");
          }}
          type="button"
        >
          No account with that address yet? Create one.
        </button>
      ) : null}

      <Button className="mt-5 w-full" disabled={busy} size="lg" type="submit">
        {busy ? (
          <Loader2Icon className="animate-spin" />
        ) : mode === "signup" ? (
          <UserPlusIcon />
        ) : (
          <LogInIcon />
        )}
        {busy ? "Opening…" : mode === "signup" ? "Create account and join" : "Sign in and join"}
      </Button>
    </form>
  );
}
