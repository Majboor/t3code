import type { TenantRuntimeIsolation } from "@t3tools/contracts";
import {
  TENANT_RUNTIME_DIRECTORY_MODE,
  type TenantRuntimeDirectoryLayout,
  deriveTenantRuntimeDirectoryLayout,
  validateTenantRuntimeIsolation,
} from "@t3tools/shared/tenancy";
import { Data, Effect, FileSystem } from "effect";

export class TenantRuntimeProvisioningError extends Data.TaggedError(
  "TenantRuntimeProvisioningError",
)<{
  readonly message: string;
  readonly violations?: readonly string[];
  readonly cause?: unknown;
}> {}

export interface TenantRuntimeProvisioningInput {
  readonly tenantId: string;
  readonly rootDir?: string;
  readonly runId?: string;
}

export const deriveTenantRuntimeProvisioningLayout = deriveTenantRuntimeDirectoryLayout;

export function tenantRuntimeLayoutDirectories(
  layout: TenantRuntimeDirectoryLayout,
): readonly string[] {
  return [
    layout.baseDir,
    layout.dataDir,
    layout.userdataDir,
    layout.secretsDir,
    layout.attachmentsDir,
    layout.worktreesDir,
    layout.runsDir,
    layout.providerHomesDir,
    layout.logsDir,
  ];
}

function tenantRuntimeIsolationDirectories(runtime: TenantRuntimeIsolation): readonly string[] {
  return [
    runtime.baseDir,
    runtime.dataDir,
    runtime.secretsDir,
    runtime.attachmentsDir,
    runtime.worktreesDir,
    runtime.runsDir,
    runtime.providerHomesDir,
  ];
}

export function ensureTenantRuntimeDirectories(
  input: TenantRuntimeProvisioningInput,
): Effect.Effect<
  TenantRuntimeDirectoryLayout,
  TenantRuntimeProvisioningError,
  FileSystem.FileSystem
> {
  const layout = deriveTenantRuntimeProvisioningLayout(input);
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const directory of tenantRuntimeLayoutDirectories(layout)) {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.chmod(directory, TENANT_RUNTIME_DIRECTORY_MODE);
    }
    return layout;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TenantRuntimeProvisioningError({
          message: "Failed to provision tenant runtime directories.",
          cause,
        }),
    ),
  );
}

export function assertTenantRuntimeIsolation(
  runtime: TenantRuntimeIsolation,
): Effect.Effect<void, TenantRuntimeProvisioningError> {
  const validation = validateTenantRuntimeIsolation(runtime);
  if (validation.allowed) {
    return Effect.void;
  }

  return Effect.fail(
    new TenantRuntimeProvisioningError({
      message: "Tenant runtime isolation descriptor is unsafe.",
      violations: validation.violations,
    }),
  );
}

export function provisionTenantRuntimeIsolation(
  runtime: TenantRuntimeIsolation,
): Effect.Effect<void, TenantRuntimeProvisioningError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    yield* assertTenantRuntimeIsolation(runtime);
    const fileSystem = yield* FileSystem.FileSystem;
    for (const directory of tenantRuntimeIsolationDirectories(runtime)) {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.chmod(directory, TENANT_RUNTIME_DIRECTORY_MODE);
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof TenantRuntimeProvisioningError
        ? cause
        : new TenantRuntimeProvisioningError({
            message: "Failed to provision tenant runtime isolation.",
            cause,
          }),
    ),
  );
}
