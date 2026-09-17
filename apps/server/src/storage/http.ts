import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import { AuthError, resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { ServerConfig } from "../config.ts";

const execFileAsync = promisify(execFile);

/**
 * No plan/tier system exists on the LogicPacks side yet (the gateway's
 * Free/Starter/Pro/Max plans are a separate product's billing concept) --
 * everyone gets the same default for now. Revisit once LogicPacks has its
 * own tenant billing tiers.
 */
const DEFAULT_STORAGE_ALLOCATION_BYTES = 1_073_741_824; // 1 GiB

/**
 * Counts a user's own project data and worktrees against their quota --
 * deliberately excludes provider-homes (credentials, not user data) and logs
 * (operational, not user data).
 */
const usedBytesForUser = (userId: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const tenancyRepository = yield* TenancyRepository;
    const [organizations, collaboration] = yield* Effect.all([
      tenancyRepository.loadOrganizations(),
      tenancyRepository.loadCollaboration(),
    ]).pipe(
      Effect.mapError(
        (cause) => new AuthError({ message: "Failed to load tenant memberships.", status: 500, cause }),
      ),
    );
    const membership = [...organizations.memberships, ...collaboration.memberships].find(
      (m) => m.userId === userId && m.disabledAt === null,
    );
    if (!membership) {
      return 0;
    }
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: membership.tenantId,
      rootDir: path.join(config.baseDir, "tenant-runtimes"),
    });
    const targets = [layout.dataDir, layout.worktreesDir];
    const total = yield* Effect.tryPromise({
      try: async () => {
        let sum = 0;
        for (const target of targets) {
          try {
            const { stdout } = await execFileAsync("du", ["-sk", target]);
            const kb = Number.parseInt(stdout.split("\t")[0] ?? "0", 10);
            if (Number.isFinite(kb)) sum += kb * 1024;
          } catch {
            // Directory doesn't exist yet (no projects created) -- 0 bytes, not an error.
          }
        }
        return sum;
      },
      catch: (cause) => new AuthError({ message: "Failed to compute storage usage.", status: 500, cause }),
    });
    return total;
  });

export const storageUsageRouteLayer = HttpRouter.add(
  "GET",
  "/api/storage/usage",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const usedBytes = yield* usedBytesForUser(resolveAuthenticatedUserId(session));
    return HttpServerResponse.jsonUnsafe(
      { used_bytes: usedBytes, allocated_bytes: DEFAULT_STORAGE_ALLOCATION_BYTES },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
