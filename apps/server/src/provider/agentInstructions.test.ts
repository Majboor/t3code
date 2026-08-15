import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_ROUTE_INSTRUCTIONS,
  PACK_DISCOVERY_INSTRUCTIONS,
  T3_AGENT_INSTRUCTIONS,
} from "./agentInstructions.ts";

describe("T3_AGENT_INSTRUCTIONS", () => {
  it("carries both blocks, so a provider that sends only one fails here", () => {
    expect(T3_AGENT_INSTRUCTIONS).toContain(PACK_DISCOVERY_INSTRUCTIONS);
    expect(T3_AGENT_INSTRUCTIONS).toContain(DEPLOYMENT_ROUTE_INSTRUCTIONS);
  });

  it("looks packs up before it rules on tools", () => {
    expect(T3_AGENT_INSTRUCTIONS.indexOf("<packs>")).toBeLessThan(
      T3_AGENT_INSTRUCTIONS.indexOf("<deployment_tools>"),
    );
  });
});

describe("DEPLOYMENT_ROUTE_INSTRUCTIONS", () => {
  it("names MCP servers and provider plugins as the route not to take", () => {
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("MCP server");
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("provider plugin");
  });

  it("puts a pack ahead of the project's own deploy path", () => {
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS.indexOf("t3 pack search deploy")).toBeLessThan(
      DEPLOYMENT_ROUTE_INSTRUCTIONS.indexOf("The project's own deploy path"),
    );
  });

  it("keeps the escape hatch, so a named tool is still usable", () => {
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("The exception is being asked");
  });

  it("does not forbid reading an already-deployed site", () => {
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("Reading is not publishing");
  });
});
