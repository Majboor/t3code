/**
 * Websocket plumbing shared by every group of the SDK.
 *
 * Groups depend on {@link T3Transport} rather than on a live connection, so a
 * group can be exercised against a stub without standing up a server.
 *
 * @module transport
 */
import { WsRpcGroup } from "@t3tools/contracts";
import { Cause, Effect, Fiber, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const makeRpcClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeRpcClient;

export type T3RpcClient =
  RpcClientFactory extends Effect.Effect<infer Client, infer _E, infer _R> ? Client : never;

type RpcTag = keyof T3RpcClient & string;
type RpcMethod<TTag extends RpcTag> = T3RpcClient[TTag];

/** Payload a contract method accepts, taken from the contract itself. */
export type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

/** Value a request/response contract method resolves with. */
export type RpcSuccess<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? TSuccess
    : never;

/** Item a streaming contract method emits. */
export type RpcEvent<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? TEvent
    : never;

export interface T3SubscribeOptions {
  /** Called once if the subscription fails; the subscription is over by then. */
  readonly onError?: (error: Error) => void;
}

export interface T3Transport {
  /** Send one request and wait for its answer. */
  readonly request: <A>(
    execute: (client: T3RpcClient) => Effect.Effect<A, unknown, never>,
  ) => Promise<A>;
  /** Take the first item of a stream and let the stream close. */
  readonly first: <A>(
    execute: (client: T3RpcClient) => Stream.Stream<A, unknown, never>,
  ) => Promise<A>;
  /** Run a stream to completion, handing every item to `onEvent`. */
  readonly drain: <A>(
    execute: (client: T3RpcClient) => Stream.Stream<A, unknown, never>,
    onEvent: (event: A) => void,
  ) => Promise<void>;
  /** Watch a stream until the returned function is called. */
  readonly subscribe: <A>(
    execute: (client: T3RpcClient) => Stream.Stream<A, unknown, never>,
    onEvent: (event: A) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
}

/**
 * Contract errors already extend `Error` and carry their `_tag`, so they are
 * rethrown untouched; anything else is wrapped so callers only ever catch an
 * `Error`.
 */
export function toError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error(String((cause as { message?: string })?.message ?? cause));
}

export class T3Connection implements T3Transport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly client: T3RpcClient;

  private constructor(input: {
    readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    readonly clientScope: Scope.Closeable;
    readonly client: T3RpcClient;
  }) {
    this.runtime = input.runtime;
    this.clientScope = input.clientScope;
    this.client = input.client;
  }

  static async open(socketUrl: string): Promise<T3Connection> {
    const protocolLayer = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(socketUrl).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.WebSocketConstructor,
                (url, protocols) =>
                  new globalThis.WebSocket(url, protocols as string | string[] | undefined),
              ),
            ),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );
    const runtime = ManagedRuntime.make(protocolLayer);
    // The RPC client lives for the lifetime of the connection, so it gets its
    // own scope closed by close() rather than being scoped per call.
    const clientScope = runtime.runSync(Scope.make());
    const client = await runtime.runPromise(Scope.provide(clientScope)(makeRpcClient));
    return new T3Connection({ runtime, clientScope, client });
  }

  request = <A>(execute: (client: T3RpcClient) => Effect.Effect<A, unknown, never>): Promise<A> =>
    this.runtime.runPromise(
      Effect.suspend(() => execute(this.client)).pipe(Effect.mapError(toError)) as Effect.Effect<
        A,
        Error,
        never
      >,
    );

  first = <A>(execute: (client: T3RpcClient) => Stream.Stream<A, unknown, never>): Promise<A> =>
    this.request((client) =>
      Stream.runHead(execute(client)).pipe(
        Effect.flatMap((head) =>
          head._tag === "Some"
            ? Effect.succeed(head.value)
            : Effect.fail(new Error("Server closed the stream before sending anything.")),
        ),
      ),
    );

  drain = <A>(
    execute: (client: T3RpcClient) => Stream.Stream<A, unknown, never>,
    onEvent: (event: A) => void,
  ): Promise<void> =>
    this.request((client) =>
      Stream.runForEach(execute(client), (event) => Effect.sync(() => onEvent(event))),
    );

  subscribe = <A>(
    execute: (client: T3RpcClient) => Stream.Stream<A, unknown, never>,
    onEvent: (event: A) => void,
    options?: T3SubscribeOptions,
  ): (() => void) => {
    const fiber = this.runtime.runFork(
      Effect.suspend(() =>
        Stream.runForEach(execute(this.client), (event) => Effect.sync(() => onEvent(event))),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!Cause.hasInterruptsOnly(cause)) {
              options?.onError?.(toError(Cause.squash(cause)));
            }
          }),
        ),
      ),
    );
    return () => {
      void this.runtime.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
    };
  };

  async close(): Promise<void> {
    await this.runtime
      .runPromise(Scope.close(this.clientScope, Effect.void as never))
      .catch(() => undefined);
    await this.runtime.dispose();
  }
}
