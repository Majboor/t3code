import { describe, expect, it } from "vitest";

import type { RelayLocalSession, RelayLocalSessionFactory } from "../environmentRelay/dialer.ts";
import { encodeBoxRequest } from "./boxProtocol.ts";
import { createBoxRelaySessionFactory } from "./relaySession.ts";

const boxFrame = encodeBoxRequest({ method: "inspect", actorUserId: "user-1", params: {} });
const browserFrame = JSON.stringify({ _tag: "Request", id: 1 });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeFallback {
  readonly factory: RelayLocalSessionFactory;
  readonly opens: () => number;
  readonly sent: ReadonlyArray<string>;
  readonly closed: () => boolean;
  readonly push: (payload: string) => void;
}

const makeFallback = (): FakeFallback => {
  const sent: Array<string> = [];
  let opens = 0;
  let closed = false;
  let push: ((payload: string) => void) | null = null;

  const factory: RelayLocalSessionFactory = (handlers) => {
    opens += 1;
    push = handlers.onData;
    return Promise.resolve({
      send: (payload) => sent.push(payload),
      close: () => {
        closed = true;
      },
    } satisfies RelayLocalSession);
  };

  return {
    factory,
    opens: () => opens,
    sent,
    closed: () => closed,
    push: (payload) => push?.(payload),
  };
};

describe("createBoxRelaySessionFactory", () => {
  it("answers a box command without opening a browser session", async () => {
    const fallback = makeFallback();
    const replies: Array<string> = [];
    const session = await createBoxRelaySessionFactory({
      respond: (payload) => Promise.resolve(`answered:${payload.length}`),
      fallback: fallback.factory,
    })({ onData: (payload) => replies.push(payload), onClose: () => {} });

    session.send(boxFrame);
    await settle();

    expect(replies).toEqual([`answered:${boxFrame.length}`]);
    // The lazy open is the point rather than an optimisation: a box command must
    // not cost a websocket, a token mint and an RPC handshake nothing will use.
    expect(fallback.opens()).toBe(0);
  });

  it("hands anything else to the browser path, both ways", async () => {
    const fallback = makeFallback();
    const replies: Array<string> = [];
    const session = await createBoxRelaySessionFactory({
      respond: () => Promise.resolve(null),
      fallback: fallback.factory,
    })({ onData: (payload) => replies.push(payload), onClose: () => {} });

    session.send(browserFrame);
    await settle();
    fallback.push("reply-from-ws");

    expect(fallback.opens()).toBe(1);
    expect(fallback.sent).toEqual([browserFrame]);
    expect(replies).toEqual(["reply-from-ws"]);
  });

  /**
   * A channel that could change its mind would be a way to reach the box verbs
   * down a path that was opened, and authenticated, for something else.
   */
  it("keeps the decision made on the first payload", async () => {
    const fallback = makeFallback();
    const asked: Array<string> = [];
    const session = await createBoxRelaySessionFactory({
      respond: (payload) => {
        asked.push(payload);
        return Promise.resolve(payload === boxFrame ? "answer" : null);
      },
      fallback: fallback.factory,
    })({ onData: () => {}, onClose: () => {} });

    session.send(browserFrame);
    await settle();
    session.send(boxFrame);
    await settle();

    // The responder was consulted once, for the frame that decided the channel.
    expect(asked).toEqual([browserFrame]);
    expect(fallback.sent).toEqual([browserFrame, boxFrame]);
  });

  it("answers in the order the requests arrived", async () => {
    const replies: Array<string> = [];
    const delays = new Map<string, number>([
      ["a", 20],
      ["b", 0],
    ]);
    const session = await createBoxRelaySessionFactory({
      respond: (payload) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(`done:${payload}`), delays.get(payload) ?? 0),
        ),
    })({ onData: (payload) => replies.push(payload), onClose: () => {} });

    session.send("a");
    session.send("b");
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    expect(replies).toEqual(["done:a", "done:b"]);
  });

  it("closes a channel it cannot serve rather than leaving it open and mute", async () => {
    let closed = false;
    const session = await createBoxRelaySessionFactory({
      respond: () => Promise.resolve(null),
    })({ onData: () => {}, onClose: () => (closed = true) });

    session.send(browserFrame);
    await settle();

    expect(closed).toBe(true);
  });

  it("stops answering once the channel is closed", async () => {
    const replies: Array<string> = [];
    const session = await createBoxRelaySessionFactory({
      respond: (payload) =>
        new Promise((resolve) => setTimeout(() => resolve(`done:${payload}`), 10)),
    })({ onData: (payload) => replies.push(payload), onClose: () => {} });

    session.send(boxFrame);
    session.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(replies).toEqual([]);
  });

  it("closes the browser session it opened when the channel ends", async () => {
    const fallback = makeFallback();
    const session = await createBoxRelaySessionFactory({
      respond: () => Promise.resolve(null),
      fallback: fallback.factory,
    })({ onData: () => {}, onClose: () => {} });

    session.send(browserFrame);
    await settle();
    session.close();

    expect(fallback.closed()).toBe(true);
  });
});
