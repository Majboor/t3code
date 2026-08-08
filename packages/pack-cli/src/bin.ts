#!/usr/bin/env node
/**
 * The process boundary: argv in, one JSON object and an exit code out.
 *
 * Everything above this file is pure enough to test without a filesystem, a
 * clock or a server, so this module stays limited to wiring the real ones in.
 *
 * @module bin
 */
import { homedir } from "node:os";

import { parseArgs } from "./args.ts";
import { runCommand, type CommandContext } from "./commands.ts";
import { toPackCliError } from "./errors.ts";
import { renderFailure, renderSuccess } from "./output.ts";
import { makeDirectoryRegistry } from "./registry.ts";
import { makeNodePackStore, type PackStore } from "./store.ts";

const REGISTRY_DIRECTORY = "packs";

function defaultRegistryRoot(environment: Record<string, string | undefined>): string {
  const explicit = environment["T3CODE_PACK_REGISTRY"];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const home = environment["T3CODE_HOME"];
  return `${home !== undefined && home.length > 0 ? home : `${homedir()}/.t3code`}/${REGISTRY_DIRECTORY}`;
}

/**
 * Only reached when the caller asks for a server, so a local search never opens
 * a websocket. The import is dynamic for the same reason.
 */
async function connectRemoteStore(input: {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly cwd: string;
}): Promise<{ readonly store: PackStore; readonly close: () => Promise<void> }> {
  const { connect } = await import("@t3tools/sdk");
  const { makeSdkPackStore } = await import("./store-sdk.ts");
  const client = await connect({
    baseUrl: input.baseUrl,
    ...(input.token !== undefined ? { token: input.token } : {}),
  });
  return {
    store: makeSdkPackStore({ workspace: client.workspace, cwd: input.cwd }),
    close: () => client.close(),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    const rendered = renderFailure("(unparsed)", parsed.error, process.argv.includes("--human"));
    write(rendered.stdout, rendered.stderr);
    process.exitCode = rendered.exitCode;
    return;
  }

  const { command, options } = parsed.parsed;
  const root = options.registry ?? defaultRegistryRoot(process.env);
  const remote =
    options.server !== undefined
      ? await connectRemoteStore({
          baseUrl: options.server,
          token: options.token ?? process.env["T3CODE_AUTH_TOKEN"],
          cwd: root,
        })
      : undefined;
  const store = remote?.store ?? makeNodePackStore();

  const context: CommandContext = {
    store,
    // A remote store addresses everything relative to the project root it was
    // opened at, so its registry root is that root itself.
    registry: makeDirectoryRegistry(store, remote !== undefined ? "" : root),
    cwd: process.cwd(),
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
  };

  try {
    const outcome = await runCommand(command, context);
    const rendered = renderSuccess(command.kind, outcome, options.human);
    write(rendered.stdout, rendered.stderr);
    process.exitCode = rendered.exitCode;
  } catch (cause) {
    const rendered = renderFailure(command.kind, toPackCliError(cause), options.human);
    write(rendered.stdout, rendered.stderr);
    process.exitCode = rendered.exitCode;
  } finally {
    await remote?.close();
  }
}

function write(stdout: string | undefined, stderr: string | undefined): void {
  if (stdout !== undefined) {
    process.stdout.write(`${stdout}\n`);
  }
  if (stderr !== undefined) {
    process.stderr.write(`${stderr}\n`);
  }
}

await main();
