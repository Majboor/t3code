import { expect, it } from "@effect/vitest";

import {
  authenticateSupabaseBearerTokenWithRemoteJwks,
  readSupabaseActiveWorkspaceIdClaim,
  readSupabaseTenantIdClaim,
} from "./supabaseAuthBridge.ts";

const liveProjectUrl = process.env.T3CODE_SUPABASE_PROJECT_URL?.trim();
const liveAnonKey = process.env.T3CODE_SUPABASE_ANON_KEY?.trim();
const liveAudience = process.env.T3CODE_SUPABASE_JWT_AUDIENCE?.trim() || "authenticated";
const liveSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

const hasLiveSupabaseEnv = Boolean(liveProjectUrl && liveAnonKey && liveSecretKey);

type JsonRecord = Record<string, unknown>;

function makeLiveEmail(): string {
  return `t3-live-${Date.now()}-${Math.random().toString(36).slice(2)}@majboor.com`;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

async function readJson(response: Response): Promise<JsonRecord> {
  return (await response.json().catch(() => ({}))) as JsonRecord;
}

async function requestSupabaseJson(input: {
  readonly path: string;
  readonly key: string;
  readonly body?: unknown;
  readonly method?: string;
  readonly bearer?: string;
}): Promise<JsonRecord> {
  const response = await fetch(new URL(input.path, liveProjectUrl).toString(), {
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    headers: {
      apikey: input.key,
      ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const detail =
      typeof body.msg === "string"
        ? body.msg
        : typeof body.error_description === "string"
          ? body.error_description
          : typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
    throw new Error(`Supabase live request failed for ${input.path}: ${detail}`);
  }
  return body;
}

it.skipIf(!hasLiveSupabaseEnv)(
  "signs in and refreshes a real Supabase user before verifying the JWT against remote JWKS",
  async () => {
    const email = makeLiveEmail();
    const password = `T3-live-password-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let userId: string | undefined;

    try {
      const created = await requestSupabaseJson({
        path: "/auth/v1/admin/users",
        key: liveSecretKey!,
        bearer: liveSecretKey!,
        body: {
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: "T3 Live Supabase User",
            tenant_id: "tenant-live-supabase",
            active_workspace_id: "workspace-live-supabase",
          },
        },
      });
      userId = requireString(created.id, "Supabase admin create did not return a user id.");

      const signedIn = await requestSupabaseJson({
        path: "/auth/v1/token?grant_type=password",
        key: liveAnonKey!,
        body: { email, password },
      });
      const accessToken = requireString(
        signedIn.access_token,
        "Supabase password login did not return an access token.",
      );
      const refreshToken = requireString(
        signedIn.refresh_token,
        "Supabase password login did not return a refresh token.",
      );

      const identity = await authenticateSupabaseBearerTokenWithRemoteJwks({
        token: accessToken,
        config: {
          projectUrl: liveProjectUrl!,
          audience: liveAudience,
          anonKey: liveAnonKey!,
          serviceRoleSecretName: "supabase/service-role",
        },
      });

      expect(identity.subject).toBe(userId);
      expect(identity.email).toBe(email);
      expect(identity.displayName).toBe("T3 Live Supabase User");
      expect(readSupabaseTenantIdClaim(identity.claims)).toBe("tenant-live-supabase");
      expect(readSupabaseActiveWorkspaceIdClaim(identity.claims)).toBe("workspace-live-supabase");

      const refreshed = await requestSupabaseJson({
        path: "/auth/v1/token?grant_type=refresh_token",
        key: liveAnonKey!,
        body: { refresh_token: refreshToken },
      });
      const refreshedAccessToken = requireString(
        refreshed.access_token,
        "Supabase refresh did not return an access token.",
      );
      await expect(
        authenticateSupabaseBearerTokenWithRemoteJwks({
          token: refreshedAccessToken,
          config: {
            projectUrl: liveProjectUrl!,
            audience: liveAudience,
            anonKey: liveAnonKey!,
            serviceRoleSecretName: "supabase/service-role",
          },
        }),
      ).resolves.toMatchObject({
        subject: userId,
        email,
      });
    } finally {
      if (userId) {
        await requestSupabaseJson({
          path: `/auth/v1/admin/users/${userId}`,
          key: liveSecretKey!,
          bearer: liveSecretKey!,
          method: "DELETE",
        });
      }
    }
  },
);
