import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  readSavedEnvironmentRegistry,
  readSavedEnvironmentSecret,
  writeSavedEnvironmentRegistry,
  type DesktopSecretStorage,
} from "../clientPersistence.ts";
import {
  buildEnrollmentEnvironmentRecord,
  deriveWsBaseUrl,
  hasConnectedEnvironment,
  storeEnrollmentCredential,
} from "./persist.ts";
import type { CollectedEnrollment } from "./types.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempPath(fileName: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-device-enrollment-test-"));
  tempDirectories.push(directory);
  return path.join(directory, fileName);
}

function makeSecretStorage(available: boolean): DesktopSecretStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").slice("enc:".length),
  };
}

const credential: CollectedEnrollment = {
  sessionToken: "secret-token",
  environmentId: "env-1",
  label: "Atlas",
  httpBaseUrl: "https://app.logicpacks.io",
  wsBaseUrl: "wss://app.logicpacks.io",
};

const recordInput = {
  credential,
  fallbackHttpBaseUrl: "https://app.logicpacks.io",
  fallbackLabel: "app.logicpacks.io",
  fallbackEnvironmentId: "enrolled-abc",
  createdAt: "2026-08-20T00:00:00.000Z",
};

describe("deriveWsBaseUrl", () => {
  /*
   * Derived rather than defaulted to a constant: the websocket has to reach the
   * same deployment the credential is for, and a wrong-but-plausible default
   * would surface as a connection error long after this reported success.
   */
  it("follows the http url's scheme and host", () => {
    expect(deriveWsBaseUrl("https://app.logicpacks.io")).toBe("wss://app.logicpacks.io");
    expect(deriveWsBaseUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000");
  });

  it("declines anything it cannot honestly convert", () => {
    expect(deriveWsBaseUrl("file:///tmp")).toBeNull();
    expect(deriveWsBaseUrl("not a url")).toBeNull();
  });
});

describe("buildEnrollmentEnvironmentRecord", () => {
  it("prefers what the server said over what this app guessed", () => {
    expect(buildEnrollmentEnvironmentRecord(recordInput)).toEqual({
      environmentId: "env-1",
      label: "Atlas",
      httpBaseUrl: "https://app.logicpacks.io",
      wsBaseUrl: "wss://app.logicpacks.io",
      createdAt: "2026-08-20T00:00:00.000Z",
      lastConnectedAt: null,
    });
  });

  it("falls back to the local answers when the server names nothing", () => {
    const record = buildEnrollmentEnvironmentRecord({
      ...recordInput,
      credential: {
        sessionToken: "secret-token",
        environmentId: null,
        label: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      },
    });
    expect(record?.environmentId).toBe("enrolled-abc");
    expect(record?.label).toBe("app.logicpacks.io");
    expect(record?.wsBaseUrl).toBe("wss://app.logicpacks.io");
  });

  it("refuses to build a record around an id the registry could never key on", () => {
    expect(
      buildEnrollmentEnvironmentRecord({
        ...recordInput,
        credential: { ...credential, environmentId: null },
        fallbackEnvironmentId: "   ",
      }),
    ).toBeNull();
  });
});

describe("storeEnrollmentCredential", () => {
  it("registers the machine and stores its token where the app already looks", () => {
    const registryPath = makeTempPath("saved-environments.json");
    const secretStorage = makeSecretStorage(true);
    const record = buildEnrollmentEnvironmentRecord(recordInput);

    expect(hasConnectedEnvironment(registryPath)).toBe(false);

    storeEnrollmentCredential({
      registryPath,
      secretStorage,
      record: record!,
      sessionToken: credential.sessionToken,
    });

    expect(hasConnectedEnvironment(registryPath)).toBe(true);
    expect(readSavedEnvironmentRegistry(registryPath)).toHaveLength(1);
    expect(
      readSavedEnvironmentSecret({ registryPath, environmentId: "env-1", secretStorage }),
    ).toBe("secret-token");
  });

  /*
   * The registry is keyed by id everywhere it is read, so a duplicate makes
   * "which of these two is live" a question with no answer — and only one of
   * them holds a working token.
   */
  it("replaces an earlier enrollment of the same account rather than stacking one beside it", () => {
    const registryPath = makeTempPath("saved-environments.json");
    const secretStorage = makeSecretStorage(true);
    const record = buildEnrollmentEnvironmentRecord(recordInput)!;

    storeEnrollmentCredential({ registryPath, secretStorage, record, sessionToken: "first" });
    storeEnrollmentCredential({ registryPath, secretStorage, record, sessionToken: "second" });

    expect(readSavedEnvironmentRegistry(registryPath)).toHaveLength(1);
    expect(
      readSavedEnvironmentSecret({ registryPath, environmentId: "env-1", secretStorage }),
    ).toBe("second");
  });

  it("leaves other environments alone", () => {
    const registryPath = makeTempPath("saved-environments.json");
    const secretStorage = makeSecretStorage(true);
    writeSavedEnvironmentRegistry(registryPath, [
      {
        environmentId: Schema.decodeUnknownSync(EnvironmentId)("other-env"),
        label: "Laptop",
        httpBaseUrl: "https://other.example",
        wsBaseUrl: "wss://other.example",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);

    storeEnrollmentCredential({
      registryPath,
      secretStorage,
      record: buildEnrollmentEnvironmentRecord(recordInput)!,
      sessionToken: credential.sessionToken,
    });

    expect(readSavedEnvironmentRegistry(registryPath).map((r) => r.environmentId)).toEqual([
      "other-env",
      "env-1",
    ]);
  });

  /*
   * A listed environment with no credential fails every time it is touched and
   * nothing in the UI explains why, so the record is rolled back instead.
   */
  it("changes nothing when the machine cannot store secrets", () => {
    const registryPath = makeTempPath("saved-environments.json");

    expect(() =>
      storeEnrollmentCredential({
        registryPath,
        secretStorage: makeSecretStorage(false),
        record: buildEnrollmentEnvironmentRecord(recordInput)!,
        sessionToken: credential.sessionToken,
      }),
    ).toThrow();

    expect(hasConnectedEnvironment(registryPath)).toBe(false);
  });
});

describe("hasConnectedEnvironment", () => {
  it("reads a machine with no registry at all as not yet connected", () => {
    expect(hasConnectedEnvironment(makeTempPath("missing.json"))).toBe(false);
  });
});
