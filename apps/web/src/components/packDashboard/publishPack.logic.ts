import type { PackManifest } from "@t3tools/contracts";

/**
 * Turning a project into a pack.
 *
 * The format's whole argument is that the interface is the carrier and the
 * knowledge is the product, so this asks for the two things nobody else can
 * supply and refuses to invent either. A pack whose author cannot say what it
 * does, or what they learned building it, is a zip file with metadata — and
 * generating a plausible-sounding one on their behalf would be worse than
 * refusing, because it reads as knowledge and is not.
 */
/**
 * What shape the thing is. The format requires at least one interface, and the
 * two offered here are the two that can be declared honestly from a dialog: a
 * web surface needs only a title, and a terminal program only its command.
 *
 * An API or a library would need its operations or its exports enumerated, and
 * a pack that claims those without listing them is worse than one that waits.
 * Those are added by editing the manifest, where the author can actually say
 * what they are.
 */
export type PublishPackShape = "web" | "tui";

/**
 * What the pack needs from whoever uses it, one name per line. A name ending in
 * `!` is a secret, which is the shortest way to say the thing that matters most
 * about a requirement — a secret is satisfied from the server secret store and
 * must never be typed where a value would be stored.
 */
export function parseRequirements(raw: string): ReadonlyArray<{ name: string; secret: boolean }> {
  const seen = new Set<string>();
  const parsed: Array<{ name: string; secret: boolean }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const secret = trimmed.endsWith("!");
    const name = (secret ? trimmed.slice(0, -1) : trimmed).trim().toUpperCase();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    parsed.push({ name, secret });
  }
  return parsed;
}

export interface PublishPackInput {
  readonly requirements: string;
  readonly shape: PublishPackShape;
  readonly startCommand: string;
  readonly name: string;
  readonly publisherHandle: string;
  /** One line: what it does. */
  readonly summary: string;
  /** What was built, what was tried, what is left undone. */
  readonly handover: string;
  readonly workspaceKeyId: string;
  readonly authorName: string;
  readonly extractedAt: string;
  readonly packId: string;
}

export type PublishPackProblem =
  | { readonly field: "name"; readonly why: string }
  | { readonly field: "summary"; readonly why: string }
  | { readonly field: "handover"; readonly why: string };

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * A publisher handle has to be a slug, and the ids this is built from are not:
 * a tenant id looks like `tenant:personal-<uuid>`, whose colon the format
 * refuses. Slugifying here rather than at the call site means the dialog cannot
 * accidentally pass something the registry will reject after the author has
 * already written their handover.
 */
export function toHandle(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "unknown";
}

/** The shortest handover that could say anything real. Below this it is a placeholder. */
const HANDOVER_MINIMUM = 40;

/**
 * Long enough to name a capability rather than gesture at one. "does stuff" is
 * ten characters and says nothing, which is what this number is calibrated
 * against.
 */
const SUMMARY_MINIMUM = 20;

export function findPublishProblems(
  input: Pick<PublishPackInput, "name" | "summary" | "handover">,
): ReadonlyArray<PublishPackProblem> {
  const problems: PublishPackProblem[] = [];

  if (!NAME_PATTERN.test(input.name)) {
    problems.push({
      field: "name",
      why: "Lowercase letters, numbers and hyphens, starting and ending with a letter or number.",
    });
  }
  if (input.summary.trim().length < SUMMARY_MINIMUM) {
    problems.push({
      field: "summary",
      why: "Say what it does in a line somebody could search for.",
    });
  }
  if (input.handover.trim().length < HANDOVER_MINIMUM) {
    problems.push({
      field: "handover",
      why: "Say what you built, what you tried, and what you left undone. This is the part that is worth anything.",
    });
  }

  return problems;
}

/**
 * Builds the manifest. `knowledge` is present and empty on purpose: the format
 * requires it either way, and an empty one is an honest claim — this pack has
 * run nowhere and learned nothing yet. Filling it with invented failure modes
 * would make a template look like experience.
 */
export function buildManifest(input: PublishPackInput): PackManifest {
  return {
    formatVersion: "2.0",
    identity: {
      id: input.packId,
      name: input.name,
      version: "0.1.0",
      displayName: input.name,
      summary: input.summary.trim(),
      publisher: {
        type: "user",
        handle: toHandle(input.publisherHandle),
        displayName: toHandle(input.publisherHandle),
      },
      license: "UNLICENSED",
      tags: [],
    },
    provenance: {
      workspace: { workspaceKeyId: input.workspaceKeyId },
      extractedAt: input.extractedAt,
      extractedBy: { type: "user", displayName: input.authorName },
      handover: {
        path: "handover.md",
        summary: input.handover.trim(),
        generatedAt: input.extractedAt,
      },
    },
    capability: { does: input.summary.trim() },
    knowledge: {},
    requirements: {
      environment: parseRequirements(input.requirements).map((entry) => ({
        name: entry.name,
        purpose: `Required by ${input.name}.`,
        secret: entry.secret,
        required: true,
      })),
    },
    interfaces: [
      input.shape === "web"
        ? { kind: "web", id: input.name, title: input.name }
        : {
            kind: "tui",
            id: input.name,
            title: input.name,
            command: input.startCommand.trim() || input.name,
          },
    ],
    runtime: {
      target: "none",
      commands: input.startCommand.trim() ? { start: { command: input.startCommand.trim() } } : {},
    },
    permissions: {},
    verification: {
      record: {
        measuredAt: input.extractedAt,
        installsAttempted: 0,
        installsSucceeded: 0,
        deploymentsAttempted: 0,
        deploymentsSurviving: 0,
        cumulativeServiceDays: 0,
        breakagesCaught: 0,
        breakagesFixed: 0,
      },
    },
    visibility: { scope: "workspace", workspaceKeyId: input.workspaceKeyId },
    integration: {
      prompt: `${input.summary.trim()}\n\n${input.handover.trim()}`,
    },
  } as unknown as PackManifest;
}
