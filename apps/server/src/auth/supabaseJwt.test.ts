import { expect, it } from "@effect/vitest";
import * as Crypto from "node:crypto";

import {
  fetchSupabaseJwks,
  resolveSupabaseJwksUrl,
  SupabaseJwtError,
  verifySupabaseJwt,
  type SupabaseJwtClaims,
  type SupabaseJwks,
} from "./supabaseJwt.ts";

const PROJECT_URL = "https://project-ref.supabase.co";
const ISSUER = `${PROJECT_URL}/auth/v1`;
const NOW = new Date("2026-05-08T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
type FetchJson = Parameters<typeof fetchSupabaseJwks>[1];

const failedJwksFetch: NonNullable<FetchJson> = async () =>
  new Response("nope", {
    status: 503,
  });

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function defaultClaims(claims?: Partial<SupabaseJwtClaims>): SupabaseJwtClaims {
  return {
    sub: "4d7ecde3-b641-4be2-8d62-0bf345fbfd1d",
    iss: ISSUER,
    aud: "authenticated",
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 30,
    email: "member@example.test",
    role: "authenticated",
    app_metadata: {
      provider: "email",
    },
    user_metadata: {
      name: "Member Example",
    },
    ...claims,
  };
}

function signRs256Jwt(input: {
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
  readonly kid: string;
  readonly claims?: Partial<SupabaseJwtClaims>;
}): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: input.kid,
  };
  const claims = defaultClaims(input.claims);
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = Crypto.createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(input.keyPair.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function signEs256Jwt(input: {
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
  readonly kid: string;
  readonly claims?: Partial<SupabaseJwtClaims>;
}): string {
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: input.kid,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(defaultClaims(input.claims))}`;
  const signature = Crypto.sign("SHA256", Buffer.from(signingInput), {
    key: input.keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

function makeFixture(kid = "test-key"): {
  readonly jwt: string;
  readonly jwks: SupabaseJwks;
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
} {
  const keyPair = Crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  return {
    keyPair,
    jwt: signRs256Jwt({ keyPair, kid }),
    jwks: {
      keys: [
        {
          ...jwk,
          kid,
          alg: "RS256",
          use: "sig",
        },
      ],
    },
  };
}

function makeEs256Fixture(kid = "test-key"): {
  readonly jwt: string;
  readonly jwks: SupabaseJwks;
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
} {
  const keyPair = Crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  return {
    keyPair,
    jwt: signEs256Jwt({ keyPair, kid }),
    jwks: {
      keys: [
        {
          ...jwk,
          kid,
          alg: "ES256",
          use: "sig",
        },
      ],
    },
  };
}

it("verifies a Supabase RS256 JWT against JWKS and returns trusted claims", () => {
  const fixture = makeFixture();

  const claims = verifySupabaseJwt(fixture.jwt, fixture.jwks, {
    projectUrl: PROJECT_URL,
    audience: "authenticated",
    now: () => NOW,
  });

  expect(claims.sub).toBe("4d7ecde3-b641-4be2-8d62-0bf345fbfd1d");
  expect(claims.email).toBe("member@example.test");
  expect(claims.iss).toBe(ISSUER);
});

it("verifies a Supabase ES256 JWT against JWKS and returns trusted claims", () => {
  const fixture = makeEs256Fixture();

  const claims = verifySupabaseJwt(fixture.jwt, fixture.jwks, {
    projectUrl: PROJECT_URL,
    audience: "authenticated",
    now: () => NOW,
  });

  expect(claims.sub).toBe("4d7ecde3-b641-4be2-8d62-0bf345fbfd1d");
  expect(claims.email).toBe("member@example.test");
  expect(claims.iss).toBe(ISSUER);
});

it("rejects a Supabase JWT with an untrusted issuer", () => {
  const fixture = makeFixture();
  const jwt = signRs256Jwt({
    keyPair: fixture.keyPair,
    kid: "test-key",
    claims: {
      iss: "https://attacker.example/auth/v1",
    },
  });

  expect(() =>
    verifySupabaseJwt(jwt, fixture.jwks, {
      projectUrl: PROJECT_URL,
      audience: "authenticated",
      now: () => NOW,
    }),
  ).toThrow("Supabase JWT issuer is not trusted.");
});

it("rejects a Supabase JWT with a mismatched audience", () => {
  const fixture = makeFixture();

  expect(() =>
    verifySupabaseJwt(fixture.jwt, fixture.jwks, {
      projectUrl: PROJECT_URL,
      audience: "service-role",
      now: () => NOW,
    }),
  ).toThrow("Supabase JWT audience is not allowed.");
});

it("rejects expired Supabase JWTs", () => {
  const fixture = makeFixture();
  const jwt = signRs256Jwt({
    keyPair: fixture.keyPair,
    kid: "test-key",
    claims: {
      exp: NOW_SECONDS - 120,
    },
  });

  expect(() =>
    verifySupabaseJwt(jwt, fixture.jwks, {
      projectUrl: PROJECT_URL,
      audience: "authenticated",
      now: () => NOW,
    }),
  ).toThrow("Supabase JWT has expired.");
});

it("rejects Supabase JWTs when no JWKS key matches the token kid", () => {
  const fixture = makeFixture("expected-key");
  const jwt = signRs256Jwt({
    keyPair: fixture.keyPair,
    kid: "missing-key",
  });

  expect(() =>
    verifySupabaseJwt(jwt, fixture.jwks, {
      projectUrl: PROJECT_URL,
      audience: "authenticated",
      now: () => NOW,
    }),
  ).toThrow("No matching Supabase JWKS signing key was found.");
});

it("loads Supabase JWKS from the project auth well-known endpoint", async () => {
  const fixture = makeFixture();
  const fetchCalls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify(fixture.jwks), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const jwks = await fetchSupabaseJwks(`${PROJECT_URL}/`, fetchImpl as FetchJson);

  expect(fetchCalls).toEqual([resolveSupabaseJwksUrl(PROJECT_URL)]);
  expect(jwks.keys[0]?.kid).toBe("test-key");
});

it("turns failed JWKS fetches into auth verifier errors", async () => {
  await expect(fetchSupabaseJwks(PROJECT_URL, failedJwksFetch)).rejects.toMatchObject({
    _tag: "SupabaseJwtError",
    message: "Failed to load Supabase JWKS.",
  } satisfies Partial<SupabaseJwtError>);
});
