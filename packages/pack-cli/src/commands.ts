/**
 * What each command does, with the world it touches passed in.
 *
 * Nothing here reads a clock, a filesystem or an environment variable directly,
 * so every command is exercisable end to end against a stub store — the same
 * arrangement the SDK's tests use against a stub transport.
 *
 * @module commands
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyManifest } from "@t3tools/shared/packSigning";
import {
  generateSigningKey,
  type PackSigningKeyPair,
  signManifest,
} from "@t3tools/shared/packSigningNode";

import type { ParsedCommand } from "./args.ts";
import { PackCliError } from "./errors.ts";
import {
  buildStarterManifest,
  DIRECTORY_SUFFIX,
  HANDOVER_FILENAME,
  MANIFEST_FILENAME,
  parseManifestJson,
  readCard,
  readDetail,
  readNameFromRaw,
  readReadinessFacts,
  readRef,
  readVersionFromRaw,
  setManifestVersion,
  setManifestVisibilityPrivate,
  type PackCardView,
  type PackManifest,
  type PackRefView,
  type PackIntegrationKnowledgeView,
} from "./manifest.ts";
import { assessReadiness, type ReadinessReport } from "./readiness.ts";
import type { PackRegistry } from "./registry.ts";
import type { PackStore } from "./store.ts";
import { suggestPack } from "./suggest.ts";

export interface CommandContext {
  readonly store: PackStore;
  readonly registry: PackRegistry;
  readonly cwd: string;
  readonly now: () => Date;
  readonly newId: (prefix: string) => string;
}

export interface CommandOutcome {
  readonly result: unknown;
  /** The same answer for a person, built once so `--human` costs nothing extra. */
  readonly human: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ── Loading the pack in front of the caller ─────────────────────────────────

interface LocalPack {
  readonly directory: string;
  readonly raw: unknown;
  readonly manifest: PackManifest;
  readonly card: PackCardView;
  readonly ref: PackRefView;
  readonly source: string;
}

async function resolvePackDirectory(
  context: CommandContext,
  directory: string | undefined,
): Promise<string> {
  const base = context.store.resolve(directory ?? context.cwd);
  if ((await context.store.read(context.store.resolve(base, MANIFEST_FILENAME))) !== undefined) {
    return base;
  }
  // After `init` the caller is usually one level up from the pack it just made.
  const children = (await context.store.list(base)).filter(
    (entry) => entry.kind === "directory" && entry.name.endsWith(DIRECTORY_SUFFIX),
  );
  const only = children.length === 1 ? children[0] : undefined;
  if (only !== undefined) {
    return context.store.resolve(base, only.name);
  }
  throw new PackCliError(
    "manifest-not-found",
    `No ${MANIFEST_FILENAME} in ${base}${
      children.length > 1 ? `, and ${children.length} pack directories under it` : ""
    }.`,
    {
      directory: base,
      ...(children.length > 1 ? { candidates: children.map((c) => c.name) } : {}),
    },
  );
}

async function loadLocalPack(
  context: CommandContext,
  directory: string | undefined,
): Promise<LocalPack> {
  const resolved = await resolvePackDirectory(context, directory);
  const source = await context.store.read(context.store.resolve(resolved, MANIFEST_FILENAME));
  if (source === undefined) {
    throw new PackCliError("manifest-not-found", `No ${MANIFEST_FILENAME} in ${resolved}.`, {
      directory: resolved,
    });
  }
  const read = parseManifestJson(source);
  if (!read.ok) {
    throw new PackCliError(read.reason, read.message, {
      directory: resolved,
      ...(read.formatVersion !== undefined ? { formatVersion: read.formatVersion } : {}),
    });
  }
  return {
    directory: resolved,
    raw: read.raw,
    manifest: read.manifest,
    card: readCard(read.manifest),
    ref: readRef(read.manifest),
    source,
  };
}

function reportFor(pack: LocalPack, now: Date): ReadinessReport {
  return assessReadiness({
    card: pack.card,
    facts: readReadinessFacts(pack.manifest),
    now,
  });
}

// ── Human rendering ─────────────────────────────────────────────────────────

function renderIssues(report: ReadinessReport): string {
  return report.issues
    .map(
      (issue) =>
        `  ${issue.severity === "error" ? "!" : "-"} ${issue.code} (${issue.path})\n    ${issue.message}`,
    )
    .join("\n");
}

function renderCard(card: PackCardView, suggestion: string, score?: number): string {
  const setup = [
    card.setup.environment.length > 0 ? `${card.setup.environment.length} env var(s)` : undefined,
    card.setup.accounts.length > 0 ? `${card.setup.accounts.length} account(s)` : undefined,
    card.setup.services.length > 0 ? `${card.setup.services.length} service(s)` : undefined,
    card.setup.manualSteps > 0 ? `${card.setup.manualSteps} manual step(s)` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [
    `${card.ref.qualified}${score !== undefined ? `  (score ${score})` : ""}`,
    `  ${card.does ?? card.summary ?? ""}`,
    `  setup: ${setup.length > 0 ? setup.join(", ") : "nothing to supply"}`,
    `  signals: ${card.signals.deploymentsSurviving ?? "?"} surviving / ${
      card.signals.deploymentsAttempted ?? "?"
    } deployed, ${card.signals.installsSucceeded ?? "?"}/${
      card.signals.installsAttempted ?? "?"
    } installs, ${card.knowledge.failureModes} failure mode(s), ${
      card.knowledge.integrationEntries
    } integration note(s)`,
    `  ${suggestion}`,
  ].join("\n");
}

// ── Commands ────────────────────────────────────────────────────────────────

const HELP = {
  tool: "t3-pack",
  purpose:
    "Find, inspect and publish packs. A pack carries the integration knowledge and production record that source code does not.",
  output:
    "One JSON object on stdout per invocation. `--human` swaps it for text. A non-zero exit always comes with an error object.",
  commands: [
    {
      name: "search",
      usage: "t3-pack search <query> [--limit n] [--category c] [--tag t]",
      summary:
        "Find packs by capability. Returns setup requirements and production signals so a decision needs no second call.",
    },
    {
      name: "show",
      usage: "t3-pack show <name|publisher/name>[@version] [--version v]",
      summary:
        "Full detail: integration knowledge, credential retrieval steps, known failure modes, permissions.",
    },
    {
      name: "init",
      usage: "t3-pack init <name> [--dir d] [--publisher p] [--summary s] [--does d]",
      summary: "Scaffold a new pack directory with an honest empty knowledge section.",
    },
    {
      name: "validate",
      usage: "t3-pack validate [--dir d]",
      summary:
        "Check a pack against the format and report what is missing before it could publish.",
    },
    {
      name: "publish",
      usage: "t3-pack publish [--dir d] [--dry-run]",
      summary: "Publish the current pack, always private. Listing it is a separate deliberate act.",
    },
    {
      name: "version",
      usage: "t3-pack version (--set <semver> | --bump major|minor|patch) [--dir d]",
      summary:
        "Record a new version: rewrite the manifest version and put that release in the registry.",
    },
  ],
  globalFlags: [
    { flag: "--human", summary: "Text instead of JSON." },
    { flag: "--registry <path>", summary: "Registry root. Defaults to the local pack registry." },
    { flag: "--server <url>", summary: "Reach the registry through a T3 server instead of disk." },
    { flag: "--token <token>", summary: "Bearer token for --server." },
  ],
  exitCodes: {
    "0": "success",
    "2": "usage",
    "3": "pack or manifest not found",
    "4": "manifest invalid or written for another format version",
    "5": "not publishable",
    "6": "version already exists",
    "7": "registry or io failure",
  },
  whenToPreferThis:
    "Before generating an integration with a third-party provider, webhooks, payments, auth or anything with credentials: search first. A pack that has run in production carries the failure modes and the credential steps that a fresh implementation gets wrong.",
} as const;

function helpOutcome(): CommandOutcome {
  return {
    result: HELP,
    human: [
      `${HELP.tool} — ${HELP.purpose}`,
      "",
      ...HELP.commands.map((command) => `  ${command.usage}\n    ${command.summary}`),
      "",
      ...HELP.globalFlags.map((flag) => `  ${flag.flag}  ${flag.summary}`),
    ].join("\n"),
  };
}

async function searchCommand(
  command: Extract<ParsedCommand, { kind: "search" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const now = context.now();
  const outcome = await context.registry.search({
    query: command.query,
    limit: command.limit,
    ...(command.category !== undefined ? { category: command.category } : {}),
    ...(command.tag !== undefined ? { tag: command.tag } : {}),
  });

  const results = outcome.hits.map((hit) => ({
    ...hit.record.card,
    score: hit.score,
    matched: hit.matched,
    suggestion: suggestPack(hit.record.card, now),
  }));

  return {
    result: {
      query: command.query,
      registry: context.registry.root,
      scanned: outcome.scanned,
      returned: results.length,
      ...(outcome.unreadable.length > 0 ? { unreadable: outcome.unreadable } : {}),
      results,
    },
    human:
      results.length === 0
        ? `No pack in ${context.registry.root} matches "${command.query}" (${outcome.scanned} scanned).`
        : results
            .map((result) => renderCard(result, result.suggestion.line, result.score))
            .join("\n\n"),
  };
}

/**
 * Split the `name@version` that `search` prints back into its parts.
 *
 * `search` prints `t3demo/ssh-deploy@1.3.0` and `show` took a bare name, so
 * copying the identifier straight out of the search results — the obvious thing
 * to do, and what an agent does — failed with "no pack". The lookup is
 * unchanged; this only accepts the shape this tool already hands out.
 *
 * Split on the last `@` so a publisher handle containing one survives, and only
 * when what follows looks like a version rather than part of a name.
 */
function splitPackIdentifier(identifier: string): {
  readonly name: string;
  readonly version: string | undefined;
} {
  const at = identifier.lastIndexOf("@");
  if (at <= 0) {
    return { name: identifier, version: undefined };
  }
  const candidate = identifier.slice(at + 1);
  return /^\d[\w.+-]*$/.test(candidate)
    ? { name: identifier.slice(0, at), version: candidate }
    : { name: identifier, version: undefined };
}

async function showCommand(
  command: Extract<ParsedCommand, { kind: "show" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const requested = splitPackIdentifier(command.pack);
  // An explicit `--version` still wins; the suffix is only a fallback for
  // whichever form the caller pasted in.
  const version = command.version ?? requested.version;
  const record = await context.registry.get({
    name: requested.name,
    ...(version !== undefined ? { version } : {}),
  });
  if (record === undefined) {
    throw new PackCliError(
      "pack-not-found",
      `No pack "${requested.name}${version !== undefined ? `@${version}` : ""}" in ${context.registry.root}.`,
      { pack: requested.name, registry: context.registry.root },
    );
  }
  const detail = readDetail(record.manifest);
  const suggestion = suggestPack(record.card, context.now());
  return {
    result: { ...detail, suggestion },
    human: [
      renderCard(detail, suggestion.line),
      "",
      ...suggestion.caveats.map((caveat) => `  caveat: ${caveat}`),
      "",
      "  integration knowledge:",
      ...detail.integrationKnowledge.flatMap((entry) => renderKnowledge(entry)),
      "  failure modes:",
      ...[...detail.handles, ...detail.openFailureModes].flatMap((entry) => [
        `    [${entry.severity ?? "?"}${entry.silent === true ? ", silent" : ""}] ${
          entry.symptom ?? entry.id ?? "unnamed"
        }`,
        // What was done about it. A symptom without its fix tells a reader
        // that something goes wrong and leaves them no better off.
        ...(entry.trigger !== undefined ? [`      cause: ${entry.trigger}`] : []),
        ...(entry.resolutionDetail !== undefined
          ? [`      fix: ${entry.resolutionDetail}`]
          : entry.resolution !== undefined
            ? [`      fix: ${entry.resolution}`]
            : []),
      ]),
      "",
      `  integration prompt: ${detail.integration.prompt ?? "(none)"}`,
    ].join("\n"),
  };
}

/**
 * One piece of integration knowledge, in full.
 *
 * This used to print the title alone. A reader — usually an agent — then saw
 * "A TUI has no web surface, so ask before inventing one" and never saw the
 * paragraph telling it to stop, offer a front end, and agree the shape first.
 * It was measured skipping that step while having run `show`, which looked
 * like the pack being ignored and was really the pack being withheld.
 *
 * The rule and the prompt are the pack. The title is only how you find it.
 */
function renderKnowledge(entry: PackIntegrationKnowledgeView): ReadonlyArray<string> {
  const lines = [`    ${entry.kind ?? "unknown"}: ${entry.title ?? entry.id ?? "untitled"}`];

  const say = (label: string, value: string | undefined) => {
    if (value === undefined || value.trim().length === 0) return;
    // Indented under its title, so a long rule stays attached to the thing it
    // is a rule about when several are printed together.
    const body = value.trim().split("\n").join("\n        ");
    lines.push(label.length > 0 ? `      ${label}: ${body}` : `      ${body}`);
  };

  say("", entry.rule);
  say("", entry.prompt);
  say("why", entry.rationale);
  say("e.g.", entry.example);
  say("models usually say", entry.commonMistake);
  return lines;
}

async function initCommand(
  command: Extract<ParsedCommand, { kind: "init" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const now = context.now().toISOString();
  const directory = context.store.resolve(
    command.directory ?? context.store.resolve(context.cwd, `${command.name}${DIRECTORY_SUFFIX}`),
  );
  const manifestPath = context.store.resolve(directory, MANIFEST_FILENAME);
  if ((await context.store.read(manifestPath)) !== undefined) {
    throw new PackCliError("usage", `${manifestPath} already exists.`, { directory });
  }

  const displayName = command.displayName ?? command.name;
  const manifest = buildStarterManifest({
    name: command.name,
    displayName,
    summary: command.summary ?? `${displayName} — say in one line what this pack is.`,
    does: command.does ?? `Describe, in one imperative sentence, what ${displayName} does.`,
    publisher: command.publisher,
    license: command.license,
    target: command.target,
    version: "0.1.0",
    packId: context.newId("pack"),
    workspaceKeyId: context.newId("wsk"),
    now,
  });

  await context.store.makeDirectory(directory);
  await context.store.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await context.store.write(
    context.store.resolve(directory, HANDOVER_FILENAME),
    [
      `# ${displayName}`,
      "",
      "What this does, what was tried, and what is left undone. The handover is",
      "required because a pack nobody can describe is a zip file with metadata.",
      "",
      "## What it does",
      "",
      "## What was tried and rejected",
      "",
      "## What is unfinished",
      "",
    ].join("\n"),
  );
  await context.store.write(
    context.store.resolve(directory, "README.md"),
    `# ${displayName}\n\n${command.summary ?? "One line about this pack."}\n`,
  );

  const pack = await loadLocalPack(context, directory);
  const report = reportFor(pack, context.now());
  return {
    result: {
      directory,
      files: [MANIFEST_FILENAME, HANDOVER_FILENAME, "README.md"],
      ref: pack.ref,
      readiness: report,
      nextSteps: [
        "Fill in capability.does, the handover summary and the integration prompt.",
        "Declare requirements.environment for every value the consumer must supply.",
        "Leave knowledge empty until production teaches it something; an empty knowledge section is an honest claim.",
        `Run \`t3-pack validate --dir ${directory}\` until it is publishable.`,
      ],
    },
    human: [
      `Scaffolded ${pack.ref.qualified} in ${directory}.`,
      renderIssues(report),
      `${report.errors} error(s), ${report.warnings} warning(s) before it could publish.`,
    ].join("\n"),
  };
}

async function validateCommand(
  command: Extract<ParsedCommand, { kind: "validate" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const pack = await loadLocalPack(context, command.directory);
  const report = reportFor(pack, context.now());
  const result = {
    directory: pack.directory,
    ref: pack.ref,
    formatVersion: pack.manifest.formatVersion,
    ...report,
  };
  if (!report.publishable) {
    throw new PackCliError(
      "not-publishable",
      `${pack.ref.qualified} has ${report.errors} error(s) blocking publication.`,
      result,
    );
  }
  return {
    result,
    human: [
      `${pack.ref.qualified} is publishable.`,
      renderIssues(report),
      `${report.warnings} warning(s).`,
    ].join("\n"),
  };
}

/**
 * Signs the manifest in place so a reader can check the release is what this
 * publisher put out. The key is generated on first use and kept outside the
 * pack directory — a private key inside a pack would be published with it.
 */
async function signCommand(
  command: Extract<ParsedCommand, { kind: "sign" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const pack = await loadLocalPack(context, command.directory);
  const keyPath = command.key ?? path.join(os.homedir(), ".t3code", "pack-signing-key.json");

  let key: PackSigningKeyPair;
  let created = false;
  try {
    key = JSON.parse(await fs.readFile(keyPath, "utf8")) as PackSigningKeyPair;
  } catch {
    key = generateSigningKey();
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, JSON.stringify(key, null, 2), { mode: 0o600 });
    created = true;
  }

  const manifest = pack.manifest as unknown as Record<string, unknown>;
  const signature = await signManifest(manifest, key, context.now().toISOString());
  const signed = { ...manifest, signature };
  await fs.writeFile(
    path.join(pack.directory, "pack.json"),
    `${JSON.stringify(signed, null, 2)}\n`,
    "utf8",
  );

  // Read it back and check, rather than trusting that writing it worked.
  const verified = await verifyManifest(
    JSON.parse(await fs.readFile(path.join(pack.directory, "pack.json"), "utf8")) as Record<
      string,
      unknown
    >,
  );

  // If this version is already published, the stored copy needs the signature
  // too, or the registry keeps serving something that reads as unsigned.
  const attached =
    pack.ref.version === undefined || pack.ref.publisher === undefined
      ? ({ attached: false, why: "this pack declares no version or publisher" } as const)
      : await context.registry.attachSignature({
          name: pack.ref.name,
          publisher: pack.ref.publisher,
          version: pack.ref.version,
          signature,
        });

  return {
    result: {
      ref: pack.ref,
      keyId: signature.keyId,
      keyPath,
      generatedKey: created,
      manifestSha256: signature.manifestSha256,
      verified: verified.state,
      registry: attached,
    },
    human: [
      `Signed ${pack.ref.qualified} with key ${signature.keyId}.`,
      created
        ? `Generated a new signing key at ${keyPath}. Keep it; losing it means a new identity.`
        : `Used the key at ${keyPath}.`,
      `Verifies: ${verified.state}.`,
      attached.attached
        ? "The published copy carries the signature too."
        : `Not attached to a published copy: ${attached.why}.`,
    ].join("\n"),
  };
}

async function publishCommand(
  command: Extract<ParsedCommand, { kind: "publish" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const pack = await loadLocalPack(context, command.directory);
  const report = reportFor(pack, context.now());
  if (!report.publishable) {
    throw new PackCliError(
      "not-publishable",
      `${pack.ref.qualified} has ${report.errors} error(s) blocking publication.`,
      { directory: pack.directory, ref: pack.ref, ...report },
    );
  }
  if (pack.ref.version === undefined) {
    throw new PackCliError("manifest-invalid", "This pack declares no version.", {
      directory: pack.directory,
    });
  }

  const forced = setManifestVisibilityPrivate(pack.raw);
  const manifestJson = `${JSON.stringify(forced.raw, null, 2)}\n`;
  const receipt = command.dryRun
    ? undefined
    : await context.registry.record({
        name: pack.ref.name,
        publisher: pack.ref.publisher,
        version: pack.ref.version,
        manifestJson,
      });

  return {
    result: {
      published: !command.dryRun,
      dryRun: command.dryRun,
      ref: pack.ref,
      registry: context.registry.root,
      ...(receipt !== undefined
        ? { directory: receipt.directory, release: receipt.versionPath }
        : {}),
      visibility: {
        scope: forced.scope,
        claimedInManifest: forced.claimedScope,
        note: "Published private. Making a pack visible to anyone else is a separate, deliberate act.",
      },
      warnings: report.warnings,
      issues: report.issues,
    },
    human: [
      command.dryRun
        ? `${pack.ref.qualified} would publish to ${context.registry.root}.`
        : `Published ${pack.ref.qualified} to ${context.registry.root}, private to its workspace.`,
      forced.claimedScope !== undefined && forced.claimedScope !== forced.scope
        ? `  visibility forced from "${forced.claimedScope}" to "${forced.scope}".`
        : "",
      renderIssues(report),
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  };
}

function nextVersion(current: string, bump: "major" | "minor" | "patch"): string {
  const [major = 0, minor = 0, patch = 0] =
    current
      .split("-")[0]
      ?.split(".")
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

async function versionCommand(
  command: Extract<ParsedCommand, { kind: "version" }>,
  context: CommandContext,
): Promise<CommandOutcome> {
  const pack = await loadLocalPack(context, command.directory);
  const current = readVersionFromRaw(pack.raw);
  if (current === undefined) {
    throw new PackCliError("manifest-invalid", "This pack declares no version to move from.", {
      directory: pack.directory,
    });
  }

  const target = command.set ?? nextVersion(current, command.bump ?? "patch");
  if (!SEMVER.test(target)) {
    throw new PackCliError("usage", `"${target}" is not a semver version.`, { version: target });
  }
  if (target === current) {
    throw new PackCliError(
      "version-exists",
      `${pack.ref.qualified} is already at ${current}. A change is always a new version.`,
      { version: current },
    );
  }

  const bumped = setManifestVersion(pack.raw, target);
  const forced = setManifestVisibilityPrivate(bumped);
  const manifestJson = `${JSON.stringify(forced.raw, null, 2)}\n`;
  const receipt = await context.registry.record({
    name: readNameFromRaw(bumped) ?? pack.ref.name,
    publisher: pack.ref.publisher,
    version: target,
    manifestJson,
  });
  await context.store.write(
    context.store.resolve(pack.directory, MANIFEST_FILENAME),
    `${JSON.stringify(bumped, null, 2)}\n`,
  );

  return {
    result: {
      ref: {
        ...pack.ref,
        version: target,
        qualified: `${pack.ref.qualified.split("@")[0]}@${target}`,
      },
      previousVersion: current,
      version: target,
      registry: context.registry.root,
      release: receipt.versionPath,
      note: "A version is a promise about behaviour. Earlier releases are untouched.",
    },
    human: `Recorded ${pack.ref.name} ${current} → ${target} in ${context.registry.root}.`,
  };
}

export function runCommand(
  command: ParsedCommand,
  context: CommandContext,
): Promise<CommandOutcome> {
  switch (command.kind) {
    case "help":
      return Promise.resolve(helpOutcome());
    case "search":
      return searchCommand(command, context);
    case "show":
      return showCommand(command, context);
    case "init":
      return initCommand(command, context);
    case "validate":
      return validateCommand(command, context);
    case "sign":
      return signCommand(command, context);
    case "publish":
      return publishCommand(command, context);
    case "version":
      return versionCommand(command, context);
  }
}
