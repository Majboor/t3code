import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const PACK_MODE_SETTINGS_STORAGE_KEY = "t3code:pack-mode:v1";

const PackScopeSchema = Schema.Literals(["workspace", "ecosystem"]);
export type PackScope = typeof PackScopeSchema.Type;

/**
 * What a person requires of a pack before the agent is allowed to suggest it.
 * These are the production signals themselves rather than a verified/unverified
 * tier: a tier is coarser than the decision being made, and every honest tier
 * would have to be derived from exactly these numbers anyway.
 */
const PackRequirementsSchema = Schema.Struct({
  minDeployments: Schema.Number,
  minMonthsInService: Schema.Number,
  includeAuthorOnly: Schema.Boolean,
});
export type PackRequirements = typeof PackRequirementsSchema.Type;

const PackModeSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  scope: PackScopeSchema,
  requirements: PackRequirementsSchema,
});
export type PackModeSettings = typeof PackModeSettingsSchema.Type;

export interface PackSignals {
  /** Deployments the pack has been installed into and survived. */
  readonly deployments: number;
  readonly monthsInService: number;
  /** Teams other than the author with the pack running in production. */
  readonly independentOperators: number;
  /** Share of installs that finished without a human unblocking them, 0..1. */
  readonly cleanInstallRate: number;
  /** Failures the maintenance agent caught and folded back into the pack. */
  readonly breakagesCaught: number;
}

export interface Pack {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Private to this workspace, or published to the wider ecosystem. */
  readonly scope: PackScope;
  readonly summary: string;
  /** Failure modes the pack already absorbed, in the words of what breaks. */
  readonly handles: readonly string[];
  /** What the person has to supply before the pack works at all. */
  readonly requires: readonly string[];
  readonly signals: PackSignals;
}

export const DEFAULT_PACK_MODE_SETTINGS: PackModeSettings = {
  enabled: false,
  scope: "ecosystem",
  requirements: {
    minDeployments: 25,
    minMonthsInService: 3,
    includeAuthorOnly: false,
  },
};

export const PACK_DEPLOYMENT_OPTIONS: ReadonlyArray<{
  readonly value: number;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: 0, label: "Any", hint: "Suggest a pack however few places run it." },
  { value: 25, label: "25+", hint: "Only packs installed into at least 25 deployments." },
  { value: 100, label: "100+", hint: "Only packs installed into at least 100 deployments." },
];

export const PACK_TIME_IN_SERVICE_OPTIONS: ReadonlyArray<{
  readonly value: number;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: 0, label: "Any", hint: "Suggest a pack however new it is." },
  { value: 3, label: "3 months", hint: "Only packs that have been running for three months." },
  { value: 12, label: "A year", hint: "Only packs that have been running for a year." },
];

export const PACK_SCOPE_OPTIONS: ReadonlyArray<{
  readonly value: PackScope;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "workspace", label: "This workspace", hint: "Only packs your workspace owns." },
  { value: "ecosystem", label: "Everywhere", hint: "Your packs and everyone else's." },
];

export function packMeetsRequirements(pack: Pack, requirements: PackRequirements): boolean {
  if (pack.signals.deployments < requirements.minDeployments) return false;
  if (pack.signals.monthsInService < requirements.minMonthsInService) return false;
  if (!requirements.includeAuthorOnly && pack.signals.independentOperators === 0) return false;
  return true;
}

/**
 * The most-proven pack wins, with longer service breaking ties. Relevance is
 * the directory's job; this only picks between packs it already considers hits.
 */
export function selectSuggestedPack(
  packs: readonly Pack[],
  dismissedPackIds: readonly string[],
): Pack | null {
  let best: Pack | null = null;
  for (const pack of packs) {
    if (dismissedPackIds.includes(pack.id)) continue;
    if (best === null) {
      best = pack;
      continue;
    }
    if (pack.signals.deployments > best.signals.deployments) {
      best = pack;
      continue;
    }
    if (
      pack.signals.deployments === best.signals.deployments &&
      pack.signals.monthsInService > best.signals.monthsInService
    ) {
      best = pack;
    }
  }
  return best;
}

export function formatTimeInService(months: number): string {
  if (months < 1) return "under a month in service";
  if (months < 12) return `${months} months in service`;
  const years = Math.floor(months / 12);
  return years === 1 ? "a year in service" : `${years} years in service`;
}

export function formatPackSignals(signals: PackSignals): string {
  const parts = [
    `${signals.deployments.toLocaleString()} deployments`,
    formatTimeInService(signals.monthsInService),
    `${Math.round(signals.cleanInstallRate * 100)}% of installs need no help`,
  ];
  if (signals.breakagesCaught > 0) {
    parts.push(`${signals.breakagesCaught} breakages caught and fixed`);
  }
  if (signals.independentOperators === 0) {
    parts.push("only the author has run it");
  }
  return parts.join(" · ");
}

/**
 * The instruction is written as the person asking, because it lands in their
 * composer and they send it. It leads with what the pack gets right, never with
 * effort saved: the correctness claim is the one that survives cheaper models.
 */
export function buildPackIntegrationInstruction(pack: Pack): string {
  const lines = [
    `Use the "${pack.name}" pack (${pack.version}) for this instead of writing it from scratch.`,
    "",
    pack.summary,
  ];

  if (pack.handles.length > 0) {
    lines.push("", "It already handles:");
    for (const failure of pack.handles) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push(
    "",
    `It has ${formatPackSignals(pack.signals)}.`,
    "",
    "Read the pack's integration knowledge before writing any code, wire it into the existing codebase rather than pasting it in alongside, and keep its verification tests running afterwards.",
  );

  if (pack.requires.length > 0) {
    lines.push(
      "",
      `Before it works I have to supply: ${pack.requires.join(", ")}. Tell me exactly where to obtain each one, and stop rather than guessing if a step is unclear.`,
    );
  }

  return lines.join("\n");
}

export function appendPackInstructionToPrompt(prompt: string, instruction: string): string {
  const existing = prompt.trimEnd();
  return existing.length === 0 ? instruction : `${existing}\n\n${instruction}`;
}

export function usePackModeSettings(): [
  PackModeSettings,
  (update: (previous: PackModeSettings) => PackModeSettings) => void,
] {
  return useLocalStorage(
    PACK_MODE_SETTINGS_STORAGE_KEY,
    DEFAULT_PACK_MODE_SETTINGS,
    PackModeSettingsSchema,
  );
}
