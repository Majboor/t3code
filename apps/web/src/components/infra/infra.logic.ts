import type { PackEnablement } from "@t3tools/contracts";

/**
 * What an enabled pack says it needs.
 *
 * Deliberately not "what is still missing". Nothing here can see whether an
 * environment variable is set on the machine that will run the pack, so
 * reporting one as "not set" would be a claim this cannot check — the same
 * mistake as a button that appears to install something. What it can say is
 * what the pack asked for, which is true and is the part a reader has to act
 * on anyway.
 *
 * `provided` exists for the case that is checkable — a secret the server holds
 * — and stays false until something actually looks.
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
    return { missing: [], ready: true, summary: "Everything it asks for is accounted for" };
  }
  return {
    missing,
    ready: false,
    summary: `Needs ${missing.length} thing${missing.length === 1 ? "" : "s"} you have to supply`,
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
