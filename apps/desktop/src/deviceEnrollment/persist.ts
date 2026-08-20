/**
 * Where a collected credential lands.
 *
 * Deliberately no new storage mechanism. A machine that has joined an account
 * is a saved environment with a bearer token, which is exactly what the manual
 * "add environment" path already produces (`clientPersistence.ts`) and exactly
 * what the app already knows how to read on the next launch. Inventing a second
 * credential store would mean two things to migrate, two things to revoke, and
 * a sign-out that only clears one of them.
 *
 * The write order is not a style choice: `writeSavedEnvironmentSecret` returns
 * `false` when no record carries the id, so the registry entry has to exist
 * first. When the secret write fails, the record is rolled back rather than
 * left behind — a listed environment with no credential is an entry that fails
 * every time it is touched and that nothing in the UI explains.
 *
 * @module DeviceEnrollment
 */

import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  readSavedEnvironmentRegistry,
  writeSavedEnvironmentRegistry,
  writeSavedEnvironmentSecret,
  type DesktopSecretStorage,
} from "../clientPersistence.ts";
import type { CollectedEnrollment } from "./types.ts";

/**
 * Turns `https://host` into `wss://host`, used only when the server does not
 * say. Derived rather than defaulted to a constant because the websocket has to
 * reach the same deployment the credential is for, and a wrong-but-plausible
 * default would fail as a connection error long after the flow reported success.
 */
export function deriveWsBaseUrl(httpBaseUrl: string): string | null {
  try {
    const url = new URL(httpBaseUrl);
    if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * The registry entry for a machine that just joined an account.
 *
 * Pure, so the parts that have caused trouble before — a missing environment
 * id, a server that named no URLs — can be pinned down without touching a disk.
 */
export function buildEnrollmentEnvironmentRecord(input: {
  readonly credential: CollectedEnrollment;
  readonly fallbackHttpBaseUrl: string;
  readonly fallbackLabel: string;
  readonly fallbackEnvironmentId: string;
  readonly createdAt: string;
}): PersistedSavedEnvironmentRecord | null {
  const httpBaseUrl = (input.credential.httpBaseUrl ?? input.fallbackHttpBaseUrl).replace(
    /\/+$/,
    "",
  );
  const wsBaseUrl = input.credential.wsBaseUrl ?? deriveWsBaseUrl(httpBaseUrl);
  if (!wsBaseUrl) {
    return null;
  }

  const rawId = input.credential.environmentId ?? input.fallbackEnvironmentId;
  let environmentId: EnvironmentId;
  try {
    environmentId = Schema.decodeUnknownSync(EnvironmentId)(rawId);
  } catch {
    return null;
  }

  return {
    environmentId,
    label: input.credential.label ?? input.fallbackLabel,
    httpBaseUrl,
    wsBaseUrl,
    createdAt: input.createdAt,
    lastConnectedAt: null,
  };
}

export interface StoreEnrollmentCredentialInput {
  readonly registryPath: string;
  readonly secretStorage: DesktopSecretStorage;
  readonly record: PersistedSavedEnvironmentRecord;
  readonly sessionToken: string;
}

/**
 * Registers the machine and stores its token, or throws having changed nothing.
 *
 * Re-enrolling the same environment replaces its entry rather than appending a
 * second: the registry is keyed by id everywhere it is read, and a duplicate
 * would make "which of these two is the live one" a question with no answer.
 */
export function storeEnrollmentCredential(input: StoreEnrollmentCredentialInput): void {
  if (!input.secretStorage.isEncryptionAvailable()) {
    throw new Error(
      "This machine cannot store credentials securely, so nothing was saved. Check that your system keychain is available.",
    );
  }

  const existing = readSavedEnvironmentRegistry(input.registryPath);
  const withoutThisEnvironment = existing.filter(
    (record) => record.environmentId !== input.record.environmentId,
  );

  writeSavedEnvironmentRegistry(input.registryPath, [...withoutThisEnvironment, input.record]);

  const stored = writeSavedEnvironmentSecret({
    registryPath: input.registryPath,
    environmentId: input.record.environmentId,
    secret: input.sessionToken,
    secretStorage: input.secretStorage,
  });

  if (!stored) {
    writeSavedEnvironmentRegistry(input.registryPath, existing);
    throw new Error("Unable to store this machine's credentials.");
  }
}

/**
 * Whether this machine has already joined an account.
 *
 * The readiness question the rest of the app asks is "are there saved
 * environments" (see `docs/web-and-cloud-scope.md`), not "is a connection
 * live" — a machine whose laptop is asleep has still joined. Asking the same
 * question here is what keeps the connect window from reappearing on a machine
 * that is merely offline.
 */
export function hasConnectedEnvironment(registryPath: string): boolean {
  return readSavedEnvironmentRegistry(registryPath).length > 0;
}
