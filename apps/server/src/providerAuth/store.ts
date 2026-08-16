import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
 */

export type ProviderAuthProvider = "codex" | "claude";

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

/** The root every user's directory hangs off, beside the rest of the state. */
export function providerAuthRoot(stateDir: string): string {
  return path.join(stateDir, "provider-auth");
}

export function providerAuthUserDir(stateDir: string, userId: string): string {
  return path.join(providerAuthRoot(stateDir), providerAuthUserSlug(userId));
}

/** This user's `CODEX_HOME`, which is the whole of Codex's per-user isolation. */
export function codexHomeFor(stateDir: string, userId: string): string {
  return path.join(providerAuthUserDir(stateDir, userId), "codex");
}

/** Written by `codex login`; its presence is the only honest "connected". */
function codexCredentialPath(stateDir: string, userId: string): string {
  return path.join(codexHomeFor(stateDir, userId), "auth.json");
}

function claudeTokenPath(stateDir: string, userId: string): string {
  return path.join(providerAuthUserDir(stateDir, userId), "claude", "oauth-token");
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
export async function ensureCodexHome(stateDir: string, userId: string): Promise<string> {
  const home = codexHomeFor(stateDir, userId);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

export async function isCodexConnected(stateDir: string, userId: string): Promise<boolean> {
  return exists(codexCredentialPath(stateDir, userId));
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
): Promise<void> {
  const target = claudeTokenPath(stateDir, userId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, token, { encoding: "utf8", mode: 0o600 });
}

export async function readClaudeToken(stateDir: string, userId: string): Promise<string | null> {
  try {
    const token = (await readFile(claudeTokenPath(stateDir, userId), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function isClaudeConnected(stateDir: string, userId: string): Promise<boolean> {
  return (await readClaudeToken(stateDir, userId)) !== null;
}

export async function isProviderConnected(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
): Promise<boolean> {
  return provider === "codex"
    ? isCodexConnected(stateDir, userId)
    : isClaudeConnected(stateDir, userId);
}

/** Disconnect: the credential goes, the directory stays ready for the next one. */
export async function clearProviderCredential(
  stateDir: string,
  userId: string,
  provider: ProviderAuthProvider,
): Promise<void> {
  const target =
    provider === "codex"
      ? codexCredentialPath(stateDir, userId)
      : claudeTokenPath(stateDir, userId);
  await rm(target, { force: true });
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
  const home = providerAuthUserDir(stateDir, userId);
  if (provider === "codex") {
    if (!(await isCodexConnected(stateDir, userId))) {
      return null;
    }
    await mkdir(home, { recursive: true, mode: 0o700 });
    return { HOME: home, CODEX_HOME: codexHomeFor(stateDir, userId) };
  }
  const token = await readClaudeToken(stateDir, userId);
  if (token === null) {
    return null;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: token };
}
