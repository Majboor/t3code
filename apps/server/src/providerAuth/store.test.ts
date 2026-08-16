import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearProviderCredential,
  codexHomeFor,
  createProviderAccount,
  isProviderConnected,
  listProviderAccounts,
  providerAuthUserDir,
  providerCredentialEnv,
  providerCredentialEnvForAccount,
  readClaudeToken,
  resolveDefaultProviderAccountId,
  setDefaultProviderAccount,
  setProviderAccountLabel,
  writeClaudeToken,
} from "./store.ts";

const stateDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "provider-auth-store-"));
  stateDirs.push(dir);
  return dir;
}

/** Writes the pre-multi-account layout by hand: exactly what prod has on disk. */
async function seedLegacyCodex(stateDir: string, userId: string): Promise<string> {
  const legacyHome = path.join(providerAuthUserDir(stateDir, userId), "codex");
  await mkdir(legacyHome, { recursive: true, mode: 0o700 });
  await writeFile(path.join(legacyHome, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");
  return legacyHome;
}

async function seedLegacyClaude(stateDir: string, userId: string, token: string): Promise<string> {
  const legacyDir = path.join(providerAuthUserDir(stateDir, userId), "claude");
  await mkdir(legacyDir, { recursive: true, mode: 0o700 });
  const target = path.join(legacyDir, "oauth-token");
  await writeFile(target, token, { encoding: "utf8", mode: 0o600 });
  return target;
}

afterEach(async () => {
  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { recursive: true, force: true });
  }
});

describe("legacy adoption", () => {
  it("still resolves a launch environment for a user who only has the old layout", async () => {
    const stateDir = await makeStateDir();
    const legacyHome = await seedLegacyCodex(stateDir, "auth:legacy-user");
    const legacyToken = await seedLegacyClaude(stateDir, "auth:legacy-user", "sk-ant-legacy");

    await expect(isProviderConnected(stateDir, "auth:legacy-user", "codex")).resolves.toBe(true);
    await expect(isProviderConnected(stateDir, "auth:legacy-user", "claude")).resolves.toBe(true);

    const codexEnv = await providerCredentialEnv(stateDir, "auth:legacy-user", "codex");
    expect(codexEnv).toEqual({
      HOME: providerAuthUserDir(stateDir, "auth:legacy-user"),
      CODEX_HOME: legacyHome,
    });

    const claudeEnv = await providerCredentialEnv(stateDir, "auth:legacy-user", "claude");
    expect(claudeEnv).toEqual({
      HOME: providerAuthUserDir(stateDir, "auth:legacy-user"),
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-legacy",
    });

    // Nothing may have been moved out from under them.
    await expect(readFile(legacyToken, "utf8")).resolves.toBe("sk-ant-legacy");
  });

  it("lists the adopted credential as the default account", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:legacy-user", "sk-ant-legacy");

    const accounts = await listProviderAccounts(stateDir, "auth:legacy-user", "claude");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      accountId: "default",
      provider: "claude",
      isDefault: true,
      connected: true,
    });
  });

  it("lists nothing for a provider that was never connected", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:legacy-user", "sk-ant-legacy");

    await expect(listProviderAccounts(stateDir, "auth:legacy-user", "codex")).resolves.toEqual([]);
    await expect(listProviderAccounts(stateDir, "auth:legacy-user")).resolves.toHaveLength(1);
  });

  it("leaves the legacy file in place across a second account and a default switch", async () => {
    const stateDir = await makeStateDir();
    const legacyToken = await seedLegacyClaude(stateDir, "auth:legacy-user", "sk-ant-legacy");

    const second = await createProviderAccount(stateDir, "auth:legacy-user", "claude", "Work");
    await writeClaudeToken(stateDir, "auth:legacy-user", "sk-ant-second", second);
    await setDefaultProviderAccount(stateDir, "auth:legacy-user", "claude", second);

    await expect(readFile(legacyToken, "utf8")).resolves.toBe("sk-ant-legacy");
    await expect(readClaudeToken(stateDir, "auth:legacy-user", "default")).resolves.toBe(
      "sk-ant-legacy",
    );
  });

  it("keeps writing the default account to the legacy path so a re-login cannot fork", async () => {
    const stateDir = await makeStateDir();
    await writeClaudeToken(stateDir, "auth:fresh-user", "sk-ant-fresh");

    const legacy = path.join(
      providerAuthUserDir(stateDir, "auth:fresh-user"),
      "claude",
      "oauth-token",
    );
    await expect(readFile(legacy, "utf8")).resolves.toBe("sk-ant-fresh");
    await expect(readClaudeToken(stateDir, "auth:fresh-user")).resolves.toBe("sk-ant-fresh");
  });
});

describe("multiple accounts", () => {
  it("adds, lists and labels a second account", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:multi", "sk-ant-first");

    const second = await createProviderAccount(stateDir, "auth:multi", "claude");
    await writeClaudeToken(stateDir, "auth:multi", "sk-ant-second", second);

    const accounts = await listProviderAccounts(stateDir, "auth:multi", "claude");
    expect(accounts.map((account) => account.accountId)).toEqual(["default", second]);
    expect(accounts.every((account) => account.connected)).toBe(true);
    // `claude setup-token` returns no identity at all, so position is the only
    // honest label until somebody supplies one.
    expect(accounts[1]?.label).toBe("Claude account 2");

    await setProviderAccountLabel(stateDir, "auth:multi", "claude", second, "Client work");
    const relabelled = await listProviderAccounts(stateDir, "auth:multi", "claude");
    expect(relabelled[1]?.label).toBe("Client work");

    await expect(readClaudeToken(stateDir, "auth:multi", second)).resolves.toBe("sk-ant-second");
    await expect(readClaudeToken(stateDir, "auth:multi", "default")).resolves.toBe("sk-ant-first");
  });

  it("gives each Codex account its own CODEX_HOME", async () => {
    const stateDir = await makeStateDir();
    const legacyHome = await seedLegacyCodex(stateDir, "auth:multi");

    const second = await createProviderAccount(stateDir, "auth:multi", "codex");
    const secondHome = codexHomeFor(stateDir, "auth:multi", second);
    expect(secondHome).not.toBe(legacyHome);
    expect(secondHome).toBe(
      path.join(providerAuthUserDir(stateDir, "auth:multi"), "codex", "accounts", second),
    );

    await writeFile(path.join(secondHome, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");
    await expect(isProviderConnected(stateDir, "auth:multi", "codex", second)).resolves.toBe(true);
  });

  it("labels a Codex account with the email in its auth.json", async () => {
    const stateDir = await makeStateDir();
    const home = path.join(providerAuthUserDir(stateDir, "auth:codex"), "codex");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const claims = Buffer.from(JSON.stringify({ email: "person@example.com" })).toString(
      "base64url",
    );
    await writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ tokens: { id_token: `header.${claims}.signature` } }),
      "utf8",
    );

    const accounts = await listProviderAccounts(stateDir, "auth:codex", "codex");
    expect(accounts[0]?.label).toBe("person@example.com");
  });

  it("never fails a listing because a label could not be derived", async () => {
    const stateDir = await makeStateDir();
    const home = path.join(providerAuthUserDir(stateDir, "auth:garbled"), "codex");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, "auth.json"), "not json at all", "utf8");

    const accounts = await listProviderAccounts(stateDir, "auth:garbled", "codex");
    expect(accounts[0]?.label).toBe("Codex account 1");
  });

  it("survives a corrupt meta.json by falling back to the adopted account", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:corrupt", "sk-ant-legacy");
    await writeFile(
      path.join(providerAuthUserDir(stateDir, "auth:corrupt"), "claude", "meta.json"),
      "{ this is not json",
      "utf8",
    );

    await expect(resolveDefaultProviderAccountId(stateDir, "auth:corrupt", "claude")).resolves.toBe(
      "default",
    );
    await expect(readClaudeToken(stateDir, "auth:corrupt")).resolves.toBe("sk-ant-legacy");
  });
});

describe("default selection", () => {
  it("runs turns on the nominated account", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:choosy", "sk-ant-first");
    const second = await createProviderAccount(stateDir, "auth:choosy", "claude");
    await writeClaudeToken(stateDir, "auth:choosy", "sk-ant-second", second);

    await expect(providerCredentialEnv(stateDir, "auth:choosy", "claude")).resolves.toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-first",
    });

    await setDefaultProviderAccount(stateDir, "auth:choosy", "claude", second);
    await expect(resolveDefaultProviderAccountId(stateDir, "auth:choosy", "claude")).resolves.toBe(
      second,
    );
    await expect(providerCredentialEnv(stateDir, "auth:choosy", "claude")).resolves.toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-second",
    });

    const accounts = await listProviderAccounts(stateDir, "auth:choosy", "claude");
    expect(accounts.filter((account) => account.isDefault).map((a) => a.accountId)).toEqual([
      second,
    ]);
  });

  it("falls through to a connected account when the nominated one is logged out", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:lapsed", "sk-ant-first");
    const second = await createProviderAccount(stateDir, "auth:lapsed", "claude");
    await writeClaudeToken(stateDir, "auth:lapsed", "sk-ant-second", second);
    await setDefaultProviderAccount(stateDir, "auth:lapsed", "claude", second);

    await clearProviderCredential(stateDir, "auth:lapsed", "claude", second);

    await expect(providerCredentialEnv(stateDir, "auth:lapsed", "claude")).resolves.toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-first",
    });
  });

  it("makes the first account of a never-connected provider the default", async () => {
    const stateDir = await makeStateDir();
    const only = await createProviderAccount(stateDir, "auth:new", "claude", "Personal");
    await writeClaudeToken(stateDir, "auth:new", "sk-ant-only", only);

    await expect(resolveDefaultProviderAccountId(stateDir, "auth:new", "claude")).resolves.toBe(
      only,
    );
    await expect(providerCredentialEnv(stateDir, "auth:new", "claude")).resolves.toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-only",
    });
  });

  it("refuses rather than falls back when nothing is connected", async () => {
    const stateDir = await makeStateDir();
    await expect(providerCredentialEnv(stateDir, "auth:nobody", "claude")).resolves.toBeNull();
    await expect(providerCredentialEnv(stateDir, "auth:nobody", "codex")).resolves.toBeNull();
  });

  it("reports disconnected once the credential is cleared", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:leaving", "sk-ant-legacy");
    await clearProviderCredential(stateDir, "auth:leaving", "claude");

    await expect(isProviderConnected(stateDir, "auth:leaving", "claude")).resolves.toBe(false);
    await expect(providerCredentialEnv(stateDir, "auth:leaving", "claude")).resolves.toBeNull();
  });
});

describe("account ids as path segments", () => {
  const hostile = ["../other", "..", "a/b", "", ".hidden", "x\\y"];

  it("refuses to resolve an environment for a traversing account id", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:victim", "sk-ant-legacy");

    for (const accountId of hostile) {
      await expect(
        providerCredentialEnvForAccount(stateDir, "auth:victim", "claude", accountId),
      ).resolves.toBeNull();
      await expect(isProviderConnected(stateDir, "auth:victim", "claude", accountId)).resolves.toBe(
        false,
      );
      await expect(readClaudeToken(stateDir, "auth:victim", accountId)).resolves.toBeNull();
    }
  });

  it("throws rather than writing anywhere for a traversing account id", async () => {
    const stateDir = await makeStateDir();

    for (const accountId of hostile) {
      expect(() => codexHomeFor(stateDir, "auth:victim", accountId)).toThrow(
        /Invalid provider account id/,
      );
      await expect(
        setDefaultProviderAccount(stateDir, "auth:victim", "claude", accountId),
      ).rejects.toThrow(/Invalid provider account id/);
      await expect(
        writeClaudeToken(stateDir, "auth:victim", "sk-ant-nope", accountId),
      ).rejects.toThrow(/Invalid provider account id/);
    }
  });

  it("refuses to nominate an account that was never created", async () => {
    const stateDir = await makeStateDir();
    await expect(
      setDefaultProviderAccount(stateDir, "auth:victim", "claude", "deadbeefdeadbeef"),
    ).rejects.toThrow(/Unknown claude account/);
  });

  it("generates ids that are safe path segments", async () => {
    const stateDir = await makeStateDir();
    const accountId = await createProviderAccount(stateDir, "auth:gen", "codex");
    expect(accountId).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("shared accounts", () => {
  it("points a shared turn at the owner's directories, not the borrower's", async () => {
    const stateDir = await makeStateDir();
    const ownerHome = await seedLegacyCodex(stateDir, "auth:owner");
    const shared = await createProviderAccount(stateDir, "auth:owner", "codex", "Team");
    const sharedHome = codexHomeFor(stateDir, "auth:owner", shared);
    await writeFile(path.join(sharedHome, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");

    const env = await providerCredentialEnvForAccount(stateDir, "auth:owner", "codex", shared);
    expect(env).toEqual({
      HOME: providerAuthUserDir(stateDir, "auth:owner"),
      CODEX_HOME: sharedHome,
    });
    // The borrower has nothing of their own and must not acquire anything.
    expect(env?.HOME).not.toBe(providerAuthUserDir(stateDir, "auth:borrower"));
    expect(env?.CODEX_HOME).not.toBe(ownerHome);
    await expect(providerCredentialEnv(stateDir, "auth:borrower", "codex")).resolves.toBeNull();
  });

  it("hands out the owner's Claude token for the owner's named account", async () => {
    const stateDir = await makeStateDir();
    await seedLegacyClaude(stateDir, "auth:owner", "sk-ant-owner-default");
    const shared = await createProviderAccount(stateDir, "auth:owner", "claude", "Team");
    await writeClaudeToken(stateDir, "auth:owner", "sk-ant-owner-shared", shared);

    await expect(
      providerCredentialEnvForAccount(stateDir, "auth:owner", "claude", shared),
    ).resolves.toEqual({
      HOME: providerAuthUserDir(stateDir, "auth:owner"),
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-owner-shared",
    });
  });

  it("returns null for an account the owner never connected", async () => {
    const stateDir = await makeStateDir();
    const reserved = await createProviderAccount(stateDir, "auth:owner", "claude");
    await expect(
      providerCredentialEnvForAccount(stateDir, "auth:owner", "claude", reserved),
    ).resolves.toBeNull();
  });
});
