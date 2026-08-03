import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ServerAuthDescriptor } from "./auth.ts";

const decodeServerAuthDescriptor = Schema.decodeUnknownSync(ServerAuthDescriptor);

describe("auth contracts", () => {
  it("validates public Supabase auth descriptor config", () => {
    const descriptor = decodeServerAuthDescriptor({
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
      supabase: {
        projectUrl: "https://project-ref.supabase.co/",
        anonKey: "anon-public-key",
        audience: "authenticated",
      },
    });

    expect(descriptor.supabase).toEqual({
      projectUrl: "https://project-ref.supabase.co/",
      anonKey: "anon-public-key",
      audience: "authenticated",
    });
  });
});
