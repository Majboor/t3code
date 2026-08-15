import { Schema } from "effect";
import { PackManifest } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildManifest,
  findPublishProblems,
  parseRequirements,
  toHandle,
} from "./publishPack.logic";

const good = {
  name: "payment-flow",
  summary: "Takes a card payment and reconciles it against the ledger",
  handover:
    "Built the checkout and the reconciliation job. Tried and abandoned webhooks for settlement. Refunds are not done.",
};

describe("findPublishProblems", () => {
  it("accepts a pack whose author said what it does and what they learned", () => {
    expect(findPublishProblems(good)).toEqual([]);
  });

  it("refuses a name that could not live in a URL", () => {
    for (const name of ["Payment Flow", "-leading", "trailing-", "payment_flow", ""]) {
      const problems = findPublishProblems({ ...good, name });
      expect(problems.map((problem) => problem.field)).toContain("name");
    }
  });

  it("refuses a summary too short to search for", () => {
    expect(findPublishProblems({ ...good, summary: "does stuff" }).map((p) => p.field)).toContain(
      "summary",
    );
  });

  it("refuses a handover that is obviously a placeholder", () => {
    // The point of the format: a pack with nothing learned behind it is a
    // template, and this is the one field that cannot be generated for you.
    expect(findPublishProblems({ ...good, handover: "TODO" }).map((p) => p.field)).toContain(
      "handover",
    );
  });

  it("reports every problem at once rather than one at a time", () => {
    const problems = findPublishProblems({ name: "Bad Name", summary: "x", handover: "y" });
    expect(problems.map((problem) => problem.field).toSorted()).toEqual([
      "handover",
      "name",
      "summary",
    ]);
  });
});

describe("toHandle", () => {
  it("turns a tenant id into something the format accepts", () => {
    // The real value that broke publishing: a colon is not a slug character,
    // and the registry rejected it only after the author had written
    // everything.
    expect(toHandle("tenant:personal-73863ad0-e340-469e-bcb4-fee8e23a356d")).toMatch(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    );
  });

  it("never ends on a hyphen, even after truncating", () => {
    expect(toHandle("a".repeat(60) + ":::::::::::::::::::::")).toMatch(/[a-z0-9]$/);
  });

  it("has something to say when there is nothing usable left", () => {
    expect(toHandle(":::")).toBe("unknown");
  });
});

describe("parseRequirements", () => {
  it("reads one name per line and normalises it", () => {
    expect(parseRequirements("host\n  port  \n")).toEqual([
      { name: "HOST", secret: false },
      { name: "PORT", secret: false },
    ]);
  });

  it("treats a trailing bang as the thing that matters: it is a secret", () => {
    expect(parseRequirements("TOKEN!")).toEqual([{ name: "TOKEN", secret: true }]);
  });

  it("keeps the first of a repeated name rather than asking for it twice", () => {
    expect(parseRequirements("HOST\nhost")).toEqual([{ name: "HOST", secret: false }]);
  });

  it("has nothing to say about blank input", () => {
    expect(parseRequirements("\n  \n")).toEqual([]);
  });
});

describe("buildManifest", () => {
  const input = {
    ...good,
    shape: "web" as const,
    startCommand: "npm start",
    requirements: "",
    publisherHandle: "someone",
    workspaceKeyId: "wsk_abc",
    authorName: "Someone",
    extractedAt: "2026-08-14T09:00:00.000Z",
    packId: "pack_abc",
  };

  it("starts at 0.1.0 and private to the workspace that cut it", () => {
    const manifest = buildManifest(input);
    expect(manifest.identity.version).toBe("0.1.0");
    expect(manifest.visibility.scope).toBe("workspace");
  });

  it("carries an empty scar record rather than flattering numbers", () => {
    const record = buildManifest(input).verification.record;
    expect(record.deploymentsAttempted).toBe(0);
    expect(record.deploymentsSurviving).toBe(0);
  });

  it("leaves knowledge empty, which is an honest claim and not an oversight", () => {
    // Inventing failure modes would make a template read as experience.
    expect(buildManifest(input).knowledge).toEqual({});
  });

  it("builds something the registry will actually accept", () => {
    // Without this the dialog can build a manifest that fails to encode, and
    // the RPC never leaves the browser — no request, no error, nothing.
    expect(() => Schema.decodeUnknownSync(PackManifest)(buildManifest(input))).not.toThrow();
  });

  it("builds a valid manifest from a real tenant id", () => {
    expect(() =>
      Schema.decodeUnknownSync(PackManifest)(
        buildManifest({
          ...input,
          publisherHandle: "tenant:personal-73863ad0-e340-469e-bcb4-fee8e23a356d",
        }),
      ),
    ).not.toThrow();
  });

  it("still builds something valid when the author does not know the start command", () => {
    // The dialog does not require one for a web surface, so this is the path
    // most publishes take.
    expect(() =>
      Schema.decodeUnknownSync(PackManifest)(buildManifest({ ...input, startCommand: "" })),
    ).not.toThrow();
  });

  it("declares a terminal program by the command that runs it", () => {
    const manifest = buildManifest({ ...input, shape: "tui", startCommand: "./bin/report" });
    const [surface] = manifest.interfaces ?? [];
    expect(surface?.kind).toBe("tui");
    expect(surface && "command" in surface && surface.command).toBe("./bin/report");
  });

  it("carries what the pack needs into requirements, secrets marked", () => {
    const manifest = buildManifest({ ...input, requirements: "HOST\nTOKEN!" });
    const environment = manifest.requirements.environment ?? [];
    expect(environment.map((entry) => [entry.name, entry.secret, entry.required])).toEqual([
      ["HOST", false, true],
      ["TOKEN", true, true],
    ]);
  });

  it("still decodes once it declares requirements", () => {
    expect(() =>
      Schema.decodeUnknownSync(PackManifest)(
        buildManifest({ ...input, requirements: "HOST\nTOKEN!" }),
      ),
    ).not.toThrow();
  });

  it("puts the author's own words in the integration prompt", () => {
    const prompt = buildManifest(input).integration.prompt;
    expect(prompt).toContain(good.summary);
    expect(prompt).toContain("Refunds are not done");
  });
});
