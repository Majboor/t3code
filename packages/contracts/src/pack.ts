/**
 * Pack format contracts.
 *
 * A pack is a workspace turned into something a stranger can install: the code,
 * the notes the agent wrote on its way out, and — the part that decides whether
 * it is reusable at all — a declaration of everything the consumer has to
 * supply before it will run.
 *
 * Every downstream surface reads this manifest: the CLI writes it, the
 * marketplace indexes and verifies it, pack mode searches it, and the deploy
 * dashboard charts what it declares. That makes the format the load-bearing
 * contract rather than one schema among many, so it carries a `formatVersion`
 * from its first release and prefers tagged unions over loose optional fields
 * wherever an illegal combination would otherwise be representable.
 *
 * See `docs/pack-format.md` for the prose specification and a worked example.
 *
 * @module pack
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  OrganizationId,
  PositiveInt,
  ProjectId,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";

// ── Format version ──────────────────────────────────────────────────────────

/**
 * Bumped only when a reader written against the previous version could
 * misinterpret a manifest. Consumers read this field before decoding anything
 * else so an unsupported pack fails with "too new" rather than a field error.
 */
export const PackFormatVersion = Schema.Literals(["1.0"]);
export type PackFormatVersion = typeof PackFormatVersion.Type;

export const PACK_FORMAT_VERSION = "1.0" satisfies PackFormatVersion;

/** File and directory names the rest of the ecosystem may hard-code. */
export const PACK_DIRECTORY_SUFFIX = ".pack";
export const PACK_MANIFEST_FILENAME = "pack.json";
export const PACK_HANDOVER_FILENAME = "handover.md";
export const PACK_ARCHIVE_SUFFIX = ".pack.tgz";

// ── Scalars ─────────────────────────────────────────────────────────────────

const PACK_NAME_MAX_LENGTH = 64;
const PACK_SUMMARY_MAX_LENGTH = 200;
const PACK_DESCRIPTION_MAX_LENGTH = 20_000;
const PACK_PURPOSE_MAX_LENGTH = 500;
const PACK_COMMAND_MAX_LENGTH = 4_000;
const PACK_RELATIVE_PATH_MAX_LENGTH = 512;
const PACK_INTEGRATION_PROMPT_MAX_LENGTH = 8_000;
const PACK_MAX_PORT = 65_535;

/**
 * A lowercase slug, used for every name a human types or a URL carries. The
 * single character case exists because short identifiers like `id` are common
 * inside operation and service names.
 */
export const PackSlug = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  Schema.isMaxLength(PACK_NAME_MAX_LENGTH),
);
export type PackSlug = typeof PackSlug.Type;

/** The name a person types. Unique per publisher, not globally. */
export const PackName = PackSlug;
export type PackName = typeof PackName.Type;

/** The publisher's public handle, the half of identity that appears in URLs. */
export const PackHandle = PackSlug;
export type PackHandle = typeof PackHandle.Type;

/**
 * Strict semantic version. Ranges are deliberately a separate type: a release
 * is always one exact point, and only dependencies get to be fuzzy.
 */
export const PackVersion = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  ),
);
export type PackVersion = typeof PackVersion.Type;

/** npm-style range syntax, resolved by the installer rather than the format. */
export const PackVersionRange = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PackVersionRange = typeof PackVersionRange.Type;

/**
 * Paths never escape the pack directory, so a reviewer can reason about the
 * file set without resolving anything and an extractor cannot be walked out of
 * its own root.
 */
export const PackRelativePath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@\-/]+$/),
  Schema.isMaxLength(PACK_RELATIVE_PATH_MAX_LENGTH),
);
export type PackRelativePath = typeof PackRelativePath.Type;

/** POSIX environment variable spelling, so shells and containers agree. */
export const PackEnvVarName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/),
  Schema.isMaxLength(128),
);
export type PackEnvVarName = typeof PackEnvVarName.Type;

/** Dotted lowercase, matching the shape of the product event catalog. */
export const PackEventName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  Schema.isMaxLength(128),
);
export type PackEventName = typeof PackEventName.Type;

/**
 * A host a pack talks to. A single leading `*.` wildcard is allowed because
 * real services span subdomains; a bare `*` is not, because a permission that
 * allows everything communicates nothing to a reviewer.
 */
export const PackHostPattern = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
  ),
  Schema.isMaxLength(253),
);
export type PackHostPattern = typeof PackHostPattern.Type;

export const PackPort = PositiveInt.check(Schema.isLessThanOrEqualTo(PACK_MAX_PORT));
export type PackPort = typeof PackPort.Type;

export const PackSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type PackSha256 = typeof PackSha256.Type;

export const PackBase64 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  Schema.isMaxLength(4_096),
);
export type PackBase64 = typeof PackBase64.Type;

const PackSummaryText = TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_SUMMARY_MAX_LENGTH));
const PackDescriptionText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PACK_DESCRIPTION_MAX_LENGTH),
);
const PackPurposeText = TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_PURPOSE_MAX_LENGTH));
const PackCommandText = TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_COMMAND_MAX_LENGTH));
const PackUrl = TrimmedNonEmptyString.check(
  Schema.isPattern(/^https:\/\/\S+$/),
  Schema.isMaxLength(2_048),
);

// ── Identifiers ─────────────────────────────────────────────────────────────

/**
 * Opaque and permanent. A pack may be renamed, retitled or transferred and this
 * never changes, which is what lets installs, analytics and verification
 * records survive all three.
 */
export const PackId = TrimmedNonEmptyString.pipe(Schema.brand("PackId"));
export type PackId = typeof PackId.Type;

/**
 * Names the publisher's signing keypair. The private half never leaves the
 * publisher; the public half is registered once with the marketplace so a
 * consumer can check a release really came from that account.
 */
export const PackSigningKeyId = TrimmedNonEmptyString.pipe(Schema.brand("PackSigningKeyId"));
export type PackSigningKeyId = typeof PackSigningKeyId.Type;

/**
 * A workspace's stable, non-reversible handle. It travels instead of the
 * workspace id so a public pack can prove two releases share an origin, and so
 * a workspace-private pack can be pinned to its home, without leaking tenancy.
 */
export const PackWorkspaceKeyId = TrimmedNonEmptyString.pipe(Schema.brand("PackWorkspaceKeyId"));
export type PackWorkspaceKeyId = typeof PackWorkspaceKeyId.Type;

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * A closed set, because facets only work for search if everyone picks from the
 * same list. Free-form discovery is what `tags` is for.
 */
export const PackCategory = Schema.Literals([
  "payments",
  "authentication",
  "messaging",
  "data",
  "storage",
  "analytics",
  "ai",
  "search",
  "media",
  "commerce",
  "devops",
  "integration",
  "ui",
  "workflow",
  "other",
]);
export type PackCategory = typeof PackCategory.Type;

export const PackTag = PackSlug;
export type PackTag = typeof PackTag.Type;

/**
 * An SPDX identifier, or one of the two escape hatches for code that is not
 * open source. Both escape hatches are spelled out rather than left as an
 * absent field so a consumer never has to guess what silence means.
 */
export const PackLicense = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PackLicense = typeof PackLicense.Type;

/**
 * Public identity. Internal ids are optional because a manifest that leaves the
 * installation must still be readable by a marketplace that has never heard of
 * this tenant.
 */
export const PackPublisher = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    handle: PackHandle,
    displayName: TrimmedNonEmptyString,
    userId: Schema.optional(UserId),
    signingKeyId: Schema.optional(PackSigningKeyId),
    publicKey: Schema.optional(PackBase64),
    contactUrl: Schema.optional(PackUrl),
  }),
  Schema.Struct({
    type: Schema.Literal("organization"),
    handle: PackHandle,
    displayName: TrimmedNonEmptyString,
    organizationId: Schema.optional(OrganizationId),
    signingKeyId: Schema.optional(PackSigningKeyId),
    publicKey: Schema.optional(PackBase64),
    contactUrl: Schema.optional(PackUrl),
  }),
]);
export type PackPublisher = typeof PackPublisher.Type;

export const PackIdentity = Schema.Struct({
  id: PackId,
  name: PackName,
  version: PackVersion,
  displayName: TrimmedNonEmptyString,
  /** One line. Search results and agent context windows both live off this. */
  summary: PackSummaryText,
  description: Schema.optional(PackDescriptionText),
  publisher: PackPublisher,
  license: PackLicense,
  categories: Schema.optional(Schema.Array(PackCategory)),
  tags: Schema.optional(Schema.Array(PackTag)),
  homepageUrl: Schema.optional(PackUrl),
  repositoryUrl: Schema.optional(PackUrl),
});
export type PackIdentity = typeof PackIdentity.Type;

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * The workspace a pack was cut from. `workspaceId` is optional so a public
 * release can drop it while the key id keeps the lineage intact.
 */
export const PackOriginWorkspace = Schema.Struct({
  workspaceKeyId: PackWorkspaceKeyId,
  workspaceId: Schema.optional(WorkspaceId),
  tenantId: Schema.optional(TenantId),
  projectId: Schema.optional(ProjectId),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type PackOriginWorkspace = typeof PackOriginWorkspace.Type;

/** Who cut the pack. Agents are first-class here because usually one did. */
export const PackAuthor = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    userId: Schema.optional(UserId),
    displayName: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    provider: TrimmedNonEmptyString,
    model: Schema.optional(TrimmedNonEmptyString),
    /** The person who asked for the extraction, so accountability survives. */
    onBehalfOfUserId: Schema.optional(UserId),
  }),
]);
export type PackAuthor = typeof PackAuthor.Type;

/** The commit the extraction was taken from, for auditing and for re-cutting. */
export const PackSourceRevision = Schema.Struct({
  repositoryUrl: Schema.optional(PackUrl),
  branch: Schema.optional(TrimmedNonEmptyString),
  commitSha: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{7,40}$/))),
  /** True when the working tree had uncommitted changes at extraction time. */
  dirty: Schema.optional(Schema.Boolean),
});
export type PackSourceRevision = typeof PackSourceRevision.Type;

/**
 * The notes the agent writes on the way out: what it built, what it tried, what
 * it left undone. Required, because a pack without a handover is a zip file.
 * The prose stays in a file and only a summary travels in the manifest, so
 * search and agent context stay cheap.
 */
export const PackHandover = Schema.Struct({
  path: PackRelativePath,
  summary: PackDescriptionText,
  generatedBy: Schema.optional(PackAuthor),
  generatedAt: Schema.optional(IsoDateTime),
});
export type PackHandover = typeof PackHandover.Type;

export const PackProvenance = Schema.Struct({
  workspace: PackOriginWorkspace,
  extractedAt: IsoDateTime,
  extractedBy: PackAuthor,
  handover: PackHandover,
  source: Schema.optional(PackSourceRevision),
  /** Set when this pack was forked from another, so credit survives a rename. */
  derivedFrom: Schema.optional(
    Schema.Struct({
      id: PackId,
      name: PackName,
      version: PackVersion,
      publisherHandle: PackHandle,
    }),
  ),
});
export type PackProvenance = typeof PackProvenance.Type;

// ── Reusability contract ────────────────────────────────────────────────────

/**
 * How data crosses the pack boundary. Kept coarse on purpose: the point is to
 * let an agent decide whether a pack fits before reading any code, not to
 * replace the interface definitions further down.
 */
export const PackPortKind = Schema.Literals([
  "http-request",
  "http-response",
  "function-call",
  "function-result",
  "event",
  "webhook",
  "cli-argument",
  "file",
  "stream",
]);
export type PackPortKind = typeof PackPortKind.Type;

export const PackDataPort = Schema.Struct({
  name: PackSlug,
  kind: PackPortKind,
  description: PackPurposeText,
  /** A JSON Schema inside the pack, when the shape is worth pinning down. */
  schemaPath: Schema.optional(PackRelativePath),
  required: Schema.optional(Schema.Boolean),
});
export type PackDataPort = typeof PackDataPort.Type;

export const PackCapability = Schema.Struct({
  /** One imperative sentence. The first thing a searching agent reads. */
  does: PackSummaryText,
  useCases: Schema.optional(Schema.Array(PackPurposeText)),
  /**
   * What the pack deliberately does not do. Cheap to write and the fastest way
   * for a consumer to rule a candidate out.
   */
  nonGoals: Schema.optional(Schema.Array(PackPurposeText)),
  inputs: Schema.optional(Schema.Array(PackDataPort)),
  outputs: Schema.optional(Schema.Array(PackDataPort)),
});
export type PackCapability = typeof PackCapability.Type;

// ── Requirements the consumer must satisfy ──────────────────────────────────

/**
 * A value the consumer supplies. `secret` drives storage and redaction, so it
 * is separate from `required`: a public publishable key is required and not
 * secret, a webhook signing secret is both.
 */
export const PackEnvRequirement = Schema.Struct({
  name: PackEnvVarName,
  purpose: PackPurposeText,
  secret: Schema.Boolean,
  required: Schema.Boolean,
  /** Never a real value — a shape, so the installer can show what to expect. */
  example: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  defaultValue: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** Where to go to get one. The difference between a pack that installs and
   * one that stalls on the first missing key. */
  obtainUrl: Schema.optional(PackUrl),
  /** Lets an installer reject an obviously wrong paste before anything runs. */
  pattern: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type PackEnvRequirement = typeof PackEnvRequirement.Type;

/** A third-party account the consumer has to hold in their own name. */
export const PackExternalAccount = Schema.Struct({
  service: PackSlug,
  displayName: TrimmedNonEmptyString,
  purpose: PackPurposeText,
  signupUrl: Schema.optional(PackUrl),
  requiredScopes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  requiredPlan: Schema.optional(TrimmedNonEmptyString),
  /** Flags the packs that cost money to run, before install rather than after. */
  costsMoney: Schema.optional(Schema.Boolean),
  providesEnvironment: Schema.optional(Schema.Array(PackEnvVarName)),
});
export type PackExternalAccount = typeof PackExternalAccount.Type;

export const PackServiceDependencyKind = Schema.Literals([
  "postgres",
  "mysql",
  "sqlite",
  "redis",
  "object-storage",
  "smtp",
  "queue",
  "vector-store",
  "custom",
]);
export type PackServiceDependencyKind = typeof PackServiceDependencyKind.Type;

/** Infrastructure the consumer must already be running or willing to run. */
export const PackServiceDependency = Schema.Struct({
  kind: PackServiceDependencyKind,
  name: PackSlug,
  purpose: PackPurposeText,
  versionRange: Schema.optional(PackVersionRange),
  connectionEnvVar: Schema.optional(PackEnvVarName),
});
export type PackServiceDependency = typeof PackServiceDependency.Type;

export const PackToolchainRequirement = Schema.Struct({
  name: PackSlug,
  versionRange: Schema.optional(PackVersionRange),
});
export type PackToolchainRequirement = typeof PackToolchainRequirement.Type;

export const PackDependency = Schema.Struct({
  id: PackId,
  name: PackName,
  publisherHandle: PackHandle,
  versionRange: PackVersionRange,
  optional: Schema.optional(Schema.Boolean),
});
export type PackDependency = typeof PackDependency.Type;

/**
 * An ordered step towards a runnable install. `satisfies` closes the loop
 * between a declared key and the instructions for getting it, and `verify` is
 * what lets a consuming agent check its own work instead of guessing.
 */
export const PackSetupStep = Schema.Struct({
  title: PackSummaryText,
  instructions: PackDescriptionText,
  command: Schema.optional(PackCommandText),
  verifyCommand: Schema.optional(PackCommandText),
  satisfies: Schema.optional(Schema.Array(PackEnvVarName)),
  /** Steps a machine cannot do, such as signing a contract or passing KYC. */
  manual: Schema.optional(Schema.Boolean),
});
export type PackSetupStep = typeof PackSetupStep.Type;

/**
 * Present even when empty: `{}` is an affirmative claim that the pack needs
 * nothing supplied, which is a different statement from an absent section and
 * one a reviewer can hold the publisher to.
 */
export const PackRequirements = Schema.Struct({
  environment: Schema.optional(Schema.Array(PackEnvRequirement)),
  accounts: Schema.optional(Schema.Array(PackExternalAccount)),
  services: Schema.optional(Schema.Array(PackServiceDependency)),
  toolchain: Schema.optional(Schema.Array(PackToolchainRequirement)),
  packs: Schema.optional(Schema.Array(PackDependency)),
  setupSteps: Schema.optional(Schema.Array(PackSetupStep)),
  /** Exits zero when everything above is in place. One command, so an agent
   * can answer "can this run yet?" without interpreting the list itself. */
  preflightCommand: Schema.optional(PackCommandText),
});
export type PackRequirements = typeof PackRequirements.Type;

// ── Interfaces ──────────────────────────────────────────────────────────────

export const PackHttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type PackHttpMethod = typeof PackHttpMethod.Type;

export const PackAuthenticationKind = Schema.Literals([
  "none",
  "api-key",
  "bearer",
  "session",
  "signature",
  "oauth",
]);
export type PackAuthenticationKind = typeof PackAuthenticationKind.Type;

/**
 * One callable operation. `operationId` is the join key: analytics meters
 * operations by id rather than restating routes, so a path can change without
 * orphaning a dashboard.
 */
export const PackApiOperation = Schema.Struct({
  operationId: PackSlug,
  method: PackHttpMethod,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  summary: PackSummaryText,
  authentication: Schema.optional(PackAuthenticationKind),
  requiresEnvironment: Schema.optional(Schema.Array(PackEnvVarName)),
});
export type PackApiOperation = typeof PackApiOperation.Type;

export const PackLibraryExport = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  kind: Schema.Literals(["function", "class", "component", "type", "constant", "hook"]),
  summary: PackSummaryText,
  signature: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
});
export type PackLibraryExport = typeof PackLibraryExport.Type;

export const PackCliCommand = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  usage: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  summary: PackSummaryText,
});
export type PackCliCommand = typeof PackCliCommand.Type;

/**
 * How a consumer touches the pack. A union rather than a `hasWebUi` flag,
 * because a headless payments API and a dashboard are not the same product and
 * a marketplace that assumes a front end cannot list the first one.
 *
 * `serviceId` points at the runtime service that hosts the interface, so ports
 * are declared exactly once.
 */
export const PackInterface = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("web"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    serviceId: Schema.optional(PackSlug),
    basePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
    framework: Schema.optional(TrimmedNonEmptyString),
    requiresAuthentication: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("tui"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    command: PackCommandText,
    summary: Schema.optional(PackSummaryText),
  }),
  Schema.Struct({
    kind: Schema.Literal("api"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    protocol: Schema.Literals(["http", "websocket", "grpc"]),
    serviceId: Schema.optional(PackSlug),
    basePath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
    specPath: Schema.optional(PackRelativePath),
    operations: Schema.NonEmptyArray(PackApiOperation),
  }),
  Schema.Struct({
    kind: Schema.Literal("library"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    language: TrimmedNonEmptyString,
    packageName: Schema.optional(TrimmedNonEmptyString),
    importPath: Schema.optional(PackRelativePath),
    exports: Schema.NonEmptyArray(PackLibraryExport),
  }),
  Schema.Struct({
    kind: Schema.Literal("cli"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    binary: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    commands: Schema.NonEmptyArray(PackCliCommand),
  }),
  /** Packs are searched and installed by agents, so being callable as tools is
   * a first-class interface rather than an integration detail. */
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    id: PackSlug,
    title: TrimmedNonEmptyString,
    transport: Schema.Literals(["stdio", "http"]),
    command: Schema.optional(PackCommandText),
    serviceId: Schema.optional(PackSlug),
    tools: Schema.NonEmptyArray(
      Schema.Struct({
        name: PackSlug,
        summary: PackSummaryText,
      }),
    ),
  }),
]);
export type PackInterface = typeof PackInterface.Type;

// ── Runtime ─────────────────────────────────────────────────────────────────

export const PackRuntimeTarget = Schema.Literals([
  "node",
  "bun",
  "deno",
  "python",
  "go",
  "rust",
  "container",
  "static",
  "none",
]);
export type PackRuntimeTarget = typeof PackRuntimeTarget.Type;

export const PackRuntimeCommand = Schema.Struct({
  command: PackCommandText,
  cwd: Schema.optional(PackRelativePath),
  description: Schema.optional(PackSummaryText),
});
export type PackRuntimeCommand = typeof PackRuntimeCommand.Type;

/**
 * A fixed lifecycle rather than a free list, because every downstream surface
 * needs to answer the same handful of questions and an open-ended array would
 * force each of them to guess which entry means "start".
 */
export const PackRuntimeCommands = Schema.Struct({
  install: Schema.optional(PackRuntimeCommand),
  build: Schema.optional(PackRuntimeCommand),
  start: Schema.optional(PackRuntimeCommand),
  dev: Schema.optional(PackRuntimeCommand),
  test: Schema.optional(PackRuntimeCommand),
  migrate: Schema.optional(PackRuntimeCommand),
  healthcheck: Schema.optional(PackRuntimeCommand),
});
export type PackRuntimeCommands = typeof PackRuntimeCommands.Type;

/**
 * How a service picks its port. A union because "port 3000", "whatever `PORT`
 * says" and "the runtime assigns one" need different handling at deploy time
 * and a nullable number cannot tell them apart.
 */
export const PackPortBinding = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("fixed"),
    port: PackPort,
  }),
  Schema.Struct({
    type: Schema.Literal("environment"),
    envVar: PackEnvVarName,
    defaultPort: Schema.optional(PackPort),
  }),
  Schema.Struct({
    type: Schema.Literal("dynamic"),
  }),
]);
export type PackPortBinding = typeof PackPortBinding.Type;

export const PackRuntimeService = Schema.Struct({
  id: PackSlug,
  title: TrimmedNonEmptyString,
  protocol: Schema.Literals(["http", "https", "ws", "tcp", "grpc"]),
  binding: PackPortBinding,
  /** Whether the deploy surface should route public traffic here. */
  exposure: Schema.Literals(["public", "internal", "loopback"]),
  healthPath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type PackRuntimeService = typeof PackRuntimeService.Type;

export const PackContainerSpec = Schema.Struct({
  dockerfilePath: Schema.optional(PackRelativePath),
  composePath: Schema.optional(PackRelativePath),
  image: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type PackContainerSpec = typeof PackContainerSpec.Type;

export const PackRuntime = Schema.Struct({
  target: PackRuntimeTarget,
  versionRange: Schema.optional(PackVersionRange),
  commands: PackRuntimeCommands,
  services: Schema.optional(Schema.Array(PackRuntimeService)),
  container: Schema.optional(PackContainerSpec),
});
export type PackRuntime = typeof PackRuntime.Type;

// ── Permissions ─────────────────────────────────────────────────────────────

/**
 * What leaves the machine. Declared per destination so a reviewer reads
 * "card data goes to Stripe" instead of inferring it from source.
 */
export const PackDataClass = Schema.Literals([
  "payment",
  "pii",
  "credentials",
  "content",
  "telemetry",
  "none",
]);
export type PackDataClass = typeof PackDataClass.Type;

export const PackNetworkEgress = Schema.Struct({
  host: PackHostPattern,
  purpose: PackPurposeText,
  ports: Schema.optional(Schema.Array(PackPort)),
  required: Schema.optional(Schema.Boolean),
  dataClasses: Schema.optional(Schema.Array(PackDataClass)),
});
export type PackNetworkEgress = typeof PackNetworkEgress.Type;

/**
 * Filesystem access is anchored to a named root rather than a raw path, so a
 * sandbox can map the roots however it likes and `absolute` stands out as the
 * one case a reviewer has to argue with.
 */
export const PackFilesystemRoot = Schema.Literals([
  "pack",
  "data",
  "tmp",
  "workspace",
  "home",
  "absolute",
]);
export type PackFilesystemRoot = typeof PackFilesystemRoot.Type;

export const PackFilesystemAccess = Schema.Struct({
  root: PackFilesystemRoot,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_RELATIVE_PATH_MAX_LENGTH)),
  access: Schema.Literals(["read", "write", "read-write"]),
  purpose: PackPurposeText,
});
export type PackFilesystemAccess = typeof PackFilesystemAccess.Type;

export const PackSecretAccess = Schema.Struct({
  name: PackEnvVarName,
  purpose: PackPurposeText,
});
export type PackSecretAccess = typeof PackSecretAccess.Type;

export const PackProcessPermission = Schema.Struct({
  spawnsSubprocesses: Schema.Boolean,
  commands: Schema.optional(Schema.Array(PackCommandText)),
});
export type PackProcessPermission = typeof PackProcessPermission.Type;

/**
 * Anything the permission model above cannot express. Each entry carries a
 * justification because these are exactly the requests a human should read
 * before approving, and an unjustified escalation is a review failure.
 */
export const PackElevatedCapability = Schema.Struct({
  capability: Schema.Literals([
    "raw-socket",
    "native-module",
    "privileged-port",
    "host-network",
    "docker-socket",
    "system-package-install",
    "kernel-module",
  ]),
  justification: PackPurposeText,
});
export type PackElevatedCapability = typeof PackElevatedCapability.Type;

/**
 * Like requirements, present even when empty: `{}` claims the pack needs no
 * access at all, and enforcement later gets to treat anything undeclared as a
 * violation rather than an omission.
 */
export const PackPermissions = Schema.Struct({
  network: Schema.optional(Schema.Array(PackNetworkEgress)),
  acceptsInboundNetwork: Schema.optional(Schema.Boolean),
  filesystem: Schema.optional(Schema.Array(PackFilesystemAccess)),
  secrets: Schema.optional(Schema.Array(PackSecretAccess)),
  process: Schema.optional(PackProcessPermission),
  elevated: Schema.optional(Schema.Array(PackElevatedCapability)),
});
export type PackPermissions = typeof PackPermissions.Type;

// ── Verification ────────────────────────────────────────────────────────────

export const PackVerificationCheckId = Schema.Literals([
  "manifest-schema",
  "requirements-complete",
  "permissions-reviewed",
  "secret-scan",
  "dependency-audit",
  "license-compatible",
  "build-reproducible",
  "runtime-smoke-test",
  "integration-prompt-reviewed",
  "handover-reviewed",
]);
export type PackVerificationCheckId = typeof PackVerificationCheckId.Type;

export const PackVerificationCheck = Schema.Struct({
  id: PackVerificationCheckId,
  outcome: Schema.Literals(["pass", "fail", "waived"]),
  note: Schema.optional(PackPurposeText),
});
export type PackVerificationCheck = typeof PackVerificationCheck.Type;

export const PackVerifier = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  userId: Schema.optional(UserId),
  organizationId: Schema.optional(OrganizationId),
});
export type PackVerifier = typeof PackVerifier.Type;

/**
 * A union, so "verified" cannot exist without a verifier, a timestamp and the
 * list of what was actually checked. The publisher writes `unverified` and
 * nothing else: the registry owns every other state and overwrites this block
 * on publish, because a self-asserted badge is worth nothing.
 */
export const PackVerification = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unverified"),
  }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    submittedAt: IsoDateTime,
    submittedByUserId: Schema.optional(UserId),
  }),
  Schema.Struct({
    status: Schema.Literal("verified"),
    verifiedAt: IsoDateTime,
    verifier: PackVerifier,
    checks: Schema.NonEmptyArray(PackVerificationCheck),
    /** Verification is pinned to bytes, so a re-review is due when it lapses. */
    expiresAt: Schema.optional(IsoDateTime),
    notes: Schema.optional(PackDescriptionText),
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    decidedAt: IsoDateTime,
    verifier: PackVerifier,
    checks: Schema.NonEmptyArray(PackVerificationCheck),
    reason: PackDescriptionText,
  }),
  Schema.Struct({
    status: Schema.Literal("revoked"),
    revokedAt: IsoDateTime,
    verifier: PackVerifier,
    reason: PackDescriptionText,
  }),
]);
export type PackVerification = typeof PackVerification.Type;

// ── Visibility ──────────────────────────────────────────────────────────────

/**
 * Who can find and install this. The scoped variants carry their own id so an
 * installer can refuse a pack that wandered outside its boundary, and
 * `unlisted` exists because "share a link with a client" is not the same
 * request as "put this in the marketplace".
 */
export const PackVisibility = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("workspace"),
    workspaceKeyId: PackWorkspaceKeyId,
    workspaceId: Schema.optional(WorkspaceId),
  }),
  Schema.Struct({
    scope: Schema.Literal("tenant"),
    tenantId: TenantId,
  }),
  Schema.Struct({
    scope: Schema.Literal("organization"),
    organizationId: OrganizationId,
  }),
  Schema.Struct({
    scope: Schema.Literal("unlisted"),
  }),
  Schema.Struct({
    scope: Schema.Literal("public"),
  }),
]);
export type PackVisibility = typeof PackVisibility.Type;

// ── Integration ─────────────────────────────────────────────────────────────

export const PackIntegrationTarget = Schema.Literals([
  "generic",
  "t3",
  "claude-code",
  "codex",
  "cursor",
  "windsurf",
  "lovable",
  "replit",
  "v0",
  "bolt",
]);
export type PackIntegrationTarget = typeof PackIntegrationTarget.Type;

export const PackIntegrationSnippet = Schema.Struct({
  title: PackSummaryText,
  language: PackSlug,
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  description: Schema.optional(PackPurposeText),
});
export type PackIntegrationSnippet = typeof PackIntegrationSnippet.Type;

/**
 * The paste-into-another-agent surface. The generic prompt is required and
 * inline so a search result is immediately actionable without fetching files;
 * variants exist because the same instructions land differently in a tool that
 * owns its own hosting than in one that does not.
 */
export const PackIntegration = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
  installCommand: Schema.optional(PackCommandText),
  variants: Schema.optional(
    Schema.Array(
      Schema.Struct({
        target: PackIntegrationTarget,
        prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
      }),
    ),
  ),
  snippets: Schema.optional(Schema.Array(PackIntegrationSnippet)),
  /** What the consuming agent should ask its user before wiring anything up. */
  followUpQuestions: Schema.optional(Schema.Array(PackSummaryText)),
});
export type PackIntegration = typeof PackIntegration.Type;

// ── Analytics ───────────────────────────────────────────────────────────────

export const PackAnalyticsProperty = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/), Schema.isMaxLength(64)),
  type: Schema.Literals(["string", "number", "boolean", "timestamp"]),
  /** Drives redaction and retention downstream, so it is required per property. */
  pii: Schema.Boolean,
  description: Schema.optional(PackPurposeText),
});
export type PackAnalyticsProperty = typeof PackAnalyticsProperty.Type;

export const PackAnalyticsEvent = Schema.Struct({
  name: PackEventName,
  source: Schema.Literals(["frontend", "backend", "job", "cli"]),
  description: PackPurposeText,
  properties: Schema.optional(Schema.Array(PackAnalyticsProperty)),
});
export type PackAnalyticsEvent = typeof PackAnalyticsEvent.Type;

/**
 * A chart the deployment dashboard can draw without anyone configuring it.
 * Sources reference declared events and operation ids rather than restating
 * routes, so the manifest keeps one definition of each traffic surface.
 */
export const PackAnalyticsMetric = Schema.Struct({
  id: PackSlug,
  title: PackSummaryText,
  kind: Schema.Literals(["count", "unique-users", "sum", "latency-p95", "error-rate"]),
  source: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("event"),
      event: PackEventName,
      property: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
    }),
    Schema.Struct({
      type: Schema.Literal("operation"),
      operationId: PackSlug,
    }),
  ]),
  unit: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
});
export type PackAnalyticsMetric = typeof PackAnalyticsMetric.Type;

export const PackAnalytics = Schema.Struct({
  events: Schema.optional(Schema.Array(PackAnalyticsEvent)),
  /** Operation ids whose traffic should be counted, drawn from the interfaces. */
  meteredOperations: Schema.optional(Schema.Array(PackSlug)),
  metrics: Schema.optional(Schema.Array(PackAnalyticsMetric)),
  sink: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["t3", "none", "custom"]),
      endpointEnvVar: Schema.optional(PackEnvVarName),
    }),
  ),
});
export type PackAnalytics = typeof PackAnalytics.Type;

// ── Contents and signature ──────────────────────────────────────────────────

export const PackFileDigest = Schema.Struct({
  path: PackRelativePath,
  sha256: PackSha256,
  bytes: NonNegativeInt,
});
export type PackFileDigest = typeof PackFileDigest.Type;

/**
 * Where the conventional files actually live. Paths are declared rather than
 * assumed so a pack can be laid out to suit its language, and the digest list
 * is what a signature and an archive are checked against. Authoring tools leave
 * `files` empty; the publisher fills it when the bytes stop moving.
 */
export const PackContents = Schema.Struct({
  readmePath: Schema.optional(PackRelativePath),
  licensePath: Schema.optional(PackRelativePath),
  iconPath: Schema.optional(PackRelativePath),
  sourceRoot: Schema.optional(PackRelativePath),
  examplesRoot: Schema.optional(PackRelativePath),
  files: Schema.optional(Schema.Array(PackFileDigest)),
  archiveSha256: Schema.optional(PackSha256),
});
export type PackContents = typeof PackContents.Type;

/**
 * Covers the canonical manifest with this block removed, plus the contents
 * digest, so neither the metadata nor the files can be swapped independently.
 */
export const PackSignature = Schema.Struct({
  keyId: PackSigningKeyId,
  algorithm: Schema.Literal("ed25519"),
  publicKey: PackBase64,
  manifestSha256: PackSha256,
  contentsSha256: Schema.optional(PackSha256),
  signature: PackBase64,
  signedAt: IsoDateTime,
});
export type PackSignature = typeof PackSignature.Type;

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * The whole of `pack.json`. Sections are grouped by the question they answer —
 * who made it, where it came from, what it does, what you must bring, how you
 * touch it, how it runs, what it may reach, whether anyone checked, who may see
 * it, how to wire it up, what it reports — because that is the order a consumer
 * reads them in and the order the downstream surfaces consume them.
 */
export const PackManifest = Schema.Struct({
  formatVersion: PackFormatVersion,
  identity: PackIdentity,
  provenance: PackProvenance,
  capability: PackCapability,
  requirements: PackRequirements,
  interfaces: Schema.NonEmptyArray(PackInterface),
  runtime: PackRuntime,
  permissions: PackPermissions,
  verification: PackVerification,
  visibility: PackVisibility,
  integration: PackIntegration,
  analytics: Schema.optional(PackAnalytics),
  contents: Schema.optional(PackContents),
  signature: Schema.optional(PackSignature),
});
export type PackManifest = typeof PackManifest.Type;

/**
 * Read first, decoded loosely, so an unsupported format version produces a
 * useful message instead of a pile of missing-field errors.
 */
export const PackManifestEnvelope = Schema.Struct({
  formatVersion: TrimmedNonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type PackManifestEnvelope = typeof PackManifestEnvelope.Type;

// ── Registry projections ────────────────────────────────────────────────────

/** Enough to name one exact release. */
export const PackRef = Schema.Struct({
  id: PackId,
  name: PackName,
  version: PackVersion,
  publisherHandle: PackHandle,
});
export type PackRef = typeof PackRef.Type;

/**
 * What a search returns. Flattened out of the manifest so a coding agent can
 * scan many candidates cheaply, and carrying the required keys because "what
 * would I have to set up" is the first question that rules a pack out.
 */
export const PackSummary = Schema.Struct({
  ref: PackRef,
  displayName: TrimmedNonEmptyString,
  summary: PackSummaryText,
  does: PackSummaryText,
  categories: Schema.optional(Schema.Array(PackCategory)),
  tags: Schema.optional(Schema.Array(PackTag)),
  interfaceKinds: Schema.NonEmptyArray(
    Schema.Literals(["web", "tui", "api", "library", "cli", "mcp"]),
  ),
  requiredEnvironment: Schema.Array(PackEnvVarName),
  requiredAccounts: Schema.Array(PackSlug),
  verificationStatus: Schema.Literals(["unverified", "pending", "verified", "rejected", "revoked"]),
  visibilityScope: Schema.Literals(["workspace", "tenant", "organization", "unlisted", "public"]),
  license: PackLicense,
  updatedAt: IsoDateTime,
});
export type PackSummary = typeof PackSummary.Type;

// ── Publish readiness ───────────────────────────────────────────────────────

/**
 * Rules that a well-formed manifest can still break. They are kept out of the
 * schema on purpose: a half-finished pack must stay decodable so the tooling
 * can tell its author what is missing, rather than refusing to open the file.
 */
export const PackReadinessCode = Schema.Literals([
  "handover-empty",
  "start-command-missing",
  "service-binding-missing",
  "integration-prompt-thin",
  "license-unspecified",
  "requirements-undeclared",
  "permissions-undeclared",
  "secret-value-in-manifest",
  "elevated-capability-unjustified",
  "analytics-operation-unknown",
  "interface-service-unknown",
  "contents-digest-missing",
  "signature-missing",
]);
export type PackReadinessCode = typeof PackReadinessCode.Type;

export const PackReadinessIssue = Schema.Struct({
  code: PackReadinessCode,
  severity: Schema.Literals(["error", "warning"]),
  /** Dotted path into the manifest, so an editor can jump straight to it. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  message: PackPurposeText,
});
export type PackReadinessIssue = typeof PackReadinessIssue.Type;

export const PackReadinessReport = Schema.Struct({
  ref: PackRef,
  publishable: Schema.Boolean,
  issues: Schema.Array(PackReadinessIssue),
});
export type PackReadinessReport = typeof PackReadinessReport.Type;

export class PackError extends Schema.TaggedErrorClass<PackError>()("PackError", {
  message: TrimmedNonEmptyString,
  code: Schema.Literals([
    "manifest-not-found",
    "manifest-invalid",
    "format-version-unsupported",
    "signature-invalid",
    "digest-mismatch",
    "pack-not-found",
    "version-exists",
    "visibility-forbidden",
    "requirements-unmet",
    "verification-required",
  ]),
  cause: Schema.optional(Schema.Defect),
}) {}
