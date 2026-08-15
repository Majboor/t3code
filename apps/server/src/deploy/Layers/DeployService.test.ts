import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import { ProjectId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { DeployRepositoryLive } from "../../persistence/Layers/DeployTargets.ts";
import { AnalyticsStoreLive } from "../../analytics/Layers/AnalyticsStore.ts";
import { AnalyticsRepositoryLive } from "../../persistence/Layers/Analytics.ts";
import { DeploymentRepositoryLive } from "../../persistence/Layers/Deployments.ts";
import { AnalyticsStore } from "../../analytics/Services/AnalyticsStore.ts";
import { DeployService } from "../Services/DeployService.ts";
import { DeploymentRegistry } from "../Services/DeploymentRegistry.ts";
import { DeploymentRegistryLive } from "./DeploymentRegistry.ts";
import {
  buildSshCommand,
  DeployServiceLive,
  planIngestKey,
  redactSecret,
} from "./DeployService.ts";

const TestLayer = DeployServiceLive.pipe(
  Layer.provide(DeployRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
  Layer.provide(ServerSecretStoreLive),
  // Merged rather than provided: the tests below read the stream and the
  // registry back to prove the deploy wrote to both.
  Layer.provideMerge(
    AnalyticsStoreLive.pipe(
      Layer.provide(AnalyticsRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
    ),
  ),
  Layer.provideMerge(
    DeploymentRegistryLive.pipe(
      Layer.provide(DeploymentRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provide(DeployRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provide(AnalyticsRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
    ),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-deploy-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-deploy-test");

describe("buildSshCommand", () => {
  it("runs plain ssh without a password and cds into the remote path", () => {
    const invocation = buildSshCommand({
      ssh: { host: "example.test", user: "deployer", remotePath: "/srv/app" },
      command: "make deploy",
      hasPassword: false,
    });

    expect(invocation.command).toBe("ssh");
    expect(invocation.args).toContain("deployer@example.test");
    expect(invocation.args.at(-1)).toBe('cd "/srv/app" && make deploy');
  });

  it("wraps ssh in sshpass when a password is available and never passes it as an argument", () => {
    const invocation = buildSshCommand({
      ssh: { host: "example.test", user: "deployer", port: 2222 },
      command: "systemctl restart app",
      hasPassword: true,
    });

    expect(invocation.command).toBe("sshpass");
    expect(invocation.args.slice(0, 3)).toEqual(["-e", "ssh", "-o"]);
    expect(invocation.args).toContain("2222");
    expect(invocation.args.join(" ")).not.toContain("password");
  });
});

describe("planIngestKey", () => {
  it("declares a stream nobody has declared yet", () => {
    expect(planIngestKey({ streamExists: false, otherReporters: [] })).toEqual({
      action: "declare",
    });
  });

  it("reissues for the deployment replacing itself", () => {
    expect(planIngestKey({ streamExists: true, otherReporters: [] })).toEqual({
      action: "reissue",
    });
  });

  it("refuses rather than cutting off another deployment already reporting", () => {
    // Reissuing is what makes a key obtainable at all, and it breaks whatever
    // held the old one. Doing that to somebody else's live deployment would take
    // their numbers away with nothing said.
    const plan = planIngestKey({ streamExists: true, otherReporters: ["prod"] });
    expect(plan.action).toBe("refuse");
    expect(plan.action === "refuse" ? plan.why : "").toContain("prod");
  });
});

describe("redactSecret", () => {
  it("takes the key back out of output that is about to be stored", () => {
    expect(redactSecret("running with KEY=abc123 set", "abc123")).toBe("running with KEY=*** set");
  });

  it("removes every occurrence, not just the first", () => {
    expect(redactSecret("abc123 then abc123", "abc123")).toBe("*** then ***");
  });

  it("leaves output alone when there is no secret to hide", () => {
    expect(redactSecret("nothing to hide", "")).toBe("nothing to hide");
  });
});

it.layer(TestLayer)("DeployService", (it) => {
  it.effect("records a successful command deploy and lists it in run history", () =>
    Effect.gen(function* () {
      const deploy = yield* DeployService;

      const target = yield* deploy.createTarget({
        projectId,
        name: "Echo",
        kind: "command",
        command: "echo deployed-ok",
      });
      expect(target.kind).toBe("command");

      const run = yield* deploy.run({
        targetId: target.id,
        actor: { label: "test" },
        workspaceRoot: process.cwd(),
      });

      expect(run.status).toBe("succeeded");
      expect(run.exitCode).toBe(0);
      expect(run.output).toContain("deployed-ok");
      expect(run.completedAt).not.toBeNull();

      const runs = yield* deploy.listRuns({ targetId: target.id });
      expect(runs.length).toBe(1);
      expect(runs[0]?.id).toBe(run.id);
    }),
  );

  it.effect("hands the deploy a working ingest key without ever writing it down", () =>
    Effect.gen(function* () {
      const deploy = yield* DeployService;
      const registry = yield* DeploymentRegistry;
      const analytics = yield* AnalyticsStore;

      // The command echoes the variable, which is the only way to prove from
      // outside that the key really reached the process — and it is also exactly
      // the accident redaction exists for.
      const target = yield* deploy.createTarget({
        projectId,
        name: "Staging",
        kind: "command",
        command: 'echo "ingest=$T3_ANALYTICS_INGEST_KEY"',
      });

      const run = yield* deploy.run({
        targetId: target.id,
        actor: { label: "test" },
        workspaceRoot: process.cwd(),
        analytics: {
          stream: "page.view" as never,
          purpose: "Which pages get read",
          properties: [],
          url: "https://staging.example.test",
        },
      });

      expect(run.status).toBe("succeeded");
      // It arrived — the variable expanded to something — and what it expanded
      // to is not in the stored row.
      expect(run.output).toContain("ingest=***");
      expect(run.output).not.toContain("ingest=\n");

      // The stream was declared as part of the deploy, and what went live is
      // recorded against it.
      const streams = yield* analytics.listStreams({ projectId });
      const declared = streams.streams.find((stream) => stream.name === "page.view");
      expect(declared).toBeDefined();

      const deployments = yield* registry.list({ projectId });
      const staging = deployments.find((deployment) => deployment.name === "Staging");
      expect(staging?.status).toBe("live");
      expect(staging?.url).toBe("https://staging.example.test");
      expect(staging?.lastRunId).toBe(run.id);
      expect(staging?.analyticsStreamIds).toContain(declared?.id);
    }),
  );

  it.effect("refuses to deploy when issuing the key would cut off another deployment", () =>
    Effect.gen(function* () {
      const deploy = yield* DeployService;
      const registry = yield* DeploymentRegistry;

      const target = yield* deploy.createTarget({
        projectId,
        name: "Shared",
        kind: "command",
        command: "echo ok",
      });

      // "prod" is already live and reporting to the stream.
      yield* deploy.run({
        targetId: target.id,
        actor: { label: "test" },
        workspaceRoot: process.cwd(),
        analytics: { stream: "shared.view" as never, deploymentName: "prod", properties: [] },
      });

      const error = yield* Effect.flip(
        deploy.run({
          targetId: target.id,
          actor: { label: "test" },
          workspaceRoot: process.cwd(),
          analytics: { stream: "shared.view" as never, deploymentName: "staging", properties: [] },
        }),
      );

      expect(error.code).toBe("analytics-conflict");
      expect(error.message).toContain("prod");

      // And prod is untouched — refusing has to mean nothing happened.
      const deployments = yield* registry.list({ projectId });
      expect(deployments.some((deployment) => deployment.name === "staging")).toBe(false);
    }),
  );

  it.effect("marks a failing command as a failed run without raising an error", () =>
    Effect.gen(function* () {
      const deploy = yield* DeployService;

      const target = yield* deploy.createTarget({
        projectId,
        name: "Failing",
        kind: "command",
        command: "exit 3",
      });
      const run = yield* deploy.run({
        targetId: target.id,
        actor: { label: "test" },
        workspaceRoot: process.cwd(),
      });

      expect(run.status).toBe("failed");
      expect(run.exitCode).toBe(3);
    }),
  );

  it.effect("rejects ssh targets without host configuration", () =>
    Effect.gen(function* () {
      const deploy = yield* DeployService;

      const result = yield* deploy
        .createTarget({
          projectId,
          name: "Broken",
          kind: "ssh",
          command: "true",
        })
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("invalid-target");
      }
    }),
  );

  it.effect("archives deleted targets so they disappear from listings and cannot run", () =>
    Effect.gen(function* () {
      const deploy = yield* DeployService;

      const target = yield* deploy.createTarget({
        projectId,
        name: "Temporary",
        kind: "command",
        command: "true",
      });
      yield* deploy.deleteTarget({ targetId: target.id });

      const targets = yield* deploy.listTargets({ projectId });
      expect(targets.some((candidate) => candidate.id === target.id)).toBe(false);

      const result = yield* deploy
        .run({
          targetId: target.id,
          actor: { label: "test" },
          workspaceRoot: process.cwd(),
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("target-not-found");
      }
    }),
  );
});
