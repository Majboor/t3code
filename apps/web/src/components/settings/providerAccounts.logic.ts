/**
 * Reading `/api/provider-auth/connections`, and the few decisions the panel
 * makes from it.
 *
 * Split out of the component because two of them are worth being sure about
 * without a browser in the way: which account a person's own turns actually run
 * on, and whether the one account currently being connected is live yet.
 */

export type ProviderName = "codex" | "claude";

export const PROVIDER_LABELS: Record<ProviderName, string> = { codex: "Codex", claude: "Claude" };

/** Labels and dates. The credential itself never leaves the server. */
export interface ProviderAccount {
  readonly accountId: string;
  readonly provider: ProviderName;
  readonly label: string;
  readonly createdAt: string;
  /** The account this person's own turns run on when nobody names one. */
  readonly isDefault: boolean;
  readonly connected: boolean;
}

export interface Connection {
  readonly provider: ProviderName;
  readonly label: string;
  /** Whether *any* account of this provider can run a turn. */
  readonly connected: boolean;
  readonly defaultAccountId: string | null;
  readonly accounts: readonly ProviderAccount[];
}

function isProviderName(value: unknown): value is ProviderName {
  return value === "codex" || value === "claude";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAccount(value: unknown, provider: ProviderName): ProviderAccount | null {
  const record = readRecord(value);
  const accountId = record === null ? null : readString(record, "accountId");
  if (record === null || accountId === null) {
    return null;
  }
  return {
    accountId,
    provider,
    // A Claude account has no identity of its own to fall back on, so the
    // server derives a positional name rather than leaving the row nameless.
    label: readString(record, "label") ?? accountId,
    createdAt: readString(record, "createdAt") ?? "",
    isDefault: record["isDefault"] === true,
    connected: record["connected"] === true,
  };
}

/**
 * The connections, defensively.
 *
 * The multi-account fields are newer than this page, and a web build that
 * reaches a server without them would otherwise render a connected provider as
 * having no accounts at all — which reads as "you are signed out" to somebody
 * who is not. One synthesised row keeps that deployment showing the truth.
 */
export function parseConnections(value: unknown): readonly Connection[] {
  const list = readRecord(value)?.["connections"];
  if (!Array.isArray(list)) {
    return [];
  }
  const connections: Connection[] = [];
  for (const entry of list) {
    const record = readRecord(entry);
    const provider = record?.["provider"];
    if (record === null || !isProviderName(provider)) {
      continue;
    }
    const label = readString(record, "label") ?? PROVIDER_LABELS[provider];
    const connected = record["connected"] === true;
    const raw = record["accounts"];
    const accounts = (Array.isArray(raw) ? raw : [])
      .map((account) => parseAccount(account, provider))
      .filter((account): account is ProviderAccount => account !== null);
    connections.push({
      provider,
      label,
      connected,
      defaultAccountId: readString(record, "defaultAccountId"),
      accounts:
        accounts.length > 0 || !connected
          ? accounts
          : [
              {
                accountId: "default",
                provider,
                label,
                createdAt: "",
                isDefault: true,
                connected: true,
              },
            ],
    });
  }
  return connections;
}

/**
 * Whether one named account is live — never whether the provider is.
 *
 * This is what a sign-in has to wait on. A second account is connected while
 * the first one still works, so the provider already reads as connected before
 * the browser window has even opened: watching that flag declares victory
 * instantly and tells somebody they are signed in to an account they have not
 * touched yet.
 */
export function accountConnected(
  connections: readonly Connection[],
  provider: ProviderName,
  accountId: string,
): boolean {
  const accounts = connections.find((entry) => entry.provider === provider)?.accounts ?? [];
  return accounts.find((account) => account.accountId === accountId)?.connected === true;
}

/**
 * The account this person's own turns run on, mirroring the server's own rule:
 * the nominated one while it still works, otherwise whichever does.
 */
export function defaultAccountOf(connection: Connection): ProviderAccount | null {
  const usable = connection.accounts.filter((account) => account.connected);
  return (
    usable.find((account) => account.accountId === connection.defaultAccountId) ??
    usable.find((account) => account.isDefault) ??
    usable[0] ??
    null
  );
}

/** What the next account would be called if the person names it nothing. */
export function suggestedAccountName(connection: Connection): string {
  return `${connection.label} account ${connection.accounts.length + 1}`;
}

const connectedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * When an account was connected, or nothing.
 *
 * An account adopted from the single-credential layout has no record of its
 * own, so the store dates it from the epoch when the file's own timestamp is
 * unreadable. "1 Jan 1970" is worse than saying nothing.
 */
export function formatConnectedAt(createdAt: string): string | null {
  const parsed = new Date(createdAt);
  const time = parsed.getTime();
  if (Number.isNaN(time) || time <= 0) {
    return null;
  }
  return connectedAtFormatter.format(parsed);
}
