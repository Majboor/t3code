#!/usr/bin/env node
/**
 * The process boundary: argv in, one JSON object and an exit code out.
 *
 * Everything above this file is pure enough to test without a filesystem, a
 * clock or a server, so this module stays limited to wiring the real ones in.
 *
 * @module bin
 */

import { parseArgs } from "./args.ts";
import { runCommand, type CommandContext } from "./commands.ts";
import { resolveRegistryRoot } from "./registryRoot.ts";
import { toPackCliError } from "./errors.ts";
import { renderFailure, renderSuccess } from "./output.ts";
import { makeDirectoryRegistry, type PackRegistry } from "./registry.ts";
import { makeNodePackStore } from "./store.ts";

/**
 * Only reached when the caller asks for a server, so a local search never opens
 * a websocket. The import is dynamic for the same reason.
 */
async function connectRemoteRegistry(input: {
  readonly baseUrl: string;
  readonly token: string | undefined;
}): Promise<{ readonly registry: PackRegistry; readonly close: () => Promise<void> }> {
  const { connect } = await import("@t3tools/sdk");
  const { makeSdkPackRegistry, resolveSdkPackScope } = await import("./store-sdk.ts");
  const client = await connect({
    baseUrl: input.baseUrl,
    ...(input.token !== undefined ? { token: input.token } : {}),
  });
  const scope = await resolveSdkPackScope({ client, label: input.baseUrl });
  return {
    registry: makeSdkPackRegistry(scope),
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
  const root = resolveRegistryRoot(options.registry);
  const remote =
    options.server !== undefined
      ? await connectRemoteRegistry({
          baseUrl: options.server,
          token: options.token ?? process.env["T3CODE_AUTH_TOKEN"],
        })
      : undefined;
  // The pack being worked on is always on local disk: `--server` says where a
  // release goes, not where the working copy lives.
  const store = makeNodePackStore();

  const context: CommandContext = {
    store,
    registry: remote?.registry ?? makeDirectoryRegistry(store, root),
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
