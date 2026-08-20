/**
 * Deciding, per relay channel, whether the box or the browser path answers it.
 *
 * One outbound connection carries every kind of traffic a hub sends down, and
 * the two kinds that exist are not alike: a browser opens a channel and speaks
 * Effect RPC to this server's own `/ws`, and an agent opens a channel and speaks
 * `box/1` to the machine itself. The dialer opens exactly one local session per
 * channel and does not look at the bytes, so something has to.
 *
 * It is decided by the *first* payload and never revisited. A channel that began
 * as a box command cannot become a browser session halfway through, and one that
 * began as browser RPC cannot start issuing box commands — which matters, because
 * the second of those would be a way to reach the box verbs through a path that
 * was authenticated for something else.
 *
 * The loopback session is opened lazily, and that is the point rather than an
 * optimisation. A box command must not cost a websocket to `/ws`, a token mint
 * and an RPC handshake that nothing will ever use; and a machine configured as a
 * box with no browser path at all should still answer box commands rather than
 * failing to open a session it does not have.
 *
 * @module Box
 */

import type { RelayLocalSession, RelayLocalSessionFactory } from "../environmentRelay/dialer.ts";
import type { BoxResponder } from "./boxResponder.ts";

export interface BoxRelaySessionOptions {
  readonly respond: BoxResponder;
  /**
   * What serves a channel that is not a box command — in production, this
   * server's own `/ws` over loopback.
   *
   * Optional because a box is not a workspace: it holds no projects and runs no
   * turns, so a machine may legitimately have nothing for a browser to attach
   * to. When there is none, the channel is closed with a reason rather than left
   * open and mute, since a browser waiting forever on its first reply reads as
   * the app being broken.
   */
  readonly fallback?: RelayLocalSessionFactory | undefined;
  readonly onError?: ((message: string) => void) | undefined;
}

type ChannelMode = "undecided" | "box" | "delegate";

export function createBoxRelaySessionFactory(
  options: BoxRelaySessionOptions,
): RelayLocalSessionFactory {
  return async (handlers) => {
    let mode: ChannelMode = "undecided";
    let closed = false;
    let delegate: RelayLocalSession | null = null;
    let delegateOpening: Promise<RelayLocalSession | null> | null = null;
    /**
     * Everything on one channel runs in the order it arrived.
     *
     * Answering two requests concurrently would let the second reply overtake
     * the first, and the caller correlates by channel rather than by id — it
     * opens one channel per request precisely so that it does not have to — so
     * an overtaking reply is one command's output delivered as another's.
     */
    let queue: Promise<void> = Promise.resolve();

    const openDelegate = async (): Promise<RelayLocalSession | null> => {
      if (options.fallback === undefined) {
        handlers.onClose();
        return null;
      }
      try {
        const session = await options.fallback(handlers);
        if (closed) {
          session.close();
          return null;
        }
        delegate = session;
        return session;
      } catch (error) {
        options.onError?.(
          `Could not serve a relayed browser: ${error instanceof Error ? error.message : String(error)}`,
        );
        handlers.onClose();
        return null;
      }
    };

    const answerBox = async (payload: string): Promise<void> => {
      const reply = await options.respond(payload);
      if (closed || reply === null) {
        return;
      }
      handlers.onData(reply);
    };

    const handle = async (payload: string): Promise<void> => {
      if (closed) {
        return;
      }

      if (mode === "undecided") {
        // Cheap and total: the responder answers `null` for anything that is not
        // addressed to `box/1`, which is the same question asked once.
        const reply = await options.respond(payload);
        if (reply !== null) {
          mode = "box";
          if (!closed) {
            handlers.onData(reply);
          }
          return;
        }
        mode = "delegate";
      }

      if (mode === "box") {
        await answerBox(payload);
        return;
      }

      delegateOpening ??= openDelegate();
      const session = await delegateOpening;
      if (session !== null && !closed) {
        session.send(payload);
      }
    };

    return {
      send: (payload) => {
        queue = queue
          .then(() => handle(payload))
          .catch(() => {
            // `handle` answers its own failures; anything reaching here is a
            // defect in this file and must not poison the rest of the channel.
          });
      },
      close: () => {
        closed = true;
        delegate?.close();
        delegate = null;
      },
    };
  };
}
