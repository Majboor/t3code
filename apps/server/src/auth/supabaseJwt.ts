import { Data } from "effect";
import * as Crypto from "node:crypto";

type JsonPrimitive = boolean | number | string | null;
export type JsonObject = {
  readonly [key: string]: JsonPrimitive | JsonObject | readonly (JsonPrimitive | JsonObject)[];
};

type PublicJsonWebKey = {
  readonly kty?: string;
  readonly use?: string;
  readonly key_ops?: readonly string[];
  readonly alg?: string;
  readonly kid?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
};

export type SupabaseJwtClaims = {
  readonly sub: string;
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly email?: string;
  readonly phone?: string;
  readonly role?: string;
  readonly app_metadata?: JsonObject;
  readonly user_metadata?: JsonObject;
  readonly [claim: string]: unknown;
};

export type SupabaseJwksKey = PublicJsonWebKey & {
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
};

export type SupabaseJwks = {
  readonly keys: readonly SupabaseJwksKey[];
};

export type SupabaseJwtVerifierConfig = {
  readonly projectUrl: string;
  readonly audience?: string | readonly string[];
  readonly now?: () => Date;
  readonly clockSkewSeconds?: number;
};

type FetchJson = (
  input: string | URL,
  init?: {
    readonly headers?: Record<string, string>;
  },
) => Promise<Response>;

export class SupabaseJwtError extends Data.TaggedError("SupabaseJwtError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 500;
  readonly cause?: unknown;
}> {}

const SUPPORTED_ALGORITHMS = new Set(["RS256", "ES256"]);

function base64UrlDecodeJson(value: string): unknown {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(decoded) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProjectUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function expectedIssuer(projectUrl: string): string {
  return `${normalizeProjectUrl(projectUrl)}/auth/v1`;
}

export function resolveSupabaseJwksUrl(projectUrl: string): string {
  return `${expectedIssuer(projectUrl)}/.well-known/jwks.json`;
}

function decodeJwt(jwt: string): {
  readonly header: Record<string, unknown>;
  readonly claims: SupabaseJwtClaims;
  readonly signingInput: string;
  readonly signature: Buffer;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new SupabaseJwtError({
      message: "Invalid Supabase JWT format.",
      status: 401,
    });
  }

  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = base64UrlDecodeJson(encodedHeader);
  const claims = base64UrlDecodeJson(encodedClaims);
  if (!isRecord(header) || !isRecord(claims) || typeof claims.sub !== "string") {
    throw new SupabaseJwtError({
      message: "Invalid Supabase JWT payload.",
      status: 401,
    });
  }

  return {
    header,
    claims: claims as SupabaseJwtClaims,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function assertAudience(
  claims: SupabaseJwtClaims,
  expected: string | readonly string[] | undefined,
) {
  if (!expected) {
    return;
  }
  const expectedAudiences = Array.isArray(expected) ? expected : [expected];
  const claimAudiences =
    typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!claimAudiences.some((audience) => expectedAudiences.includes(audience))) {
    throw new SupabaseJwtError({
      message: "Supabase JWT audience is not allowed.",
      status: 401,
    });
  }
}

function assertTemporalClaims(input: {
  readonly claims: SupabaseJwtClaims;
  readonly now: Date;
  readonly clockSkewSeconds: number;
}) {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (
    typeof input.claims.exp === "number" &&
    input.claims.exp + input.clockSkewSeconds < nowSeconds
  ) {
    throw new SupabaseJwtError({
      message: "Supabase JWT has expired.",
      status: 401,
    });
  }
  if (
    typeof input.claims.nbf === "number" &&
    input.claims.nbf - input.clockSkewSeconds > nowSeconds
  ) {
    throw new SupabaseJwtError({
      message: "Supabase JWT is not valid yet.",
      status: 401,
    });
  }
}

function findJwksKey(input: {
  readonly jwks: SupabaseJwks;
  readonly kid: string | undefined;
  readonly alg: string;
}): SupabaseJwksKey {
  const key = input.jwks.keys.find((candidate) => {
    const kidMatches = input.kid ? candidate.kid === input.kid : true;
    const algMatches = candidate.alg ? candidate.alg === input.alg : true;
    const useMatches = !candidate.use || candidate.use === "sig";
    return kidMatches && algMatches && useMatches;
  });
  if (!key) {
    throw new SupabaseJwtError({
      message: "No matching Supabase JWKS signing key was found.",
      status: 401,
    });
  }
  return key;
}

function trimLeadingZeroes(value: Buffer): Buffer {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) {
    offset += 1;
  }
  return value.subarray(offset);
}

function encodeDerLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeDerInteger(value: Buffer): Buffer {
  const trimmed = trimLeadingZeroes(value);
  const normalized =
    (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return Buffer.concat([Buffer.from([0x02]), encodeDerLength(normalized.length), normalized]);
}

function encodeDerSequence(parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), encodeDerLength(body.length), body]);
}

function convertEs256JoseSignatureToDer(signature: Buffer): Buffer {
  if (signature.length !== 64) {
    throw new SupabaseJwtError({
      message: "Invalid Supabase ES256 JWT signature length.",
      status: 401,
    });
  }
  return encodeDerSequence([
    encodeDerInteger(signature.subarray(0, 32)),
    encodeDerInteger(signature.subarray(32)),
  ]);
}

function verifyJwtSignature(input: {
  readonly alg: string;
  readonly jwk: SupabaseJwksKey;
  readonly signingInput: string;
  readonly signature: Buffer;
}) {
  const algorithm = input.alg === "RS256" ? "RSA-SHA256" : "SHA256";
  const signature =
    input.alg === "ES256" ? convertEs256JoseSignatureToDer(input.signature) : input.signature;
  const publicKey = Crypto.createPublicKey({
    key: input.jwk,
    format: "jwk",
  });
  const verifier = Crypto.createVerify(algorithm);
  verifier.update(input.signingInput);
  verifier.end();
  if (!verifier.verify(publicKey, signature)) {
    throw new SupabaseJwtError({
      message: "Supabase JWT signature is invalid.",
      status: 401,
    });
  }
}

export function verifySupabaseJwt(
  jwt: string,
  jwks: SupabaseJwks,
  config: SupabaseJwtVerifierConfig,
): SupabaseJwtClaims {
  const decoded = decodeJwt(jwt);
  const alg = typeof decoded.header.alg === "string" ? decoded.header.alg : undefined;
  if (!alg || !SUPPORTED_ALGORITHMS.has(alg)) {
    throw new SupabaseJwtError({
      message: "Unsupported Supabase JWT signing algorithm.",
      status: 401,
    });
  }

  const issuer = expectedIssuer(config.projectUrl);
  if (decoded.claims.iss !== issuer) {
    throw new SupabaseJwtError({
      message: "Supabase JWT issuer is not trusted.",
      status: 401,
    });
  }
  assertAudience(decoded.claims, config.audience);
  assertTemporalClaims({
    claims: decoded.claims,
    now: config.now?.() ?? new Date(),
    clockSkewSeconds: config.clockSkewSeconds ?? 30,
  });

  const jwk = findJwksKey({
    jwks,
    kid: typeof decoded.header.kid === "string" ? decoded.header.kid : undefined,
    alg,
  });
  verifyJwtSignature({
    alg,
    jwk,
    signingInput: decoded.signingInput,
    signature: decoded.signature,
  });
  return decoded.claims;
}

export async function fetchSupabaseJwks(
  projectUrl: string,
  fetchImpl: FetchJson = fetch,
): Promise<SupabaseJwks> {
  const response = await fetchImpl(resolveSupabaseJwksUrl(projectUrl), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new SupabaseJwtError({
      message: "Failed to load Supabase JWKS.",
      status: 500,
      cause: new Error(`JWKS request failed with HTTP ${response.status}.`),
    });
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    throw new SupabaseJwtError({
      message: "Supabase JWKS response is invalid.",
      status: 500,
    });
  }
  return body as SupabaseJwks;
}
