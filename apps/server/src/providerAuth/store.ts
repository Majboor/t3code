import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where one person's provider credentials live, and nobody else's.
 *
 * The two providers keep credentials in different shapes, and only one of them
 * is per-person by default:
 *
 * - `codex login` writes `auth.json` into `CODEX_HOME`, which defaults to
 *   `~/.codex` — the home of whichever OS user the server runs as. On a shared
 *   box that is one ChatGPT account for everybody, which is exactly what was
 *   found in production: a single personal account answering for every T3 user.
 *   Pointing `CODEX_HOME` at a directory of this person's own is the whole fix.
 * - `claude setup-token` does not sign the machine in at all. It prints a token
 *   belonging to a person and expects it to be kept, so it is stored here and
 *   handed to the one process that needs it.
 *
 * Both therefore reduce to the same question — which directory belongs to this
 * user — and this module is the only place that answers it.
 *
 * One person may now hold several accounts per provider, so the question grew a
 * second half: *which* of their directories. Extra accounts get a directory of
 * their own under `<provider>/accounts/<accountId>/`, and a `<provider>/meta.json`
 * records their labels and which one answers when nobody names one.
 *
 * The first account a person connected has no such directory, and deliberately
 * never gets one. It is adopted under the id `"default"` and read from where it
 * has always been (`codex/auth.json`, `claude/oauth-token`). Adoption is a read,
 * never a move: enforcement upstream is no-fallback, so a credential that stops
 * resolving is not a degraded experience, it is a person who can no longer run a
 * turn at all. A rename that misses one file does that to them with no warning
 * and no way for them to fix it, so nothing here renames anything. New-layout
 * paths are still consulted first for `"default"`, which means a future move
 * could happen without touching this file — but until something does move them,
 * the legacy files stay exactly where the connect flow put them, and stay
 * authoritative.
 */

export type ProviderAuthProvider = "codex" | "claude";

/**
 * The id of the account somebody already had before accounts had ids.
 *
 * Every read that is not told otherwise means this one, which is what keeps a
 * user who connected months ago working without anybody touching their disk.
 */
export const DEFAULT_PROVIDER_ACCOUNT_ID = "default";

/** One connected-or-declared account, as the store knows it. */
export type StoredProviderAccount = {
  accountId: string;
  provider: ProviderAuthProvider;
  /** Always something honest; see `deriveAccountLabel` for where it comes from. */
  label: string;
  createdAt: string;
  isDefault: boolean;
  /**
   * Whether a credential is actually on disk for it. An account exists from the
   * moment it is created, but the CLI only writes the credential when the login
   * completes, and a logout takes the credential away again while leaving the
   * account and its label behind.
   */
  connected: boolean;
};

type ProviderAccountRecord = {
  id: string;
  label: string | null;
  createdAt: string;
};

type ProviderMetaFile = {
  defaultAccountId: string | null;
  accounts: ProviderAccountRecord[];
};

/**
 * A directory name that belongs to exactly one user id.
 *
 * User ids arrive as free text (`auth:` subjects, Supabase uuids, emails), so
 * they cannot be used as path segments as they stand: one could contain a
 * slash and read another user's directory. The readable half is a convenience
 * for anyone looking at the disk; the digest is what actually makes it unique
 * and traversal-proof, so a name that sanitises down to nothing is still safe.
 */
export function providerAuthUserSlug(userId: string): string {
  const readable = userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return readable.length > 0 ? `${readable}-${digest}` : digest;
}

/**
 * Account ids are path segments, so they get the same suspicion user ids get.
 *
 * Unlike a user id an account id cannot be hashed away — it is chosen here and
 * quoted back by clients, so the defence has to be a refusal rather than a
 * rewrite. Anything that is not a plain identifier is rejected outright, which
 * covers `..`, absolute paths, and every separator on both platforms at once.
 */
export function isSafeProviderAccountId(accountId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(accountId);
}

function requireSafeAccountId(accountId: string): string {
  if (!isSafeProviderAccountId(accountId)) {
    throw new Error(`Invalid provider account id: ${JSON.stringify(accountId)}`);
  }
  return accountId;
}

/** The root every user's directory hangs off, beside the rest of the state. */
export function providerAuthRoot(stateDir: string): string {
  return path.join(stateDir, "provider-auth");
}

export function providerAuthUserDir(stateDir: string, userId: string): string {
  return path.join(providerAuthRoot(stateDir), providerAuthUserSlug(userId));
}

function providerDir(stateDir: string, userId: string, provider: ProviderAuthProvider): string {
  return path.join(providerAuthUserDir(stateDir, userId), provider);
}

/** `auth.json` is Codex's own name for it; `oauth-token` is ours. */
function credentialFileName(provider: ProviderAuthProvider): string {
  return provider === "codex" ? "auth.json" : "oauth-token";
}

/**
 * Every place this account's credential could be, newest layout first.
 *
 * The last candidate is where a write goes, so `"default"` keeps writing to the
 * legacy path it has always used: a re-login by an existing user must not leave
 * two files that could disagree about who they are.
 */
function credentialCandidates(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId: string,
): string[] {
  requireSafeAccountId(accountId);
  const base = providerDir(stateDir, userId, provider);
  const file = credentialFileName(provider);
  const scoped = path.join(base, "accounts", accountId, file);
  return accountId === DEFAULT_PROVIDER_ACCOUNT_ID ? [scoped, path.join(base, file)] : [scoped];
}

/**
 * Where this account's credential is, or is about to be.
 *
 * Synchronous because `codexHomeFor` is, and `codexHomeFor` is what the connect
 * flow hands to a spawning CLI — an async answer there would mean the directory
 * a login writes into could differ from the one a read later looks in.
 */
function credentialPath(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId: string,
): string {
  const candidates = credentialCandidates(stateDir, userId, provider, accountId);
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!
  );
}

/** This user's `CODEX_HOME`, which is the whole of Codex's per-user isolation. */
export function codexHomeFor(
  stateDir: string,
  userId: string,
  accountId: string = DEFAULT_PROVIDER_ACCOUNT_ID,
): string {
  return path.dirname(credentialPath(stateDir, userId, "codex", accountId));
}

function claudeTokenPath(stateDir: string, userId: string, accountId: string): string {
  return credentialPath(stateDir, userId, "claude", accountId);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Creates this user's Codex home so the CLI writes there rather than `~`. */
export async function ensureCodexHome(
  stateDir: string,
  userId: string,
  accountId: string = DEFAULT_PROVIDER_ACCOUNT_ID,
): Promise<string> {
  const home = codexHomeFor(stateDir, userId, accountId);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

export async function isCodexConnected(
  stateDir: string,
  userId: string,
  accountId?: string,
): Promise<boolean> {
  const resolved = accountId ?? (await resolveDefaultProviderAccountId(stateDir, userId, "codex"));
  if (!isSafeProviderAccountId(resolved)) {
    return false;
  }
  return exists(path.join(codexHomeFor(stateDir, userId, resolved), "auth.json"));
}

/**
 * Kept at 0600 under a directory only this process can read.
 *
 * The token is a year long and is the account, so it is written the way a
 * private key is written rather than the way a cache is.
 */
export async function writeClaudeToken(
  stateDir: string,
  userId: string,
  token: string,
  accountId: string = DEFAULT_PROVIDER_ACCOUNT_ID,
): Promise<void> {
  const target = claudeTokenPath(stateDir, userId, accountId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, token, { encoding: "utf8", mode: 0o600 });
}

export async function readClaudeToken(
  stateDir: string,
  userId: string,
  accountId?: string,
): Promise<string | null> {
  const resolved = accountId ?? (await resolveDefaultProviderAccountId(stateDir, userId, "claude"));
  if (!isSafeProviderAccountId(resolved)) {
    return null;
  }
  try {
    const token = (await readFile(claudeTokenPath(stateDir, userId, resolved), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function isClaudeConnected(
  stateDir: string,
  userId: string,
  accountId?: string,
): Promise<boolean> {
  return (await readClaudeToken(stateDir, userId, accountId)) !== null;
}

export async function isProviderConnected(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId?: string,
): Promise<boolean> {
  if (accountId !== undefined && !isSafeProviderAccountId(accountId)) {
    return false;
  }
  return provider === "codex"
    ? isCodexConnected(stateDir, userId, accountId)
    : isClaudeConnected(stateDir, userId, accountId);
}

/**
 * Disconnect: the credential goes, the directory stays ready for the next one.
 *
 * Both candidate paths are removed, because "disconnected" has to mean nothing
 * resolves — leaving the legacy file behind while deleting the new one would
 * report a logout that did not happen. The account's meta entry survives so a
 * reconnect keeps the label the person chose.
 */
export async function clearProviderCredential(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId: string = DEFAULT_PROVIDER_ACCOUNT_ID,
): Promise<void> {
  for (const candidate of credentialCandidates(stateDir, userId, provider, accountId)) {
    await rm(candidate, { force: true });
  }
}

function metaPath(stateDir: string, userId: string, provider: ProviderAuthProvider): string {
  return path.join(providerDir(stateDir, userId, provider), "meta.json");
}

const EMPTY_META: ProviderMetaFile = { defaultAccountId: null, accounts: [] };

/**
 * Reads `meta.json`, treating anything unreadable as "no extra accounts".
 *
 * A corrupt or half-written meta file must never be able to take a credential
 * away: falling back to an empty one lands on `"default"`, which is the legacy
 * path, which is the credential every existing user already has.
 */
async function readMeta(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
): Promise<ProviderMetaFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metaPath(stateDir, userId, provider), "utf8"));
  } catch {
    return EMPTY_META;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_META;
  }
  const raw = parsed as { defaultAccountId?: unknown; accounts?: unknown };
  const accounts: ProviderAccountRecord[] = [];
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as { id?: unknown; label?: unknown; createdAt?: unknown };
    if (typeof record.id !== "string" || !isSafeProviderAccountId(record.id)) {
      continue;
    }
    accounts.push({
      id: record.id,
      label:
        typeof record.label === "string" && record.label.trim().length > 0 ? record.label : null,
      createdAt:
        typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    });
  }
  const defaultAccountId =
    typeof raw.defaultAccountId === "string" && isSafeProviderAccountId(raw.defaultAccountId)
      ? raw.defaultAccountId
      : null;
  return { defaultAccountId, accounts };
}

/**
 * Serialises read-modify-write on one meta file.
 *
 * Two connects can land at once — a person clicking twice, or two tabs — and
 * the losing write would silently drop an account that already has a credential
 * on disk, leaving a directory nothing can find.
 */
const metaMutations = new Map<string, Promise<unknown>>();

async function mutateMeta(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  mutate: (meta: ProviderMetaFile) => ProviderMetaFile,
): Promise<void> {
  const target = metaPath(stateDir, userId, provider);
  const previous = metaMutations.get(target) ?? Promise.resolve();
  const run = async (): Promise<void> => {
    const next = mutate(await readMeta(stateDir, userId, provider));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
  const settled = previous.then(run, run);
  const chain = settled.catch(() => undefined);
  metaMutations.set(target, chain);
  try {
    await settled;
  } finally {
    // Nothing queued behind this one, so the chain is finished rather than a
    // handle a long-lived server should keep holding per user per provider.
    if (metaMutations.get(target) === chain) {
      metaMutations.delete(target);
    }
  }
}

/**
 * The email `codex login` left in `auth.json`, if it is still there.
 *
 * It sits inside the id token rather than beside it, and both the field and the
 * token are the provider's to change, so every step here is allowed to fail —
 * an account with no derivable label is still an account somebody can pick.
 */
async function codexAccountEmail(credentialFile: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(credentialFile, "utf8")) as {
      email?: unknown;
      tokens?: { id_token?: unknown };
    };
    if (typeof raw.email === "string" && raw.email.length > 0) {
      return raw.email;
    }
    const idToken = raw.tokens?.id_token;
    if (typeof idToken !== "string") {
      return null;
    }
    const payload = idToken.split(".")[1];
    if (payload === undefined) {
      return null;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null;
  } catch {
    return null;
  }
}

function providerDisplayName(provider: ProviderAuthProvider): string {
  return provider === "codex" ? "Codex" : "Claude";
}

/**
 * A label somebody can tell two accounts apart by.
 *
 * `claude setup-token` returns the token and nothing else — no email, no name,
 * no id — so a Claude account has no identity of its own to show, and the only
 * honest fallback is its position in the list. Codex does carry an email, so it
 * is used when it can be read, but never at the cost of the listing itself.
 */
async function deriveAccountLabel(
  provider: ProviderAuthProvider,
  stored: string | null,
  credentialFile: string,
  connected: boolean,
  position: number,
): Promise<string> {
  if (stored !== null) {
    return stored;
  }
  if (provider === "codex" && connected) {
    const email = await codexAccountEmail(credentialFile);
    if (email !== null) {
      return email;
    }
  }
  return `${providerDisplayName(provider)} account ${position}`;
}

/** When the legacy account was connected, as far as the disk can say. */
async function credentialCreatedAt(credentialFile: string): Promise<string> {
  try {
    return (await stat(credentialFile)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

type AccountRow = {
  record: ProviderAccountRecord;
  /** Where its credential is, whether or not anything is there yet. */
  file: string;
  connected: boolean;
};

/**
 * Every account, adopted one first, without deriving a single label.
 *
 * Resolving which account a turn runs on happens on every turn, and it has no
 * use for labels — deriving them there would mean parsing a credential file to
 * answer a question about directories.
 */
async function accountRows(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  meta: ProviderMetaFile,
): Promise<AccountRow[]> {
  const ordered = meta.accounts.toSorted((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt < right.createdAt
        ? -1
        : 1,
  );

  const records: ProviderAccountRecord[] = [];
  const declaredDefault = ordered.find((entry) => entry.id === DEFAULT_PROVIDER_ACCOUNT_ID);
  const defaultFile = credentialPath(stateDir, userId, provider, DEFAULT_PROVIDER_ACCOUNT_ID);
  // The adopted account has no meta entry of its own; the credential on disk is
  // the only evidence it exists, which is why a listing has to look for it.
  if (declaredDefault !== undefined) {
    records.push(declaredDefault);
  } else if (existsSync(defaultFile)) {
    records.push({
      id: DEFAULT_PROVIDER_ACCOUNT_ID,
      label: null,
      createdAt: await credentialCreatedAt(defaultFile),
    });
  }
  for (const entry of ordered) {
    if (entry.id !== DEFAULT_PROVIDER_ACCOUNT_ID) {
      records.push(entry);
    }
  }

  const rows: AccountRow[] = [];
  for (const record of records) {
    const file = credentialPath(stateDir, userId, provider, record.id);
    rows.push({ record, file, connected: await exists(file) });
  }
  return rows;
}

async function accountsForProvider(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
): Promise<StoredProviderAccount[]> {
  const meta = await readMeta(stateDir, userId, provider);
  const rows = await accountRows(stateDir, userId, provider, meta);
  const defaultAccountId = pickDefaultAccountId(
    meta.defaultAccountId,
    rows.map((row) => ({ accountId: row.record.id, connected: row.connected })),
  );

  const listed: StoredProviderAccount[] = [];
  for (const [index, row] of rows.entries()) {
    listed.push({
      accountId: row.record.id,
      provider,
      label: await deriveAccountLabel(
        provider,
        row.record.label,
        row.file,
        row.connected,
        index + 1,
      ),
      createdAt: row.record.createdAt,
      isDefault: row.record.id === defaultAccountId,
      connected: row.connected,
    });
  }
  return listed;
}

/**
 * Which account answers when the caller did not name one.
 *
 * A stated default only holds while it is still connected: if a person logs the
 * account they nominated out, every turn they run would otherwise be refused
 * while a perfectly good second account sat beside it. Falling through to the
 * first connected account can only ever add availability, never remove it, and
 * with no accounts at all the answer is still `"default"` — the legacy path.
 */
function pickDefaultAccountId(
  stated: string | null,
  accounts: ReadonlyArray<{ accountId: string; connected: boolean }>,
): string {
  const nominated = accounts.find((account) => account.accountId === stated);
  if (nominated !== undefined && nominated.connected) {
    return nominated.accountId;
  }
  const connected = accounts.find((account) => account.connected);
  if (connected !== undefined) {
    return connected.accountId;
  }
  return stated ?? DEFAULT_PROVIDER_ACCOUNT_ID;
}

export async function resolveDefaultProviderAccountId(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
): Promise<string> {
  const meta = await readMeta(stateDir, userId, provider);
  // The common case by far is a user with only the adopted account: no meta file
  // was ever written for them, so there is nothing to weigh up.
  if (meta.accounts.length === 0 && meta.defaultAccountId === null) {
    return DEFAULT_PROVIDER_ACCOUNT_ID;
  }
  const rows = await accountRows(stateDir, userId, provider, meta);
  return pickDefaultAccountId(
    meta.defaultAccountId,
    rows.map((row) => ({ accountId: row.record.id, connected: row.connected })),
  );
}

/**
 * Every account this person holds, for one provider or both.
 *
 * Includes accounts that exist but are not connected — a picker has to be able
 * to show "you started this one and never finished it" rather than pretend it
 * was never created.
 */
export async function listProviderAccounts(
  stateDir: string,
  userId: string,
  provider?: ProviderAuthProvider,
): Promise<StoredProviderAccount[]> {
  const providers: ProviderAuthProvider[] = provider ? [provider] : ["codex", "claude"];
  const listed: StoredProviderAccount[] = [];
  for (const each of providers) {
    listed.push(...(await accountsForProvider(stateDir, userId, each)));
  }
  return listed;
}

/**
 * Reserves a second (or third) account and hands back the id to connect it under.
 *
 * The id is random rather than derived from anything the caller supplied,
 * because it becomes a directory name and because a Claude account has no
 * identity to derive it from anyway.
 */
export async function createProviderAccount(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  label?: string | null,
): Promise<string> {
  const accountId = randomBytes(8).toString("hex");
  const createdAt = new Date().toISOString();
  const trimmed = typeof label === "string" && label.trim().length > 0 ? label.trim() : null;
  const hasAdoptedDefault = existsSync(
    credentialPath(stateDir, userId, provider, DEFAULT_PROVIDER_ACCOUNT_ID),
  );

  await mutateMeta(stateDir, userId, provider, (meta) => ({
    // The very first account somebody creates for a provider they have never
    // connected should be the one their turns run on, or they would have to make
    // a second choice that has only one answer.
    defaultAccountId:
      meta.defaultAccountId ?? (hasAdoptedDefault || meta.accounts.length > 0 ? null : accountId),
    accounts: [...meta.accounts, { id: accountId, label: trimmed, createdAt }],
  }));
  await mkdir(path.dirname(credentialCandidates(stateDir, userId, provider, accountId)[0]!), {
    recursive: true,
    mode: 0o700,
  });
  return accountId;
}

/**
 * The adopted account has no meta entry until something needs to say a thing
 * about it, so naming it or nominating it writes one on the spot.
 */
function upsertRecord(
  meta: ProviderMetaFile,
  accountId: string,
  update: (record: ProviderAccountRecord) => ProviderAccountRecord,
): ProviderMetaFile {
  const existing = meta.accounts.find((entry) => entry.id === accountId);
  if (existing !== undefined) {
    return {
      ...meta,
      accounts: meta.accounts.map((entry) => (entry.id === accountId ? update(entry) : entry)),
    };
  }
  return {
    ...meta,
    accounts: [
      ...meta.accounts,
      update({ id: accountId, label: null, createdAt: new Date().toISOString() }),
    ],
  };
}

async function requireKnownAccount(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId: string,
): Promise<void> {
  requireSafeAccountId(accountId);
  if (accountId === DEFAULT_PROVIDER_ACCOUNT_ID) {
    return;
  }
  const meta = await readMeta(stateDir, userId, provider);
  if (meta.accounts.some((entry) => entry.id === accountId)) {
    return;
  }
  throw new Error(`Unknown ${provider} account: ${accountId}`);
}

export async function setProviderAccountLabel(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId: string,
  label: string | null,
): Promise<void> {
  await requireKnownAccount(stateDir, userId, provider, accountId);
  const trimmed = typeof label === "string" && label.trim().length > 0 ? label.trim() : null;
  await mutateMeta(stateDir, userId, provider, (meta) =>
    upsertRecord(meta, accountId, (record) => ({ ...record, label: trimmed })),
  );
}

/**
 * Nominates the account this person's own turns run on.
 *
 * Refuses an account that was never created, because a default pointing at
 * nothing is a refusal at the point a turn starts, far from the click that
 * caused it.
 */
export async function setDefaultProviderAccount(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
  accountId: string,
): Promise<void> {
  await requireKnownAccount(stateDir, userId, provider, accountId);
  await mutateMeta(stateDir, userId, provider, (meta) => ({
    ...upsertRecord(meta, accountId, (record) => record),
    defaultAccountId: accountId,
  }));
}

/**
 * The environment a provider process gets so it runs as this person.
 *
 * Returns null when the user has not connected that provider, and the caller is
 * expected to refuse rather than to fall back — falling back is what silently
 * lent one person's account to everybody.
 *
 * `HOME` is set alongside the credential because the caller strips the server's
 * own home out of the base environment, and a CLI with no home at all cannot
 * write the config and cache it expects to have. Pointing it here rather than
 * putting the original back keeps the rest of what these tools store — history,
 * sessions, settings — per user as well, for the same reason the credential is.
 */
export async function providerCredentialEnv(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
): Promise<Record<string, string> | null> {
  const accountId = await resolveDefaultProviderAccountId(stateDir, userId, provider);
  return providerCredentialEnvForAccount(stateDir, userId, provider, accountId);
}

/**
 * The same environment, for a named account belonging to a named owner.
 *
 * This is what a shared credential runs on, and everything in it stays the
 * owner's: the turn is billed to them and is logged by the provider as them, so
 * pointing `HOME` or `CODEX_HOME` at the person who typed the message would put
 * one account's session state under another account's history.
 */
export async function providerCredentialEnvForAccount(
  stateDir: string,
  ownerUserId: string,
  provider: ProviderAuthProvider,
  accountId: string = DEFAULT_PROVIDER_ACCOUNT_ID,
): Promise<Record<string, string> | null> {
  if (!isSafeProviderAccountId(accountId)) {
    return null;
  }
  const home = providerAuthUserDir(stateDir, ownerUserId);
  if (provider === "codex") {
    const codexHome = codexHomeFor(stateDir, ownerUserId, accountId);
    if (!(await exists(path.join(codexHome, "auth.json")))) {
      return null;
    }
    await mkdir(home, { recursive: true, mode: 0o700 });
    return { HOME: home, CODEX_HOME: codexHome };
  }
  const token = await readClaudeToken(stateDir, ownerUserId, accountId);
  if (token === null) {
    return null;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: token };
}
