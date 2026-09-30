import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";

import {
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY.ts";
import { makeTerminalManagerWithOptions } from "./Manager.ts";

/**
 * What a shell is allowed to inherit from the server it was opened on.
 *
 * A terminal is the one place in this product where a tenant member gets to run
 * arbitrary commands, and it used to be handed the server's whole environment
 * minus `T3CODE_*`, `VITE_*` and three Electron variables. On a hosted box that
 * environment is the operator's: one `env` printed their `OPENAI_API_KEY`, their
 * `ANTHROPIC_API_KEY` and their `CLAUDE_CODE_OAUTH_TOKEN` into the browser of
 * anybody who could open a terminal on any workspace they could reach, and into
 * the persisted scrollback log on disk beside it.
 *
 * The base environment here is supplied rather than taken from `process.env`,
 * so the test says exactly what the server was holding.
 */

class StubPtyProcess implements PtyProcess {
  readonly pid = 4242;

  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): () => void {
    return () => undefined;
  }
  onExit(_callback: (event: PtyExitEvent) => void): () => void {
    return () => undefined;
  }
}

class RecordingPtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    return Effect.succeed(new StubPtyProcess());
  }
}

/** The operator's own environment, as a published server really holds it. */
const OPERATOR_BASE_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  SHELL: "/bin/bash",
  HOME: "/home/operator",
  XDG_CONFIG_HOME: "/home/operator/.config",
  LANG: "en_US.UTF-8",
  OPENAI_API_KEY: "sk-operator-openai",
  ANTHROPIC_API_KEY: "sk-operator-anthropic",
  ANTHROPIC_AUTH_TOKEN: "operator-anthropic-auth",
  CLAUDE_CODE_OAUTH_TOKEN: "operator-claude-oauth",
  T3CODE_HUB_TOKEN: "operator-hub-token",
  CODEX_HOME: "/home/operator/.codex",
  CLAUDE_CONFIG_DIR: "/home/operator/.claude",
  PORT: "3773",
  VITE_DEV_SERVER_URL: "http://localhost:5173",
};

const spawnEnvFor = (runtimeEnv?: Record<string, string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-terminal-env-" });
    const ptyAdapter = new RecordingPtyAdapter();
    const manager = yield* makeTerminalManagerWithOptions({
      logsDir: path.join(baseDir, "logs"),
      ptyAdapter,
      env: OPERATOR_BASE_ENV,
      platform: "linux",
      shellResolver: () => "/bin/bash",
    });
    yield* manager.open({
      threadId: "thread-env-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: baseDir,
      cols: 100,
      rows: 24,
      ...(runtimeEnv ? { env: runtimeEnv } : {}),
    });
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    return spawnInput!.env;
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })("terminal spawn environment", (it) => {
  it.effect("keeps the operator's provider credentials out of a tenant's shell", () =>
    Effect.gen(function* () {
      const env = yield* spawnEnvFor();

      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.T3CODE_HUB_TOKEN).toBeUndefined();
      // The credential names are gone; the rules that were already there stay.
      expect(env.PORT).toBeUndefined();
      expect(env.VITE_DEV_SERVER_URL).toBeUndefined();
    }),
  );

  it.effect("keeps a shell usable: HOME and the ordinary environment survive", () =>
    Effect.gen(function* () {
      const env = yield* spawnEnvFor();

      // `HOME` is where the person's shell lives, not a credential, and a shell
      // can read any path whether or not a variable points at it. Stripping it
      // would break `cd`, `~` and every rc file for no gain.
      assert.equal(env.HOME, "/home/operator");
      assert.equal(env.XDG_CONFIG_HOME, "/home/operator/.config");
      assert.equal(env.PATH, "/usr/bin:/bin");
      assert.equal(env.LANG, "en_US.UTF-8");
    }),
  );

  it.effect("does not point a tenant's shell at the operator's provider home", () =>
    Effect.gen(function* () {
      const env = yield* spawnEnvFor();

      // Lending the operator's Codex/Claude login was removed from this product.
      // An inherited `CODEX_HOME`/`CLAUDE_CONFIG_DIR` would bring it back through
      // a shell: `codex` typed in any tenant's terminal would find the operator's
      // `auth.json` and run as them.
      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    }),
  );

  it.effect("still lets a caller put this person's own provider home back", () =>
    Effect.gen(function* () {
      const env = yield* spawnEnvFor({
        CODEX_HOME: "/state/provider-auth/user-a/codex",
        HOME: "/state/provider-auth/user-a",
      });

      // The provider-auth terminal resolves one account's directories and passes
      // them as the runtime environment. Stripping the inherited names must not
      // strip the replacements, or connecting a provider would stop working.
      assert.equal(env.CODEX_HOME, "/state/provider-auth/user-a/codex");
      assert.equal(env.HOME, "/state/provider-auth/user-a");
      expect(env.OPENAI_API_KEY).toBeUndefined();
    }),
  );
});
