import { Effect, Layer, Stream, Fiber } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WS_METHODS, WsRpcGroup } from "@t3tools/contracts";

const url = process.env["WS_URL"] ?? "ws://127.0.0.1:14773/ws";
const cwd = process.env["REPRO_CWD"]!;
const threadId = process.env["REPRO_THREAD"]!;

const protocolLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(url).pipe(
      Layer.provide(
        Layer.succeed(
          Socket.WebSocketConstructor,
          (socketUrl: string, protocols?: string | string[]) =>
            new NodeSocket.NodeWS.WebSocket(socketUrl, protocols, {
              headers: { cookie: process.env["REPRO_COOKIE"]! },
            }) as unknown as globalThis.WebSocket,
        ),
      ),
    ),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);

  const events: unknown[] = [];
  const fiber = yield* Effect.forkChild(
    client[WS_METHODS.subscribeTerminalEvents]({}).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.catchCause((cause) => Effect.sync(() => console.log("stream failed", cause))),
    ),
  );

  yield* Effect.sleep("300 millis");

  const opened = yield* client[WS_METHODS.terminalOpen]({
    threadId,
    terminalId: "default",
    cwd,
    cols: 80,
    rows: 24,
  }).pipe(Effect.result);
  console.log("OPEN:", JSON.stringify(opened, null, 0).slice(0, 600));

  yield* Effect.sleep("1500 millis");

  for (const data of ["e", "c", "\n"]) {
    const written = yield* client[WS_METHODS.terminalWrite]({
      threadId,
      terminalId: "default",
      data,
    }).pipe(Effect.result);
    console.log(
      "WRITE:",
      written._tag,
      written._tag === "Failure"
        ? `message=[${String((written as any).failure?.message)}] cause=${JSON.stringify((written as any).failure?.cause)}`
        : "",
    );
  }

  yield* Effect.sleep("1500 millis");
  console.log("TERMINAL EVENTS RECEIVED:", events.length, JSON.stringify(events).slice(0, 400));
  yield* Fiber.interrupt(fiber);
}).pipe(Effect.provide(protocolLayer), Effect.scoped);

Effect.runPromise(program as any).then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED", error);
    process.exit(1);
  },
);
