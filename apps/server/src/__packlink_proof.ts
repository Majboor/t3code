/** Temporary: follows a printed pack link against a running server. Not shipped. */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WorkspaceId, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const origin = process.argv[2] ?? "http://127.0.0.1:3901";
const links = process.argv.slice(3);

const minted = await fetch(`${origin}/api/auth/session`);
const cookie = (minted.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
if (cookie === "") throw new Error("No session cookie issued.");

const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(`${origin.replace(/^http/, "ws")}/ws`).pipe(
      Layer.provide(
        Layer.succeed(
          Socket.WebSocketConstructor,
          (url, protocols) =>
            new NodeSocket.NodeWS.WebSocket(url, protocols, {
              headers: { cookie },
            }) as unknown as globalThis.WebSocket,
        ),
      ),
    ),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

const packIdOf = (link: string) =>
  decodeURIComponent(new URL(link).pathname.replace(/^\/pack\//, ""));

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  const organization = yield* client[WS_METHODS.organizationsCreate]({
    slug: `packlink-proof-${Date.now()}`,
    displayName: "Pack link proof",
  });
  const tenantId = organization.tenant.id;
  const workspaceId = WorkspaceId.make(`workspace-packlink-proof`);

  for (const link of links) {
    const packId = packIdOf(link);
    const outcome = yield* client[WS_METHODS.packsGet]({
      tenantId,
      workspaceId,
      packId,
      version: undefined,
    }).pipe(Effect.result);
    console.log(
      outcome._tag === "Success"
        ? `RESOLVED  ${link}\n          packId=${packId} -> ${outcome.success.pack.publisherHandle}/${outcome.success.manifest.identity.name}@${outcome.success.version.version}`
        : `404       ${link}\n          packId=${packId} -> ${JSON.stringify(outcome.failure)}`,
    );
  }
}).pipe(Effect.provide(protocol), Effect.scoped);

await Effect.runPromise(program as Effect.Effect<void, unknown, never>);
