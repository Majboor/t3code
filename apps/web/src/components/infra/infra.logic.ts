import type { PackEnablement } from "@t3tools/contracts";

/**
 * What a project still has to do before an enabled pack could run.
 *
 * Enabling records intent and supplies nothing, so this is the difference
 * between the two — and it is the only number on the page worth anything. A
 * page that showed enabled packs without it would read as a list of working
 * things.
 */
export function describeReadiness(enablement: PackEnablement): {
  readonly missing: ReadonlyArray<string>;
  readonly ready: boolean;
  readonly summary: string;
} {
  const missing = enablement.settings
    .filter((setting) => !setting.provided)
    .map((setting) => setting.name);

  if (enablement.settings.length === 0) {
    return { missing: [], ready: true, summary: "Asks for nothing" };
  }
  if (missing.length === 0) {
    return { missing: [], ready: true, summary: "Everything it asks for is set" };
  }
  return {
    missing,
    ready: false,
    summary: `${missing.length} of ${enablement.settings.length} still to set`,
  };
}

/**
 * Sorts so the packs needing attention are at the top, alphabetical within a
 * group — a list that reorders itself as things are configured is one nobody
 * can find anything in twice.
 */
export function orderForAttention(
  enablements: ReadonlyArray<PackEnablement>,
): ReadonlyArray<PackEnablement> {
  return enablements.toSorted((left, right) => {
    const leftReady = describeReadiness(left).ready;
    const rightReady = describeReadiness(right).ready;
    if (leftReady !== rightReady) return leftReady ? 1 : -1;
    return left.packName.localeCompare(right.packName);
  });
}
