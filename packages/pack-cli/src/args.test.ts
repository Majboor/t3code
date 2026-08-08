import { describe, expect, it } from "vitest";

import { parseArgs } from "./args.ts";

describe("global options", () => {
  it("defaults to machine-readable output", () => {
    const parsed = parseArgs(["search", "payments"]);

    expect(parsed.ok && parsed.parsed.options.human).toBe(false);
  });

  it("reads --human, --registry, --server and --token", () => {
    const parsed = parseArgs([
      "search",
      "payments",
      "--human",
      "--registry",
      "/srv/packs",
      "--server=http://127.0.0.1:13773",
      "--token",
      "abc",
    ]);

    expect(parsed.ok && parsed.parsed.options).toEqual({
      human: true,
      registry: "/srv/packs",
      server: "http://127.0.0.1:13773",
      token: "abc",
    });
  });

  it("rejects a value flag with nothing after it", () => {
    const parsed = parseArgs(["search", "payments", "--limit"]);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.code).toBe("usage");
    expect(!parsed.ok && parsed.error.exitCode).toBe(2);
  });

  it("reports an unknown command with the ones it knows", () => {
    const parsed = parseArgs(["instal"]);

    expect(!parsed.ok && parsed.error.message).toMatch(/Unknown command "instal"/);
    expect(!parsed.ok && parsed.error.detail?.["known"]).toContain("search");
  });

  it("answers an empty argv and -h with help rather than an error", () => {
    expect(parseArgs([]).ok).toBe(true);
    expect(parseArgs([])).toMatchObject({ parsed: { command: { kind: "help" } } });
    expect(parseArgs(["show", "-h"])).toMatchObject({ parsed: { command: { kind: "help" } } });
  });
});

describe("search", () => {
  it("joins the query and defaults the limit", () => {
    const parsed = parseArgs(["search", "webhook", "idempotency"]);

    expect(parsed.ok && parsed.parsed.command).toEqual({
      kind: "search",
      query: "webhook idempotency",
      limit: 10,
      category: undefined,
      tag: undefined,
    });
  });

  it("needs a query", () => {
    expect(parseArgs(["search"])).toMatchObject({ ok: false });
  });

  it("refuses a limit outside the range", () => {
    expect(parseArgs(["search", "payments", "--limit", "0"])).toMatchObject({ ok: false });
    expect(parseArgs(["search", "payments", "--limit", "999"])).toMatchObject({ ok: false });
    expect(parseArgs(["search", "payments", "--limit", "5"])).toMatchObject({
      parsed: { command: { limit: 5 } },
    });
  });
});

describe("show", () => {
  it("splits an inline version off the reference", () => {
    expect(parseArgs(["show", "acme/stripe-checkout@1.2.0"])).toMatchObject({
      parsed: { command: { kind: "show", pack: "acme/stripe-checkout", version: "1.2.0" } },
    });
  });

  it("lets --version win over an inline one", () => {
    expect(parseArgs(["show", "stripe-checkout@1.2.0", "--version", "1.0.0"])).toMatchObject({
      parsed: { command: { version: "1.0.0" } },
    });
  });

  it("needs a pack", () => {
    expect(parseArgs(["show"])).toMatchObject({ ok: false });
  });
});

describe("version", () => {
  it("takes --set or --bump but not both", () => {
    expect(parseArgs(["version", "--set", "1.1.0"])).toMatchObject({
      parsed: { command: { set: "1.1.0", bump: undefined } },
    });
    expect(parseArgs(["version", "--bump", "minor"])).toMatchObject({
      parsed: { command: { bump: "minor" } },
    });
    expect(parseArgs(["version", "--set", "1.1.0", "--bump", "minor"])).toMatchObject({
      ok: false,
    });
    expect(parseArgs(["version"])).toMatchObject({ ok: false });
  });

  it("refuses a bump it does not understand", () => {
    expect(parseArgs(["version", "--bump", "sideways"])).toMatchObject({ ok: false });
  });
});

describe("init, validate and publish", () => {
  it("defaults the publisher, licence and target", () => {
    expect(parseArgs(["init", "stripe-checkout"])).toMatchObject({
      parsed: {
        command: {
          kind: "init",
          name: "stripe-checkout",
          publisher: "local",
          license: "UNLICENSED",
          target: "node",
        },
      },
    });
  });

  it("needs a name", () => {
    expect(parseArgs(["init"])).toMatchObject({ ok: false });
  });

  it("treats --dry-run as a boolean rather than eating the next argument", () => {
    expect(parseArgs(["publish", "--dry-run", "--dir", "/srv/pack"])).toMatchObject({
      parsed: { command: { kind: "publish", dryRun: true, directory: "/srv/pack" } },
    });
  });

  it("reads validate's directory", () => {
    expect(parseArgs(["validate", "--dir=/srv/pack"])).toMatchObject({
      parsed: { command: { kind: "validate", directory: "/srv/pack" } },
    });
  });
});
