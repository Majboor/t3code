import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId, TenantRuntimeId } from "@t3tools/contracts";
import { TENANT_RUNTIME_DIRECTORY_MODE } from "@t3tools/shared/tenancy";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  ensureTenantRuntimeDirectories,
  provisionTenantRuntimeIsolation,
  tenantRuntimeLayoutDirectories,
} from "./runtimeProvisioning.ts";

function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe("tenant runtime provisioning", () => {
  it("creates the derived tenant runtime directory layout with restrictive permissions", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-runtime-provisioning-"));
    const layout = await Effect.runPromise(
      ensureTenantRuntimeDirectories({
        tenantId: "tenant:acme",
        rootDir,
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(layout.baseDir).toBe(path.join(rootDir, "acme"));
    for (const directory of tenantRuntimeLayoutDirectories(layout)) {
      expect(fs.existsSync(directory)).toBe(true);
      expect(modeOf(directory)).toBe(TENANT_RUNTIME_DIRECTORY_MODE);
    }
  });

  it("rejects unsafe runtime descriptors before creating escaped directories", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-runtime-unsafe-"));
    const escapedSecretsDir = path.join(rootDir, "..", `escaped-secrets-${path.basename(rootDir)}`);
    const effect = provisionTenantRuntimeIsolation({
      runtimeId: TenantRuntimeId.make("runtime-unsafe"),
      tenantId: TenantId.make("tenant-unsafe"),
      strategy: "systemd-per-tenant",
      linuxUser: "root",
      baseDir: path.join(rootDir, "tenant-unsafe"),
      dataDir: path.join(rootDir, "tenant-unsafe", "data"),
      secretsDir: escapedSecretsDir,
      attachmentsDir: path.join(rootDir, "tenant-unsafe", "data", "userdata", "attachments"),
      worktreesDir: path.join(rootDir, "tenant-unsafe", "worktrees"),
      runsDir: path.join(rootDir, "tenant-unsafe", "runs", "default"),
      providerHomesDir: path.join(rootDir, "tenant-unsafe", "provider-homes"),
      internalHost: "0.0.0.0",
      internalPort: 4473,
      status: "stopped",
      idleShutdownAfterMs: 900_000,
      lastStartedAt: null,
      lastStoppedAt: null,
    }).pipe(Effect.provide(NodeServices.layer));

    await expect(Effect.runPromise(effect)).rejects.toMatchObject({
      _tag: "TenantRuntimeProvisioningError",
      message: "Tenant runtime isolation descriptor is unsafe.",
      violations: expect.arrayContaining([
        "Tenant runtime must not run as root.",
        "Tenant runtime host must be loopback or private-network only.",
        "secretsDir must stay inside the tenant base directory.",
      ]),
    });
    expect(fs.existsSync(escapedSecretsDir)).toBe(false);
  });
});
