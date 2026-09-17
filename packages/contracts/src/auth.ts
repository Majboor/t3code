import { Schema } from "effect";

import { AuthSessionId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";
import { TenantSessionContext } from "./tenancy.ts";

/**
 * Declares the server's overall authentication posture.
 *
 * This is a high-level policy label that tells clients how the environment is
 * expected to be accessed, not a transport detail and not an exhaustive list
 * of every accepted credential.
 *
 * Typical usage:
 * - rendered in auth/pairing UI so the user understands what kind of
 *   environment they are connecting to
 * - used by clients to decide whether silent desktop bootstrap is expected or
 *   whether an explicit pairing flow should be shown
 *
 * Meanings:
 * - `desktop-managed-local`: local desktop-managed environment with narrow
 *   trusted bootstrap, intended to avoid login prompts on the same machine
 * - `loopback-browser`: standalone local server intended for browser pairing on
 *   the same machine
 * - `remote-reachable`: environment intended to be reached from other devices
 *   or networks, where explicit pairing/auth is expected
 * - `unsafe-no-auth`: intentionally unauthenticated mode; this is an explicit
 *   unsafe escape hatch, not a normal deployment mode
 */
export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

/**
 * A credential type that can be exchanged for a real authenticated session.
 *
 * Bootstrap methods are for establishing trust at the start of a connection or
 * pairing flow. They are not the long-lived credential used for ordinary
 * authenticated HTTP / WebSocket traffic after pairing succeeds.
 *
 * Current methods:
 * - `desktop-bootstrap`: a trusted local desktop handoff, used so the desktop
 *   shell can pair the renderer without a login screen
 * - `one-time-token`: a short-lived pairing token, suitable for manual pairing
 *   flows such as `/pair?token=...`
 */
export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

/**
 * A credential type accepted for steady-state authenticated requests after a
 * client has already paired.
 *
 * These methods are used by the server-wide auth layer for privileged HTTP and
 * WebSocket access. They are distinct from bootstrap methods so clients can
 * reason clearly about "pair first, then use session auth".
 *
 * Current methods:
 * - `browser-session-cookie`: cookie-backed browser session, used by the web
 *   app after bootstrap/pairing
 * - `bearer-session-token`: token-based session suitable for non-cookie or
 *   non-browser clients
 */
export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-session-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthSessionRole = Schema.Literals(["owner", "client"]);
export type AuthSessionRole = typeof AuthSessionRole.Type;

export const SupabasePublicAuthConfig = Schema.Struct({
  projectUrl: TrimmedNonEmptyString,
  anonKey: TrimmedNonEmptyString,
  audience: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SupabasePublicAuthConfig = typeof SupabasePublicAuthConfig.Type;

export const LocalPasswordAuthConfig = Schema.Struct({
  enabled: Schema.Literal(true),
});
export type LocalPasswordAuthConfig = typeof LocalPasswordAuthConfig.Type;

/**
 * Server-advertised auth capabilities for a specific execution environment.
 *
 * Clients should treat this as the authoritative description of how that
 * environment expects to be paired and how authenticated requests should be
 * made afterward.
 *
 * Field meanings:
 * - `policy`: high-level auth posture for the environment
 * - `bootstrapMethods`: pairing/bootstrap methods the server is currently
 *   willing to accept
 * - `sessionMethods`: authenticated request/session methods the server supports
 *   once pairing is complete
 * - `sessionCookieName`: cookie name clients should expect when
 *   `browser-session-cookie` is in use
 * - `workspaceSource`: where the work actually happens once you are signed in
 *
 * This descriptor is intentionally capability-oriented. It lets clients choose
 * the right UX without embedding server-specific auth logic or assuming a
 * single access method.
 */
/**
 * Where a signed-in person's work runs.
 *
 * Signing in and having somewhere to work are two different things, and until
 * now they were the same thing by accident: every server hosted its own
 * projects, so a session implied a workspace. A server can instead exist to hold
 * accounts, environments, share links and packs while the projects live on the
 * machine in front of you — and a browser cannot tell those apart from the auth
 * posture, because both sign you in the same way.
 *
 * - `this-server`: projects live on the machine serving this page. A session is
 *   enough to start working.
 * - `paired-environment`: this server hosts no projects. A session gets you an
 *   account; work needs an environment of your own connected to it.
 */
export const WorkspaceSource = Schema.Literals(["this-server", "paired-environment"]);
export type WorkspaceSource = typeof WorkspaceSource.Type;

export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
  /**
   * Optional so that a server built before this field existed still parses. Its
   * absence means `this-server`, which is what every such server does.
   */
  workspaceSource: Schema.optionalKey(WorkspaceSource),
  supabase: Schema.optionalKey(SupabasePublicAuthConfig),
  localPassword: Schema.optionalKey(LocalPasswordAuthConfig),
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

/**
 * The single place that reads a descriptor's workspace source.
 *
 * Callers must not check `descriptor.workspaceSource` themselves: the field is
 * optional, and a `=== "paired-environment"` test spread across the codebase
 * quietly does the right thing while an `!== "this-server"` test quietly does
 * the wrong one against any server that predates the field.
 */
export function resolveWorkspaceSource(
  descriptor: Pick<ServerAuthDescriptor, "workspaceSource"> | undefined,
): WorkspaceSource {
  return descriptor?.workspaceSource ?? "this-server";
}

/**
 * What a machine connected to an account is *for*.
 *
 * `workspaceSource` above answers this question about a server. This answers it
 * about the machines an account has handed a credential to, and the two were
 * being conflated the same way: a connected machine was a connected machine,
 * whether it was the laptop somebody works on or a box that only ever runs
 * things. They want opposite treatment, and the difference is not cosmetic.
 *
 * - `workspace-host`: the agent works here. It holds projects, and because
 *   per-user provider credentials are enforced with no fallback, it is useless
 *   until the person has connected a Claude or Codex account.
 * - `runner`: the agent *drives* this box. It runs and serves things and holds
 *   ports, and no turn ever executes on it. Asking it for a provider account
 *   would be asking somebody to log into Claude again in order to connect a
 *   deploy target, which is exactly the friction this distinction removes.
 *
 * The role says nothing about what a credential can reach. It is a statement of
 * purpose used to decide what to *ask* for, never a permission boundary — a
 * runner's session is an ordinary session and `decideProviderAccount` still
 * refuses a turn that has no credential behind it.
 */
export const MachineRole = Schema.Literals(["workspace-host", "runner"]);
export type MachineRole = typeof MachineRole.Type;

/**
 * The single place that reads a machine's role.
 *
 * Callers must not test the field themselves, for the same reason they must not
 * test `workspaceSource`, and for one more: this value arrives from a nullable
 * database column and from JSON written by servers of other versions, so "not a
 * runner" and "some string this build has never heard of" both have to land
 * somewhere deliberate.
 *
 * They land on `workspace-host`, and the asymmetry is the point. Every machine
 * connected before this column existed is a workspace host, so absence has to
 * mean that or the feature rewrites history. And `runner` is the answer that
 * *skips* a prompt: a value this build cannot read must never be able to talk
 * the app out of asking for a provider account, so anything unrecognised falls
 * back to the role that asks. Written as `=== "runner"` rather than
 * `!== "workspace-host"` so that stays true when a third role is added.
 */
export function resolveMachineRole(
  machine: { readonly role?: string | null | undefined } | null | undefined,
): MachineRole {
  return machine?.role === "runner" ? "runner" : "workspace-host";
}

/**
 * What a workspace host is told once it is connected.
 *
 * Turns run on the person's own credential and nothing falls back to the box's
 * CLI login, so a workspace host with no provider account is a machine that
 * will refuse the first thing anybody asks it to do. Saying so at connect time
 * costs a sentence; not saying it costs a failed turn and a refusal message
 * read as a bug.
 */
export const WORKSPACE_HOST_PROVIDER_SETUP_PROMPT =
  "Turns run on your own Claude or Codex account. Connect one in Settings → Connections before you start work here.";

/**
 * What a runner is told instead, and why it is worth saying out loud.
 *
 * Silence would be ambiguous — a person who has just been asked for a provider
 * account on every other machine reads a missing prompt as a page that failed
 * to load. Naming the exemption turns it into the feature it is.
 */
export const RUNNER_PROVIDER_SETUP_EXEMPTION =
  "This machine only runs and serves what it is told to. No turn executes here, so it needs no Claude or Codex account of its own.";

/**
 * Whether a newly connected machine should lead a person into provider setup.
 *
 * The one statement of the rule, kept pure and kept here rather than in either
 * app, because the server decides it for a machine collecting a credential and
 * the browser decides it for the person who just approved one — and two copies
 * of "does a runner get asked" is exactly how a deploy box ends up demanding a
 * Claude login on one surface and not the other.
 *
 * It takes the machine, not the role, on purpose: a caller cannot reach an
 * answer without going through `resolveMachineRole`, which is the only thing
 * allowed to decide what an absent or unrecognised role means.
 *
 * This governs what the product *asks* for. It grants nothing and excuses
 * nothing: a turn dispatched from any machine still resolves a real per-user
 * credential or is refused, and that rule is enforced somewhere else entirely.
 */
export type ProviderSetupPrompt =
  | { readonly ask: true; readonly reason: "no-account-connected"; readonly message: string }
  | { readonly ask: false; readonly reason: "runner"; readonly message: string }
  | { readonly ask: false; readonly reason: "already-connected"; readonly message: null };

export function decideProviderSetupPrompt(input: {
  readonly machine: { readonly role?: string | null | undefined } | null | undefined;
  /** Whether the person connecting already has a provider account of their own. */
  readonly providerAccountConnected: boolean;
}): ProviderSetupPrompt {
  /**
   * The role is checked before the credential, and the order carries the whole
   * point of the distinction. A runner is exempt because of what it is, not
   * because of what its owner happens to have connected — so somebody who has
   * never touched Claude gets the same answer on a deploy box as somebody with
   * two subscriptions, and connecting a runner never turns into a login.
   */
  if (resolveMachineRole(input.machine) === "runner") {
    return { ask: false, reason: "runner", message: RUNNER_PROVIDER_SETUP_EXEMPTION };
  }
  if (input.providerAccountConnected) {
    return { ask: false, reason: "already-connected", message: null };
  }
  return {
    ask: true,
    reason: "no-account-connected",
    message: WORKSPACE_HOST_PROVIDER_SETUP_PROMPT,
  };
}

export const AuthBootstrapInput = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthBootstrapInput = typeof AuthBootstrapInput.Type;

export const AuthBootstrapResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBootstrapResult = typeof AuthBootstrapResult.Type;

export const AuthPasswordMode = Schema.Literals(["login", "signup"]);
export type AuthPasswordMode = typeof AuthPasswordMode.Type;

export const AuthPasswordInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  password: TrimmedNonEmptyString,
  mode: AuthPasswordMode,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthPasswordInput = typeof AuthPasswordInput.Type;

export const AuthBearerBootstrapResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: Schema.Literal("bearer-session-token"),
  expiresAt: Schema.DateTimeUtc,
  sessionToken: TrimmedNonEmptyString,
});
export type AuthBearerBootstrapResult = typeof AuthBearerBootstrapResult.Type;

export const AuthWebSocketTokenResult = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTokenResult = typeof AuthWebSocketTokenResult.Type;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  role: AuthSessionRole,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  role: AuthSessionRole,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthAccessStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = typeof AuthAccessStreamSnapshotEvent.Type;

export const AuthAccessStreamPairingLinkUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent =
  typeof AuthAccessStreamPairingLinkUpsertedEvent.Type;

export const AuthAccessStreamPairingLinkRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkRemoved"),
  payload: Schema.Struct({
    id: TrimmedNonEmptyString,
  }),
});
export type AuthAccessStreamPairingLinkRemovedEvent =
  typeof AuthAccessStreamPairingLinkRemovedEvent.Type;

export const AuthAccessStreamClientUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = typeof AuthAccessStreamClientUpsertedEvent.Type;

export const AuthAccessStreamClientRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientRemoved"),
  payload: Schema.Struct({
    sessionId: AuthSessionId,
  }),
});
export type AuthAccessStreamClientRemovedEvent = typeof AuthAccessStreamClientRemovedEvent.Type;

export const AuthAccessStreamEvent = Schema.Union([
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = typeof AuthAccessStreamEvent.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const AuthCreatePairingCredentialInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  role: Schema.optionalKey(AuthSessionRole),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  tenantStatus: Schema.optionalKey(Schema.Literals(["none", "pending-membership", "active"])),
  tenantSession: Schema.optionalKey(TenantSessionContext),
});
export type AuthSessionState = typeof AuthSessionState.Type;

/**
 * Uploaded avatars travel inline as `data:` URLs instead of going through blob
 * storage, so the caps have to be tight enough that a profile row and a profile
 * response stay cheap to move around.
 */
export const AUTH_AVATAR_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const AUTH_AVATAR_MAX_DECODED_BYTES = 256 * 1024;
export const AUTH_AVATAR_MAX_DIMENSION = 128;

export const AuthUserProfile = Schema.Struct({
  userId: UserId,
  subject: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  avatarInitials: TrimmedNonEmptyString,
  avatarDataUrl: Schema.optional(TrimmedNonEmptyString),
  role: AuthSessionRole,
  sessionId: AuthSessionId,
  sessionMethod: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  tenantStatus: Schema.Literals(["none", "pending-membership", "active"]),
  tenantSession: Schema.optionalKey(TenantSessionContext),
});
export type AuthUserProfile = typeof AuthUserProfile.Type;

/**
 * The update is a full replacement of the stored profile, so omitting
 * `avatarDataUrl` is how a user drops their uploaded image back to initials.
 */
export const AuthUpdateUserProfileInput = Schema.Struct({
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  avatarInitials: TrimmedNonEmptyString.check(Schema.isMaxLength(4)),
  avatarDataUrl: Schema.optional(Schema.String),
});
export type AuthUpdateUserProfileInput = typeof AuthUpdateUserProfileInput.Type;

export const AuthOnboardingStep = Schema.Literals([
  "paired",
  "accept-invite",
  "connect-provider",
  "create-workspace",
]);
export type AuthOnboardingStep = typeof AuthOnboardingStep.Type;

export const AuthOnboardingState = Schema.Struct({
  authenticated: Schema.Literal(true),
  profile: AuthUserProfile,
  nextStep: AuthOnboardingStep,
});
export type AuthOnboardingState = typeof AuthOnboardingState.Type;

/**
 * The one-time product-onboarding questionnaire shown after signup — distinct
 * from `AuthOnboardingStep` above, which tracks workspace/invite setup. This
 * only ever sets the *initial* default for the three settings below; every one
 * of them remains an independent toggle in Settings afterward regardless of
 * what (if anything) was answered here.
 */
export const OnboardingRole = Schema.Literals([
  "individual",
  "startup",
  "agency",
  "enterprise",
  "student",
]);
export type OnboardingRole = typeof OnboardingRole.Type;

export const OnboardingExperience = Schema.Literals(["new", "some", "experienced"]);
export type OnboardingExperience = typeof OnboardingExperience.Type;

export const OnboardingFocus = Schema.Literals(["backend", "frontend", "fullstack", "unsure"]);
export type OnboardingFocus = typeof OnboardingFocus.Type;

export const UserPreferences = Schema.Struct({
  onboardingCompleted: Schema.Boolean,
  onboardingRole: Schema.NullOr(OnboardingRole),
  onboardingExperience: Schema.NullOr(OnboardingExperience),
  onboardingFocus: Schema.NullOr(OnboardingFocus),
  orgSettingsVisible: Schema.Boolean,
  vibeModeEnabled: Schema.Boolean,
  apiUsageTabVisible: Schema.Boolean,
  /** Gates whether a new note/DM shows an interrupting toast; either way it still lands in the normal activity/inbox view. */
  notificationPopupsEnabled: Schema.Boolean,
});
export type UserPreferences = typeof UserPreferences.Type;

/**
 * Submitted once, whether the user answered every question or hit "Skip for
 * now" (skip is normalized by the caller to `null` fields before this reaches
 * the server, which then applies the same defaults as "Full-stack, some
 * experience, individual").
 */
export const CompleteOnboardingInput = Schema.Struct({
  role: Schema.NullOr(OnboardingRole),
  experience: Schema.NullOr(OnboardingExperience),
  focus: Schema.NullOr(OnboardingFocus),
});
export type CompleteOnboardingInput = typeof CompleteOnboardingInput.Type;

/**
 * Every field independently optional: each of the three settings can be
 * flipped on its own from Settings, with no relation to the other two or to
 * whatever onboarding originally set.
 */
export const UpdateUserPreferencesInput = Schema.Struct({
  orgSettingsVisible: Schema.optional(Schema.Boolean),
  vibeModeEnabled: Schema.optional(Schema.Boolean),
  apiUsageTabVisible: Schema.optional(Schema.Boolean),
  notificationPopupsEnabled: Schema.optional(Schema.Boolean),
});
export type UpdateUserPreferencesInput = typeof UpdateUserPreferencesInput.Type;
