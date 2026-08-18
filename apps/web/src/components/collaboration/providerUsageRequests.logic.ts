import type {
  ProviderAccountId,
  ProviderAuthKind,
  ProviderConnectedAccount,
  ProviderUsageError,
  ProviderUsageRequest,
  ProviderUsageRequestReason,
  ProviderWorkspaceAccount,
} from "@t3tools/contracts";

/**
 * The two readings of a request list.
 *
 * `listRequests` returns one flat array holding both what this person asked for
 * and what they could answer, and the interesting part of either is what is
 * *missing*: an open request has to hide the ask button, because the server
 * refuses a second one, and an empty array means "nobody needs you" or "you
 * cannot help" depending on `canRespond`. Both are decided here so the panel
 * cannot quietly invent a third rule.
 */

export type ProviderUsageErrorCode = ProviderUsageError["code"];

/**
 * `none` covers a withdrawn request too: taking it back is meant to leave no
 * trace, and a panel still reporting it would read as a refusal.
 */
export type ViewerUsageState = "none" | "pending" | "granted" | "declined";

export interface ViewerUsageRequest {
  readonly provider: ProviderAuthKind;
  /** The open request, else the last one that was answered. */
  readonly request: ProviderUsageRequest | null;
  readonly state: ViewerUsageState;
  /** False while a request is open — `createRequest` would be refused. */
  readonly canAsk: boolean;
  readonly hasOwnAccount: boolean;
  /**
   * They asked because they had nothing and have connected an account since.
   * The request is still live and still worth withdrawing, but they are no
   * longer blocked, and nothing else in the panel would tell them.
   */
  readonly askedThenConnected: boolean;
}

function newestFirst(left: ProviderUsageRequest, right: ProviderUsageRequest): number {
  return right.createdAt.localeCompare(left.createdAt);
}

export function readViewerUsage(input: {
  readonly requests: readonly ProviderUsageRequest[];
  readonly viewerUserId: string;
  readonly provider: ProviderAuthKind;
  readonly hasOwnAccount: boolean;
}): ViewerUsageRequest {
  const mine = input.requests.filter(
    (entry) => entry.provider === input.provider && entry.requesterUserId === input.viewerUserId,
  );

  const open = mine.filter((entry) => entry.status === "pending").toSorted(newestFirst)[0] ?? null;
  if (open) {
    return {
      provider: input.provider,
      request: open,
      state: "pending",
      canAsk: false,
      hasOwnAccount: input.hasOwnAccount,
      askedThenConnected: open.reason === "no-account" && input.hasOwnAccount,
    };
  }

  const answered =
    mine
      .filter((entry) => entry.status === "granted" || entry.status === "declined")
      .toSorted((left, right) =>
        (right.respondedAt ?? right.createdAt).localeCompare(left.respondedAt ?? left.createdAt),
      )[0] ?? null;

  return {
    provider: input.provider,
    request: answered,
    state: answered === null ? "none" : answered.status === "granted" ? "granted" : "declined",
    canAsk: true,
    hasOwnAccount: input.hasOwnAccount,
    askedThenConnected: false,
  };
}

export interface IncomingUsageRequest {
  readonly request: ProviderUsageRequest;
  /** The responder's own accounts for the provider being asked for. */
  readonly accounts: readonly ProviderConnectedAccount[];
  /**
   * False when the responder has nothing for that provider. The request is
   * still shown — vanishing would leave the asker waiting on silence — but
   * Grant would be refused with `not-a-contributor`, so only Decline is live.
   */
  readonly canGrant: boolean;
  /** What a grant contributes unless the responder picks another account. */
  readonly defaultAccountId: ProviderAccountId | null;
}

export function pickDefaultAccount(
  accounts: readonly ProviderConnectedAccount[],
): ProviderConnectedAccount | null {
  return accounts.find((account) => account.isDefault) ?? accounts[0] ?? null;
}

/**
 * Oldest first: whoever has been unable to run a turn the longest is the one
 * the responder should see at the top.
 */
export function readIncomingRequests(input: {
  readonly requests: readonly ProviderUsageRequest[];
  readonly viewerUserId: string;
  readonly viewerAccounts: readonly ProviderConnectedAccount[];
}): readonly IncomingUsageRequest[] {
  return input.requests
    .filter((entry) => entry.status === "pending" && entry.requesterUserId !== input.viewerUserId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((request) => {
      const accounts = input.viewerAccounts.filter(
        (account) => account.provider === request.provider,
      );
      return {
        request,
        accounts,
        canGrant: accounts.length > 0,
        defaultAccountId: pickDefaultAccount(accounts)?.accountId ?? null,
      };
    });
}

/**
 * Who the requester can expect an answer from.
 *
 * The roster is admin-only, so for most people this is empty and the panel
 * falls back to naming the workspace rather than a person.
 */
export function readPossibleResponders(input: {
  readonly workspaceAccounts: readonly ProviderWorkspaceAccount[];
  readonly provider: ProviderAuthKind;
  readonly viewerUserId: string;
}): readonly string[] {
  const names: string[] = [];
  for (const account of input.workspaceAccounts) {
    if (account.provider !== input.provider || account.userId === input.viewerUserId) {
      continue;
    }
    if (!names.includes(account.displayName)) {
      names.push(account.displayName);
    }
  }
  return names;
}

export function formatNames(names: readonly string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  }
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * The requester's stated reason, in the responder's terms.
 *
 * `no-account` and `limit-reached` are not degrees of the same thing: one
 * person cannot work at all, the other is out until their billing period
 * turns over, and lending is a different favour in each case.
 */
export function describeAskReason(
  reason: ProviderUsageRequestReason,
  providerLabel: string,
): string {
  switch (reason) {
    case "no-account":
      return `They have no ${providerLabel} account, so every turn they send is refused.`;
    case "limit-reached":
      return `Their own ${providerLabel} subscription has run out for now.`;
    case "asked":
      return `They can run ${providerLabel} turns already, and would rather use the workspace's.`;
  }
}

/** What the panel sends when someone presses Ask without saying more. */
export function defaultAskReason(hasOwnAccount: boolean): ProviderUsageRequestReason {
  return hasOwnAccount ? "asked" : "no-account";
}

export function readUsageErrorCode(error: unknown): ProviderUsageErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code: unknown }).code;
  switch (code) {
    case "forbidden":
    case "workspace-not-found":
    case "request-not-found":
    case "request-already-decided":
    case "request-already-pending":
    case "not-a-contributor":
    case "account-not-found":
      return code;
    default:
      return null;
  }
}

export interface UsageFailureNotice {
  /**
   * `info` for the outcomes that are somebody else's doing. Losing a race to
   * a colleague who answered first is news, not a mistake, and colouring it
   * red would tell the responder they had done something wrong.
   */
  readonly tone: "error" | "info";
  readonly title: string;
  readonly description: string;
}

export function describeUsageFailure(
  error: unknown,
  context: { readonly fallbackTitle: string; readonly providerLabel: string },
): UsageFailureNotice {
  const { providerLabel } = context;
  switch (readUsageErrorCode(error)) {
    case "request-already-decided":
      return {
        tone: "info",
        title: "Somebody answered first",
        description: "This request was already granted or declined by someone else.",
      };
    case "request-already-pending":
      return {
        tone: "info",
        title: "You have already asked",
        description: `Your ${providerLabel} request is still waiting for an answer.`,
      };
    case "request-not-found":
      return {
        tone: "info",
        title: "That request is gone",
        description: "It was withdrawn before anybody answered it.",
      };
    case "not-a-contributor":
      return {
        tone: "error",
        title: `No ${providerLabel} account to lend`,
        description: `Connect ${providerLabel} in Settings → Connections before granting.`,
      };
    case "account-not-found":
      return {
        tone: "error",
        title: "That account is no longer connected",
        description: `Reconnect it, or grant a different ${providerLabel} account.`,
      };
    case "forbidden":
      return {
        tone: "error",
        title: "You cannot do that here",
        description: "Only members of this workspace can ask for or lend an account.",
      };
    case "workspace-not-found":
      return {
        tone: "error",
        title: "This workspace is gone",
        description: "Reopen the project and try again.",
      };
    case null:
      return {
        tone: "error",
        title: context.fallbackTitle,
        description: error instanceof Error ? error.message : "The request failed.",
      };
  }
}
