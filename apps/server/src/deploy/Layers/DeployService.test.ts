import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import { ProjectId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { DeployRepositoryLive } from "../../persistence/Layers/DeployTargets.ts";
import { DeployService } from "../Services/DeployService.ts";
import { buildSshCommand, DeployServiceLive } from "./DeployService.ts";

const TestLayer = DeployServiceLive.pipe(
  Layer.provide(DeployRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
  Layer.provide(ServerSecretStoreLive),
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
