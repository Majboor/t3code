import type {
  ProviderUsageError,
  ProviderUsageRequestCreateInput,
  ProviderUsageRequestCreateResult,
  ProviderUsageRequestListInput,
  ProviderUsageRequestListResult,
  ProviderUsageRequestRespondInput,
  ProviderUsageRequestRespondResult,
  ProviderUsageRequestWithdrawInput,
  ProviderUsageRequestWithdrawResult,
  UserId,
} from "@t3tools/contracts";
import { Context, type Effect } from "effect";

/**
 * Whoever is asking or answering.
 *
 * Structurally the collaboration actor and the sharing actor, deliberately: a
 * request names a person to another person, and the roster is what turns an id
 * into a name both of them recognise. Nothing here comes from the wire — the
 * requester is the session, which is what stops anybody filing a request in a
 * colleague's name.
 */
export interface ProviderUsageActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
}

export interface ProviderUsageServiceShape {
  /**
   * The caller asks this workspace for usage of one provider. Asking again
   * while an earlier ask is still open re-states that one rather than adding a
   * second: the returned request may be older than this call.
   */
  readonly createRequest: (
    actor: ProviderUsageActor,
    input: ProviderUsageRequestCreateInput,
  ) => Effect.Effect<ProviderUsageRequestCreateResult, ProviderUsageError>;

  /**
   * The caller's own requests, plus the queue they can actually act on. The
   * two halves are one list because the panel draws them as one conversation.
   */
  readonly listRequests: (
    actor: ProviderUsageActor,
    input: ProviderUsageRequestListInput,
  ) => Effect.Effect<ProviderUsageRequestListResult, ProviderUsageError>;

  /**
   * Someone with a connected account grants or declines. A grant also lends
   * the account: see the layer for why that is two writes and not one.
   */
  readonly respondToRequest: (
    actor: ProviderUsageActor,
    input: ProviderUsageRequestRespondInput,
  ) => Effect.Effect<ProviderUsageRequestRespondResult, ProviderUsageError>;

  /** The requester takes their own ask back before anybody answered it. */
  readonly withdrawRequest: (
    actor: ProviderUsageActor,
    input: ProviderUsageRequestWithdrawInput,
  ) => Effect.Effect<ProviderUsageRequestWithdrawResult, ProviderUsageError>;
}

export class ProviderUsageService extends Context.Service<
  ProviderUsageService,
  ProviderUsageServiceShape
>()("t3/providerUsage/Services/ProviderUsageService") {}
