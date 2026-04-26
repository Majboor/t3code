import { timingSafeEqual } from "node:crypto";

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";

const BASIC_AUTH_PREFIX = "Basic ";

function isBasicAuthEnabled(config: {
  readonly basicAuthUsername: string | undefined;
  readonly basicAuthPassword: string | undefined;
}) {
  return config.basicAuthUsername !== undefined && config.basicAuthPassword !== undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthorization(header: string | undefined) {
  if (typeof header !== "string" || !header.startsWith(BASIC_AUTH_PREFIX)) {
    return null;
  }

  const encoded = header.slice(BASIC_AUTH_PREFIX.length).trim();
  if (encoded.length === 0) return null;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) return null;
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function unauthorizedResponse(realm: string) {
  const escapedRealm = realm.replace(/["\\]/g, "\\$&");
  return HttpServerResponse.text("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${escapedRealm}", charset="UTF-8"`,
      "Cache-Control": "no-store",
    },
  });
}

export const basicAuthMiddlewareLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (!isBasicAuthEnabled(config)) {
      return (httpEffect) => httpEffect;
    }

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const credentials = parseBasicAuthorization(request.headers.authorization);
        if (
          credentials &&
          safeEqual(credentials.username, config.basicAuthUsername ?? "") &&
          safeEqual(credentials.password, config.basicAuthPassword ?? "")
        ) {
          return yield* httpEffect;
        }

        return unauthorizedResponse(config.basicAuthRealm);
      });
  }),
  { global: true },
);
