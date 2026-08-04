import { describe, expect, it } from "vitest";

import { deriveWebSocketUrl } from "./auth.ts";

describe("deriveWebSocketUrl", () => {
  it("upgrades http to ws and attaches the token on the /ws path", () => {
    const url = new URL(deriveWebSocketUrl("http://127.0.0.1:13773", "token-123"));

    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("127.0.0.1:13773");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("wsToken")).toBe("token-123");
  });

  it("upgrades https to wss", () => {
    const url = new URL(deriveWebSocketUrl("https://t3.example.com", "token-123"));

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/ws");
  });

  it("discards any path or query already present on the base url", () => {
    const url = new URL(deriveWebSocketUrl("http://127.0.0.1:13773/app?foo=bar", "token-123"));

    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("foo")).toBeNull();
    expect(url.searchParams.get("wsToken")).toBe("token-123");
  });

  it("percent-encodes tokens so they survive the query string", () => {
    const url = new URL(deriveWebSocketUrl("http://127.0.0.1:13773", "a b&c=d"));

    expect(url.searchParams.get("wsToken")).toBe("a b&c=d");
  });
});
