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

  // An agent found `.openai/hosting.json` committed to a repo, read the earlier
  // wording as step 2, and shipped through the Sites plugin while reporting it
  // had used the project's own hosting setup. It was following the rule as
  // written, so the rule had to change.
  it("refuses a plugin config committed to the repo as the project's own path", () => {
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain(
      "A config file in the repository does not make it the project's own deploy path",
    );
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain(".openai/hosting.json");
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("is the plugin route");
  });

  it("defines the project's own path by who executes it, not where config lives", () => {
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("meaning one you can run yourself");
    expect(DEPLOYMENT_ROUTE_INSTRUCTIONS).toContain("it is not step 2");
  });

  it("sends the plugin-config case to asking rather than to shipping", () => {
    const clause = DEPLOYMENT_ROUTE_INSTRUCTIONS.slice(
      DEPLOYMENT_ROUTE_INSTRUCTIONS.indexOf("A config file in the repository"),
    );
    expect(clause).toContain("That is step 3");
  });
});
