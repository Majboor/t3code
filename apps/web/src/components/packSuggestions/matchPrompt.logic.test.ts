import { describe, expect, it } from "vitest";

import {
  promptMentionFor,
  suggestPacks,
  tokenize,
  withPackMention,
  type SuggestablePack,
} from "./matchPrompt.logic";

const deployPack: SuggestablePack = {
  id: "pack-ssh-deploy",
  name: "ssh-deploy",
  qualified: "t3demo/ssh-deploy@1.0.2",
  summary: "Ships a project to a host over SSH and keeps it running.",
  capabilities: ["deploy"],
};

const analyticsPack: SuggestablePack = {
  id: "pack-analytics-core",
  name: "analytics-core",
  qualified: "t3demo/analytics-core@1.0.0",
  summary: "Declares event streams and answers questions about them.",
  capabilities: ["analytics"],
};

const mailPack: SuggestablePack = {
  id: "pack-mail",
  name: "gmail-apps-script-mail",
  qualified: "t3demo/gmail-apps-script-mail@1.0.0",
  summary: "Sends mail through an Apps Script endpoint.",
  capabilities: ["email"],
};

const ALL = [deployPack, analyticsPack, mailPack];

describe("tokenize", () => {
  it("drops words too short to mean anything", () => {
    expect(tokenize("I want to do it")).toEqual(["want"]);
  });

  it("splits on punctuation, so trailing commas do not hide a word", () => {
    expect(tokenize("deploy, please")).toContain("deploy");
  });
});

describe("suggestPacks", () => {
  it("suggests nothing for an empty prompt", () => {
    expect(suggestPacks("   ", ALL)).toEqual([]);
  });

  it("finds the deploy pack from the word deploy", () => {
    const [first] = suggestPacks("Deploy todo.py to a server", ALL);
    expect(first?.pack.name).toBe("ssh-deploy");
  });

  it("finds it from a synonym nobody declared, like ship or host", () => {
    expect(suggestPacks("can you ship this to a host", ALL)[0]?.pack.name).toBe("ssh-deploy");
  });

  it("stays quiet when the prompt is about something else entirely", () => {
    // The failure that matters: a bar that suggests something every time is a
    // bar people stop reading.
    expect(suggestPacks("rename this variable and tidy the imports", ALL)).toEqual([]);
  });

  it("does not fire on one synonym used to mean something else", () => {
    // A real false positive this caught: "tracking" is an analytics synonym,
    // and on its own it used to be enough to suggest the pack.
    expect(suggestPacks("the shipment tracking number is wrong", ALL)).toEqual([]);
  });

  it("ranks the pack whose capability was named above one matched by prose", () => {
    const results = suggestPacks("add analytics events to the dashboard", ALL);
    expect(results[0]?.pack.name).toBe("analytics-core");
  });

  it("says which words matched, so the bar can explain itself", () => {
    const [first] = suggestPacks("deploy this", ALL);
    expect(first?.matched).toContain("deploy");
  });

  it("keeps the list short rather than listing everything plausible", () => {
    expect(suggestPacks("deploy and publish and host and ship", ALL, { limit: 2 }).length).toBe(1);
  });

  it("finds a pack by its own name", () => {
    expect(suggestPacks("use ssh-deploy here", ALL)[0]?.pack.name).toBe("ssh-deploy");
  });

  it("does not offer a pack because its prose happens to share a word", () => {
    // The regression this caught: capability-summary words were scored as
    // declared capabilities, so "Create a file named x" offered a PDF pack.
    const pdf: SuggestablePack = {
      id: "pack-pdf",
      name: "pdf-delivery",
      qualified: "t3demo/pdf-delivery@0.1.0",
      summary: "Renders a PDF from code, serves it over HTTP, and reports reading time.",
      capabilities: ["document"],
    };
    expect(suggestPacks("Create a file named blocked.txt", [pdf, ...ALL])).toEqual([]);
  });

  it("suggests the mail pack for send-an-email wording", () => {
    expect(suggestPacks("send an email to the team", ALL)[0]?.pack.name).toBe(
      "gmail-apps-script-mail",
    );
  });
});

describe("withPackMention", () => {
  it("points the agent at the pack instead of pasting its contents", () => {
    const mention = promptMentionFor(deployPack);
    expect(mention).toContain("t3 pack show ssh-deploy");
    expect(mention).toContain("t3demo/ssh-deploy@1.0.2");
  });

  it("leaves what somebody already wrote intact", () => {
    const result = withPackMention("Deploy todo.py", deployPack);
    expect(result.startsWith("Deploy todo.py")).toBe(true);
    expect(result).toContain("t3 pack show ssh-deploy");
  });

  it("does not add the same mention twice", () => {
    const once = withPackMention("Deploy todo.py", deployPack);
    expect(withPackMention(once, deployPack)).toBe(once);
  });

  it("copes with an empty prompt without leaving blank lines at the top", () => {
    expect(withPackMention("", deployPack).startsWith("Use the")).toBe(true);
  });
});
