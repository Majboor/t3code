import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";

const makeServerAuthPolicyLayer = (overrides?: Partial<ServerConfigShape>) =>
  ServerAuthPolicyLive.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfigShape;
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-policy-test-" })),
      ),
    ),
  );

it.layer(NodeServices.layer)("ServerAuthPolicyLive", (it) => {
  it.effect("uses desktop-managed-local policy for desktop mode", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("desktop-managed-local");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
      expect(descriptor.sessionCookieName).toBe("t3_session_3773");
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "desktop",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for desktop mode when bound beyond loopback", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "desktop",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses loopback-browser policy for loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("loopback-browser");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toBe("t3_session");
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "127.0.0.1",
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for wildcard web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for non-loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "192.168.1.50",
        }),
      ),
    ),
  );

  it.effect("uses unsafe-no-auth policy when explicitly enabled", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("unsafe-no-auth");
      expect(descriptor.bootstrapMethods).toEqual([]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "0.0.0.0",
          unsafeNoAuth: true,
        }),
      ),
    ),
  );

  it.effect("stops advertising loopback-browser once the server is published", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      // Loopback reach is no longer true, and the pairing method is what a visitor
      // now needs to be offered.
      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "127.0.0.1",
          publishedBeyondLoopback: true,
        }),
      ),
    ),
  );

  it.effect("stops advertising unsafe-no-auth once the server is published", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      // Without this the server would advertise no way in at all after refusing
      // to auto-issue.
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "127.0.0.1",
          unsafeNoAuth: true,
          publishedBeyondLoopback: true,
        }),
      ),
    ),
  );

  it.effect("leaves a published basic-auth server on its own policy", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      // Basic auth checks a password in front of every route, so publishing it
      // does not turn a loopback assumption into an open door.
      expect(descriptor.policy).toBe("unsafe-no-auth");
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "127.0.0.1",
          basicAuthUsername: "someone",
          basicAuthPassword: "a-password",
          publishedBeyondLoopback: true,
        }),
      ),
    ),
  );

  it.effect("leaves a desktop-managed server on its own policy when published", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      // Nothing to escalate: this policy never auto-issued in the first place.
      expect(descriptor.policy).toBe("desktop-managed-local");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "desktop",
          host: "127.0.0.1",
          publishedBeyondLoopback: true,
        }),
      ),
    ),
  );

  it.effect("advertises only public Supabase browser auth config", () =>
    Effect.gen(function* () {
      const policy = yield* ServerAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.supabase).toEqual({
        projectUrl: "https://project-ref.supabase.co/",
        anonKey: "anon-public-key",
        audience: "authenticated",
      });
      expect(JSON.stringify(descriptor)).not.toContain("service-role");
    }).pipe(
      Effect.provide(
        makeServerAuthPolicyLayer({
          mode: "web",
          host: "0.0.0.0",
          supabaseProjectUrl: new URL("https://project-ref.supabase.co"),
          supabaseAnonKey: "anon-public-key",
          supabaseJwtAudience: "authenticated",
          supabaseServiceRoleSecretName: "supabase/service-role",
        }),
      ),
    ),
  );
});
