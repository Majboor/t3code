/**
 * Which provider account answers for this person, in this workspace.
 *
 * Before sharing existed the answer was always "their own, or nothing", and it
 * lived inline in the reactor. Sharing turns it into a policy question with
 * four inputs that disagree — the account owner's willingness, an admin's
 * choice for the workspace, an admin's choice for this one person, and what
 * the person has connected themselves — so it is pulled out here, kept free of
 * IO, and tested on its own.
 *
 * Getting this wrong spends somebody else's money, and getting it wrong in the
 * other direction blocks every turn in the workspace: enforcement is
 * no-fallback, so a decision of "none" is a refusal, never a quiet default.
 */

export type ProviderAuthKind = "codex" | "claude";

/** What an admin has decided this one member runs on. */
export type ProviderAccessMode = "own" | "workspace";

/** What the workspace runs on when no member-level decision overrides it. */
export type ProviderPolicyMode = "own" | "shared";

export interface DecidableOwnAccount {
  readonly accountId: string;
  /** The one this person's own turns use when nothing else applies. */
  readonly isDefault: boolean;
}

export interface DecidableSharedAccount {
  readonly ownerUserId: string;
  readonly accountId: string;
  /** The owner's switch. False means they have withdrawn it. */
  readonly enabled: boolean;
  /**
   * Whether the credential is still on disk. An owner who disconnects an
   * account does not necessarily clear the share row, so a share can outlive
   * the thing it shares.
   */
  readonly connected: boolean;
}

export interface DecideProviderAccountInput {
  readonly provider: ProviderAuthKind;
  /** How the provider is named to a person — "Claude" or "Codex". */
  readonly providerLabel: string;
  readonly ownAccounts: readonly DecidableOwnAccount[];
  /** This member's grant, or null when nobody has decided for them. */
  readonly grant: { readonly access: ProviderAccessMode } | null;
  readonly policy: {
    readonly mode: ProviderPolicyMode;
    readonly sharedOwnerUserId: string | null;
    readonly sharedAccountId: string | null;
  } | null;
  readonly sharedAccounts: readonly DecidableSharedAccount[];
}

export type ProviderAccountDecision =
  | {
      readonly outcome: "account";
      readonly ownerUserId: string | null;
      readonly accountId: string;
      /** `own` runs on the acting user's credential; `workspace` on someone else's. */
      readonly source: "own" | "workspace";
    }
  | { readonly outcome: "refused"; readonly refusal: string };

/**
 * The default account, or the only one, or none.
 *
 * A user whose `meta.json` has lost its default pointer still has working
 * credentials on disk, and refusing them over a missing pointer would be a
 * lockout caused by bookkeeping. So the first account stands in.
 */
function pickOwnAccount(accounts: readonly DecidableOwnAccount[]): DecidableOwnAccount | null {
  return accounts.find((account) => account.isDefault) ?? accounts[0] ?? null;
}

/** Where a person goes to fix this themselves, named the same way every time. */
const CONNECT_YOUR_OWN = "Connect one in Settings → Connections";

/**
 * The other way out, for someone who has nothing to connect.
 *
 * Naming it in the refusal is the whole point: this text is read at the moment
 * a turn stops, by the one person who needs to know that asking is possible.
 * Telling them only to go and connect an account they may not have is a dead
 * end, and a dead end is what this used to be.
 */
const ASK_THE_WORKSPACE =
  "or open the collaboration panel and ask the workspace for usage";

export function decideProviderAccount(input: DecideProviderAccountInput): ProviderAccountDecision {
  const { providerLabel } = input;

  /**
   * The owner's switch is applied here, once, before anything else can consult
   * the list. Every later rule reads only what survives, so there is no path
   * through this function that can reach a withdrawn account — which is the
   * one guarantee a person lending their subscription is actually relying on.
   */
  const usableShared = input.sharedAccounts.filter(
    (account) => account.enabled && account.connected,
  );

  const own = pickOwnAccount(input.ownAccounts);

  /**
   * A grant is a decision about one person and beats the workspace default,
   * which is only a default. No grant and no policy means "own", which is the
   * behaviour that existed before sharing and stays the safe floor.
   */
  const access: ProviderAccessMode =
    input.grant?.access ?? (input.policy?.mode === "shared" ? "workspace" : "own");

  if (access === "workspace") {
    const named =
      input.policy?.sharedOwnerUserId != null && input.policy.sharedAccountId != null
        ? usableShared.find(
            (account) =>
              account.ownerUserId === input.policy?.sharedOwnerUserId &&
              account.accountId === input.policy?.sharedAccountId,
          )
        : undefined;

    if (named !== undefined) {
      return {
        outcome: "account",
        ownerUserId: named.ownerUserId,
        accountId: named.accountId,
        source: "workspace",
      };
    }

    /**
     * The workspace account has gone — withdrawn, disconnected, or never
     * chosen. Someone with their own credential should keep working rather
     * than be stopped by a decision that was meant to help them, so their own
     * account stands in. Deliberately not any other shared account: the admin
     * named one, and quietly billing a different colleague is worse than
     * refusing.
     */
    if (own !== null) {
      return { outcome: "account", ownerUserId: null, accountId: own.accountId, source: "own" };
    }

    const noneChosen =
      input.policy?.sharedOwnerUserId == null || input.policy.sharedAccountId == null;
    return {
      outcome: "refused",
      refusal: noneChosen
        ? `This workspace is set to run on a shared ${providerLabel} account, but no account has been chosen yet. ${CONNECT_YOUR_OWN}, or ask a workspace admin to pick one.`
        : `The ${providerLabel} account this workspace was running on is no longer shared. ${CONNECT_YOUR_OWN}, or ask a workspace admin to point the workspace at another.`,
    };
  }

  if (own !== null) {
    return { outcome: "account", ownerUserId: null, accountId: own.accountId, source: "own" };
  }

  /**
   * The floor, and the message most people will meet. It offers both routes on
   * purpose: before sharing existed the only advice was "connect your own",
   * and in a workspace that shares, that is now the wrong half of the answer.
   */
  return {
    outcome: "refused",
    refusal:
      usableShared.length > 0
        ? `No ${providerLabel} account is connected for you, and this workspace has not been set to let you use a shared one. ${CONNECT_YOUR_OWN}, ${ASK_THE_WORKSPACE}.`
        : `No ${providerLabel} account is connected for you. ${CONNECT_YOUR_OWN}, ${ASK_THE_WORKSPACE}.`,
  };
}
