import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

/**
 * True once a config snapshot reports a different `clientBuildId` than the
 * one this page loaded with — i.e. the server has been redeployed since this
 * tab opened. `serverVersion` alone doesn't catch this: nobody bumps
 * `package.json` on every deploy, so a tab can sit for hours running JS that
 * predates a real bugfix (the socket happily reconnects underneath it — see
 * the `resubscribeShell`/`resubscribeConfig` fixes — but the code executing
 * in the tab never updates itself). There is no way to retroactively patch
 * already-running JS; the only real remedy is a reload, so this exists to
 * prompt one instead of leaving a person to rediscover "just refresh" by
 * hitting a bug that a reload would have already fixed.
 */
export const clientUpdateAvailableAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("client-update-available"),
);

let observedClientBuildId: string | null = null;

export function observeClientBuildId(nextBuildId: string | undefined): void {
  if (!nextBuildId) {
    return;
  }
  if (observedClientBuildId === null) {
    observedClientBuildId = nextBuildId;
    return;
  }
  if (nextBuildId !== observedClientBuildId) {
    appAtomRegistry.set(clientUpdateAvailableAtom, true);
  }
}

export function useClientUpdateAvailable(): boolean {
  return useAtomValue(clientUpdateAvailableAtom);
}

export function getClientUpdateAvailable(): boolean {
  return appAtomRegistry.get(clientUpdateAvailableAtom);
}

export function resetClientBuildFreshnessForTests(): void {
  observedClientBuildId = null;
  appAtomRegistry.set(clientUpdateAvailableAtom, false);
}
