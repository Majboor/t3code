/**
 * Argument parsing, hand-rolled and total.
 *
 * The repo's server CLI is built on Effect's command framework, which owns its
 * own help text, usage errors and exit codes. This tool cannot let it: the
 * caller is an agent reading stdout, so every outcome — including a mistyped
 * flag — has to leave as one JSON object with an exit code chosen here. Parsing
 * is therefore a pure function over argv that returns a value, never throws and
 * never prints.
 *
 * @module args
 */
import { PackCliError } from "./errors.ts";

export interface GlobalOptions {
  /** Off by default: the primary consumer is a program, not a person. */
  readonly human: boolean;
  /** Registry root. A directory locally, or a project root on a server. */
  readonly registry: string | undefined;
  /** Base URL of a T3 server, when the registry lives in a workspace. */
  readonly server: string | undefined;
  readonly token: string | undefined;
}

export type ParsedCommand =
  | { readonly kind: "help"; readonly topic: string | undefined }
  | {
      readonly kind: "search";
      readonly query: string;
      readonly limit: number;
      readonly category: string | undefined;
      readonly tag: string | undefined;
    }
  | { readonly kind: "show"; readonly pack: string; readonly version: string | undefined }
  | {
      readonly kind: "init";
      readonly name: string;
      readonly directory: string | undefined;
      readonly publisher: string;
      readonly displayName: string | undefined;
      readonly summary: string | undefined;
      readonly does: string | undefined;
      readonly license: string;
      readonly target: string;
    }
  | { readonly kind: "validate"; readonly directory: string | undefined }
  | {
      readonly kind: "sign";
      readonly directory: string | undefined;
      /** Where the private key lives. Generated on first use if absent. */
      readonly key: string | undefined;
    }
  | {
      readonly kind: "publish";
      readonly directory: string | undefined;
      readonly dryRun: boolean;
    }
  | {
      readonly kind: "version";
      readonly directory: string | undefined;
      readonly set: string | undefined;
      readonly bump: "major" | "minor" | "patch" | undefined;
    };

export interface ParsedArgs {
  readonly command: ParsedCommand;
  readonly options: GlobalOptions;
}

export type ParseOutcome =
  | { readonly ok: true; readonly parsed: ParsedArgs }
  | { readonly ok: false; readonly error: PackCliError };

const COMMAND_NAMES = ["search", "show", "init", "validate", "sign", "publish", "version", "help"];

const BOOLEAN_FLAGS = new Set(["human", "dry-run", "help"]);

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

interface Tokens {
  readonly positional: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string>>;
}

function usage(message: string, detail?: Record<string, unknown>): PackCliError {
  return new PackCliError("usage", message, detail);
}

function tokenise(argv: ReadonlyArray<string>): Tokens | PackCliError {
  const positional: Array<string> = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h") {
      flags["help"] = "true";
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const body = argument.slice(2);
    if (body.length === 0) {
      return usage("`--` is not a flag.");
    }
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return usage(`--${body} needs a value.`, { flag: body });
    }
    flags[body] = value;
    index += 1;
  }

  return { positional, flags };
}

function readGlobals(flags: Readonly<Record<string, string>>): GlobalOptions {
  return {
    human: flags["human"] === "true",
    registry: flags["registry"],
    server: flags["server"],
    token: flags["token"],
  };
}

function readLimit(flags: Readonly<Record<string, string>>): number | PackCliError {
  const raw = flags["limit"];
  if (raw === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_LIMIT) {
    return usage(`--limit must be a whole number between 1 and ${MAX_SEARCH_LIMIT}.`, {
      limit: raw,
    });
  }
  return parsed;
}

function readBump(
  flags: Readonly<Record<string, string>>,
): "major" | "minor" | "patch" | undefined | PackCliError {
  const raw = flags["bump"];
  if (raw === undefined) {
    return undefined;
  }
  return raw === "major" || raw === "minor" || raw === "patch"
    ? raw
    : usage("--bump takes major, minor or patch.", { bump: raw });
}

function isError(value: unknown): value is PackCliError {
  return value instanceof PackCliError;
}

export function parseArgs(argv: ReadonlyArray<string>): ParseOutcome {
  const tokens = tokenise(argv);
  if (isError(tokens)) {
    return { ok: false, error: tokens };
  }

  const options = readGlobals(tokens.flags);
  const [name, ...rest] = tokens.positional;

  if (name === undefined || tokens.flags["help"] === "true" || name === "help") {
    return {
      ok: true,
      parsed: {
        command: { kind: "help", topic: name === "help" ? rest[0] : name },
        options,
      },
    };
  }

  if (!COMMAND_NAMES.includes(name)) {
    return {
      ok: false,
      error: usage(`Unknown command "${name}".`, { known: COMMAND_NAMES }),
    };
  }

  const flags = tokens.flags;

  switch (name) {
    case "search": {
      const query = rest.join(" ").trim();
      if (query.length === 0) {
        return { ok: false, error: usage("search needs a query describing the capability.") };
      }
      const limit = readLimit(flags);
      if (isError(limit)) {
        return { ok: false, error: limit };
      }
      return {
        ok: true,
        parsed: {
          command: {
            kind: "search",
            query,
            limit,
            category: flags["category"],
            tag: flags["tag"],
          },
          options,
        },
      };
    }

    case "show": {
      const pack = rest[0];
      if (pack === undefined) {
        return {
          ok: false,
          error: usage("show needs a pack, as `name`, `publisher/name` or `name@version`."),
        };
      }
      const marker = pack.lastIndexOf("@");
      const inlineVersion = marker > 0 ? pack.slice(marker + 1) : undefined;
      return {
        ok: true,
        parsed: {
          command: {
            kind: "show",
            pack: marker > 0 ? pack.slice(0, marker) : pack,
            version: flags["version"] ?? inlineVersion,
          },
          options,
        },
      };
    }

    case "init": {
      const packName = rest[0] ?? flags["name"];
      if (packName === undefined) {
        return { ok: false, error: usage("init needs a name for the pack.") };
      }
      return {
        ok: true,
        parsed: {
          command: {
            kind: "init",
            name: packName,
            directory: flags["dir"],
            publisher: flags["publisher"] ?? "local",
            displayName: flags["display-name"],
            summary: flags["summary"],
            does: flags["does"],
            license: flags["license"] ?? "UNLICENSED",
            target: flags["target"] ?? "node",
          },
          options,
        },
      };
    }

    case "validate":
      return {
        ok: true,
        parsed: { command: { kind: "validate", directory: flags["dir"] }, options },
      };

    case "sign":
      return {
        ok: true,
        parsed: {
          command: { kind: "sign", directory: flags["dir"], key: flags["key"] },
          options,
        },
      };

    case "publish":
      return {
        ok: true,
        parsed: {
          command: {
            kind: "publish",
            directory: flags["dir"],
            dryRun: flags["dry-run"] === "true",
          },
          options,
        },
      };

    case "version": {
      const bump = readBump(flags);
      if (isError(bump)) {
        return { ok: false, error: bump };
      }
      const set = flags["set"] ?? rest[0];
      if (set === undefined && bump === undefined) {
        return {
          ok: false,
          error: usage("version needs --set <semver> or --bump major|minor|patch."),
        };
      }
      if (set !== undefined && bump !== undefined) {
        return { ok: false, error: usage("version takes --set or --bump, not both.") };
      }
      return {
        ok: true,
        parsed: {
          command: { kind: "version", directory: flags["dir"], set, bump },
          options,
        },
      };
    }

    default:
      return { ok: false, error: usage(`Unknown command "${name}".`, { known: COMMAND_NAMES }) };
  }
}
