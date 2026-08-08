import { describe, expect, it } from "vitest";

import { runCommand, type CommandContext } from "./commands.ts";
import { isPackCliError, PackCliError } from "./errors.ts";
import { readCard, readDetail, type PackManifest } from "./manifest.ts";
import { renderFailure, renderSuccess } from "./output.ts";
import { makeDirectoryRegistry } from "./registry.ts";
import type { PackStore, PackStoreEntry } from "./store.ts";
import { suggestPack } from "./suggest.ts";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const REGISTRY = "/registry";

const resolvePath = (...segments: ReadonlyArray<string>): string =>
  segments
    .filter((segment) => segment.length > 0)
    .join("/")
    .replaceAll(/\/+/g, "/");

/**
 * Stands in for a disk. Commands and the registry only ever see the four
 * methods of the port, so a whole publish round-trip runs in memory — the same
 * arrangement the SDK's tests use to exercise it without a server.
 */
function makeMemoryStore(seed: Readonly<Record<string, string>> = {}): PackStore & {
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const directories = new Set<string>();

  return {
    files,
    resolve: resolvePath,
    list: (directory) => {
      const prefix = directory.length > 0 ? `${directory}/` : "";
      const seen = new Map<string, PackStoreEntry>();
      for (const path of [...files.keys(), ...directories]) {
        if (!path.startsWith(prefix)) {
          continue;
        }
        const rest = path.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        if (head === undefined || head.length === 0) {
          continue;
        }
        const kind = tail.length > 0 || directories.has(`${prefix}${head}`) ? "directory" : "file";
        seen.set(head, { name: head, kind });
      }
      return Promise.resolve([...seen.values()]);
    },
    read: (path) => Promise.resolve(files.get(path)),
    write: (path, contents) => {
      files.set(path, contents);
      return Promise.resolve();
    },
    makeDirectory: (path) => {
      directories.add(path);
      return Promise.resolve();
    },
  };
}

function makeContext(store: PackStore, cwd = "/work"): CommandContext {
  let counter = 0;
  return {
    store,
    registry: makeDirectoryRegistry(store, REGISTRY),
    cwd,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function minimalManifest(name = "changelog-widget"): Record<string, unknown> {
  return {
    formatVersion: "2.0",
    identity: {
      id: `pack_${name}`,
      name,
      version: "0.1.0",
      displayName: name,
      summary: "Renders a changelog from a JSON feed.",
      publisher: { type: "user", handle: "local", displayName: "local" },
      license: "MIT",
      tags: ["changelog"],
    },
    provenance: {
      workspace: { workspaceKeyId: "wsk_local" },
      extractedAt: "2026-08-01T00:00:00.000Z",
      extractedBy: { type: "user", displayName: "local" },
      handover: { path: "handover.md", summary: "Cut from the marketing site workspace." },
    },
    capability: { does: "Renders a changelog from a JSON feed." },
    knowledge: {},
    requirements: {},
    interfaces: [
      {
        kind: "library",
        id: "changelog",
        title: "Changelog",
        language: "typescript",
        exports: [{ name: "render", kind: "function", summary: "Renders the feed." }],
      },
    ],
    runtime: { target: "node", commands: {} },
    permissions: {},
    verification: {
      record: {
        measuredAt: "2026-08-01T00:00:00.000Z",
        installsAttempted: 0,
        installsSucceeded: 0,
        deploymentsAttempted: 0,
        deploymentsSurviving: 0,
        cumulativeServiceDays: 0,
        breakagesCaught: 0,
        breakagesFixed: 0,
      },
    },
    visibility: { scope: "workspace", workspaceKeyId: "wsk_local" },
    integration: {
      prompt: "Import render() and pass it the feed URL; it returns the rendered markup.",
    },
  };
}

function richManifest(): Record<string, unknown> {
  return {
    formatVersion: "2.0",
    identity: {
      id: "pack_stripe",
      name: "stripe-checkout",
      version: "1.2.0",
      displayName: "Stripe Checkout",
      summary: "Hosted Stripe checkout with webhook reconciliation.",
      publisher: { type: "organization", handle: "acme", displayName: "Acme" },
      license: "Apache-2.0",
      categories: ["payments"],
      tags: ["stripe", "checkout", "webhooks"],
    },
    provenance: {
      workspace: { workspaceKeyId: "wsk_7f3a91" },
      extractedAt: "2026-02-01T09:12:00.000Z",
      extractedBy: { type: "agent", provider: "claudeAgent", model: "claude-opus-5" },
      handover: {
        path: "handover.md",
        summary: "Session creation, redirect and webhook reconciliation, minus the cart UI.",
      },
    },
    capability: {
      does: "Turns a cart total into a paid Stripe order.",
      nonGoals: ["Does not handle refunds"],
    },
    knowledge: {
      failureModes: [
        {
          id: "webhook-retry-double-charge",
          symptom: "A buyer is charged twice for one cart within a few seconds.",
          trigger: "Stripe redelivers payment_intent.succeeded when the first delivery times out.",
          triggerKinds: ["retry", "idempotency"],
          attributedTo: { kind: "provider", service: "stripe" },
          severity: "critical",
          silent: true,
          detection: { signal: "reconciliation-mismatch", match: "orders.payment_intent_id > 1" },
          resolution: {
            kind: "fixed",
            inVersion: "1.1.0",
            change: "Insert the event id in the same transaction as the order write.",
            checkId: "webhook-idempotency",
          },
          firstSeenAt: "2026-05-02T04:19:00.000Z",
          deploymentsAffected: 11,
          conditions: {
            observedAt: "2026-06-18T22:40:00.000Z",
            accountTier: "standard",
            regions: ["us"],
            observedAcrossDeployments: 11,
            untestedAxes: ["plan"],
          },
          origin: {
            introducedIn: "1.1.0",
            source: { kind: "maintenance-agent", provider: "claudeAgent" },
            recordedAt: "2026-05-02T05:00:00.000Z",
          },
        },
      ],
      integration: [
        {
          id: "stripe-restricted-key",
          title: "Create the restricted Stripe key the pack actually needs",
          detail: {
            kind: "credential-retrieval",
            environmentVariable: "STRIPE_SECRET_KEY",
            service: "stripe",
            credentialKind: "restricted-key",
            navigation: [
              {
                action: "Open Developers → API keys.",
                expect: "A table headed Standard keys.",
              },
            ],
            scopes: [
              { name: "checkout_sessions:write", purpose: "Creates the session.", required: true },
            ],
          },
          conditions: {
            observedAt: "2026-07-30T09:00:00.000Z",
            accountTier: "standard",
            regions: ["us"],
            observedAcrossDeployments: 26,
            untestedAxes: ["account-tier"],
          },
          origin: {
            introducedIn: "1.0.0",
            source: { kind: "human-report" },
            recordedAt: "2026-03-04T11:00:00.000Z",
          },
          standing: {
            state: "holding",
            confirmedInInstalls: 26,
            contradictedInInstalls: 1,
          },
          commonMistake:
            "Models send the installer to Settings → API keys and tell them to copy the standard secret key.",
          preventsFailureModeIds: ["webhook-retry-double-charge"],
        },
      ],
    },
    requirements: {
      environment: [
        {
          name: "STRIPE_SECRET_KEY",
          purpose: "Server-side Stripe API calls.",
          secret: true,
          required: true,
          obtainUrl: "https://dashboard.stripe.com/apikeys",
        },
      ],
      accounts: [
        {
          service: "stripe",
          displayName: "Stripe",
          purpose: "Processes the payment.",
          costsMoney: true,
        },
      ],
      setupSteps: [
        { title: "Create Stripe API keys", instructions: "Open the dashboard.", manual: true },
      ],
    },
    interfaces: [
      {
        kind: "api",
        id: "checkout-api",
        title: "Checkout API",
        protocol: "http",
        serviceId: "web",
        operations: [
          {
            operationId: "create-session",
            method: "POST",
            path: "/sessions",
            summary: "Creates a Stripe checkout session for a cart.",
          },
        ],
      },
    ],
    runtime: {
      target: "node",
      commands: { start: { command: "node dist/server.js" } },
      services: [
        {
          id: "web",
          title: "Checkout server",
          protocol: "http",
          binding: { type: "fixed", port: 3000 },
          exposure: "public",
        },
      ],
    },
    permissions: {
      network: [{ host: "api.stripe.com", purpose: "Creates sessions.", dataClasses: ["payment"] }],
    },
    verification: {
      record: {
        measuredAt: "2026-08-07T18:00:00.000Z",
        installsAttempted: 41,
        installsSucceeded: 37,
        deploymentsAttempted: 37,
        deploymentsSurviving: 29,
        cumulativeServiceDays: 2940,
        longestServiceDays: 188,
        breakagesCaught: 2,
        breakagesFixed: 1,
        knowledgeContradictions: 1,
      },
      checks: [
        {
          id: "webhook-idempotency",
          title: "Replays a duplicate event and expects one order.",
          command: "npm run test:idempotency",
          runsOn: ["install", "schedule"],
          guardsFailureModeId: "webhook-retry-double-charge",
          runs: 812,
          passes: 810,
          deploymentsCovered: 29,
        },
      ],
    },
    visibility: { scope: "public" },
    integration: {
      prompt:
        "Add the stripe-checkout pack, ask the user for STRIPE_SECRET_KEY, then POST the cart to /api/checkout/sessions.",
      installCommand: "t3 pack install acme/stripe-checkout@1.2.0",
    },
  };
}

function seedRegistry(): PackStore & { readonly files: Map<string, string> } {
  return makeMemoryStore({
    [`${REGISTRY}/acme-stripe-checkout.pack/pack.json`]: JSON.stringify(richManifest()),
    [`${REGISTRY}/local-changelog-widget.pack/pack.json`]: JSON.stringify(minimalManifest()),
    [`${REGISTRY}/broken.pack/pack.json`]: '{"formatVersion":"2.0"}',
  });
}

async function run(command: Parameters<typeof runCommand>[0], context: CommandContext) {
  return runCommand(command, context);
}

// ── Search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  it("returns everything a decision needs without a second call", async () => {
    const context = makeContext(seedRegistry());

    const outcome = await run(
      { kind: "search", query: "stripe checkout", limit: 10, category: undefined, tag: undefined },
      context,
    );
    const result = outcome.result as {
      readonly returned: number;
      readonly results: ReadonlyArray<Record<string, any>>;
    };

    expect(result.returned).toBe(1);
    const [hit] = result.results;
    expect(hit?.["ref"]).toMatchObject({
      name: "stripe-checkout",
      version: "1.2.0",
      publisher: "acme",
      qualified: "acme/stripe-checkout@1.2.0",
    });
    expect(hit?.["setup"]).toMatchObject({ manualSteps: 1 });
    expect(hit?.["setup"].environment[0]).toMatchObject({
      name: "STRIPE_SECRET_KEY",
      secret: true,
      required: true,
    });
    expect(hit?.["signals"]).toMatchObject({
      deploymentsSurviving: 29,
      installsAttempted: 41,
      installsSucceeded: 37,
      breakagesCaught: 2,
    });
    expect(hit?.["knowledge"]).toMatchObject({
      failureModes: 1,
      openFailureModes: 0,
      integrationEntries: 1,
      credentialGuides: 1,
    });
    expect(hit?.["handles"][0]).toMatchObject({
      id: "webhook-retry-double-charge",
      severity: "critical",
      triggerKinds: ["retry", "idempotency"],
      resolution: "fixed",
    });
  });

  it("frames the suggestion on correctness, never on effort saved", async () => {
    const context = makeContext(seedRegistry());

    const outcome = await run(
      { kind: "search", query: "stripe", limit: 10, category: undefined, tag: undefined },
      context,
    );
    const [hit] = (outcome.result as { readonly results: ReadonlyArray<Record<string, any>> })
      .results;
    const suggestion = hit?.["suggestion"];

    expect(suggestion.line).toContain("running in 29 deployments");
    expect(suggestion.line).toContain(
      "retry and idempotency case that breaks most implementations",
    );
    expect(suggestion.line).not.toMatch(/token|cheap|faster|save|rewrite from scratch/i);
    // The numbers behind every clause travel with it, so the caller can
    // threshold or re-word without going back to the manifest.
    expect(suggestion.evidence).toMatchObject({
      deploymentsSurviving: 29,
      installsSucceeded: 37,
      leadingFailureModeId: "webhook-retry-double-charge",
    });
    expect(suggestion.caveats.join(" ")).toContain("standard-tier us");
  });

  it("matches the scar record, not only the description", async () => {
    const context = makeContext(seedRegistry());

    const outcome = await run(
      { kind: "search", query: "idempotency", limit: 10, category: undefined, tag: undefined },
      context,
    );
    const result = outcome.result as { readonly results: ReadonlyArray<Record<string, any>> };

    expect(result.results[0]?.["ref"].name).toBe("stripe-checkout");
  });

  it("names the packs it could not read rather than hiding them", async () => {
    const context = makeContext(seedRegistry());

    const outcome = await run(
      { kind: "search", query: "changelog", limit: 10, category: undefined, tag: undefined },
      context,
    );
    const result = outcome.result as {
      readonly scanned: number;
      readonly unreadable: ReadonlyArray<{ readonly directory: string }>;
    };

    expect(result.scanned).toBe(3);
    expect(result.unreadable[0]?.directory).toBe("broken.pack");
  });

  it("answers an empty registry without failing", async () => {
    const context = makeContext(makeMemoryStore());

    const outcome = await run(
      { kind: "search", query: "payments", limit: 10, category: undefined, tag: undefined },
      context,
    );

    expect(outcome.result).toMatchObject({ returned: 0, scanned: 0 });
  });
});

// ── Reading a manifest that is missing what the CLI hopes for ───────────────

describe("graceful degradation", () => {
  it("reads a pack that has learned nothing without inventing signals", () => {
    const card = readCard(minimalManifest() as unknown as PackManifest);

    expect(card.knowledge).toMatchObject({ failureModes: 0, integrationEntries: 0 });
    expect(card.knowledge.oldestObservedAt).toBeUndefined();
    expect(card.handles).toEqual([]);
    expect(card.signals.longestServiceDays).toBeUndefined();
    expect(suggestPack(card, NOW).line).toContain("has learned nothing yet");
  });

  it("omits absent fields from the JSON rather than defaulting them", () => {
    const card = readCard(minimalManifest() as unknown as PackManifest);
    const emitted = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;

    expect(Object.keys(emitted)).not.toContain("nonGoals");
    expect(Object.keys(emitted["signals"] as Record<string, unknown>)).not.toContain(
      "longestServiceDays",
    );
    expect((emitted["signals"] as Record<string, unknown>)["deploymentsSurviving"]).toBe(0);
  });

  it("survives a manifest with none of the fields it reads", () => {
    // What a rename in the contract looks like from here: every knowledge and
    // signal field gone at once. The card is empty, not absent, and nothing
    // throws on the hot path.
    const card = readCard({} as PackManifest);

    expect(card.ref.name).toBe("unnamed");
    expect(card.interfaceKinds).toEqual([]);
    expect(card.signals.measuredAt).toBeUndefined();
    expect(card.knowledge.failureModes).toBe(0);
    expect(() => readDetail({} as PackManifest)).not.toThrow();
    expect(suggestPack(card, NOW).line).toContain("carries no production record");
  });

  it("keeps knowledge entries that carry only their required fields", () => {
    const manifest = richManifest();
    const knowledge = manifest["knowledge"] as Record<string, Array<Record<string, unknown>>>;
    const stripped = { ...knowledge["failureModes"]?.[0] };
    delete stripped["triggerKinds"];
    delete stripped["detection"];
    delete stripped["silent"];
    knowledge["failureModes"] = [stripped];

    const card = readCard(manifest as unknown as PackManifest);

    expect(card.handles[0]?.triggerKinds).toBeUndefined();
    expect(card.handles[0]?.detection).toBeUndefined();
    expect(card.handles[0]?.symptom).toContain("charged twice");
    expect(suggestPack(card, NOW).line).toContain("the case where a buyer is charged twice");
  });
});

// ── Show ────────────────────────────────────────────────────────────────────

describe("show", () => {
  it("carries the integration knowledge a fresh implementation would guess wrong", async () => {
    const context = makeContext(seedRegistry());

    const outcome = await run(
      { kind: "show", pack: "stripe-checkout", version: undefined },
      context,
    );
    const detail = outcome.result as Record<string, any>;

    const [entry] = detail["integrationKnowledge"];
    expect(entry).toMatchObject({
      kind: "credential-retrieval",
      environmentVariable: "STRIPE_SECRET_KEY",
    });
    expect(entry.navigation[0].action).toContain("Developers");
    expect(entry.commonMistake).toContain("standard secret key");
    expect(entry.conditions.caveat).toContain("Yours may differ");
    expect(detail["permissions"].network[0]).toMatchObject({ host: "api.stripe.com" });
    expect(detail["integration"].prompt).toContain("stripe-checkout");
  });

  it("resolves a publisher-qualified reference", async () => {
    const context = makeContext(seedRegistry());

    const outcome = await run(
      { kind: "show", pack: "acme/stripe-checkout", version: undefined },
      context,
    );

    expect((outcome.result as Record<string, any>)["ref"].publisher).toBe("acme");
  });

  it("exits three when nothing matches", async () => {
    const context = makeContext(seedRegistry());

    const error = await run({ kind: "show", pack: "nope", version: undefined }, context).catch(
      (cause: unknown) => cause,
    );

    expect(isPackCliError(error)).toBe(true);
    expect((error as PackCliError).code).toBe("pack-not-found");
    expect((error as PackCliError).exitCode).toBe(3);
  });
});

// ── Init, validate, publish, version ────────────────────────────────────────

describe("init and validate", () => {
  it("scaffolds a pack that says it has learned nothing, and names what is unwritten", async () => {
    const store = makeMemoryStore();
    const context = makeContext(store);

    const outcome = await run(
      {
        kind: "init",
        name: "receipts",
        directory: undefined,
        publisher: "local",
        displayName: undefined,
        summary: undefined,
        does: undefined,
        license: "MIT",
        target: "node",
      },
      context,
    );
    const result = outcome.result as Record<string, any>;

    expect(result["directory"]).toBe("/work/receipts.pack");
    expect(store.files.has("/work/receipts.pack/pack.json")).toBe(true);
    expect(store.files.has("/work/receipts.pack/handover.md")).toBe(true);
    const codes = result["readiness"].issues.map((issue: { code: string }) => issue.code);
    expect(codes).toContain("handover-empty");
    expect(codes).toContain("integration-prompt-thin");
    expect(codes).toContain("knowledge-absent");
    expect(result["readiness"].publishable).toBe(false);
  });

  it("refuses to overwrite a pack that is already there", async () => {
    const store = makeMemoryStore({
      "/work/receipts.pack/pack.json": JSON.stringify(minimalManifest("receipts")),
    });
    const context = makeContext(store);

    const error = await run(
      {
        kind: "init",
        name: "receipts",
        directory: undefined,
        publisher: "local",
        displayName: undefined,
        summary: undefined,
        does: undefined,
        license: "MIT",
        target: "node",
      },
      context,
    ).catch((cause: unknown) => cause);

    expect((error as PackCliError).code).toBe("usage");
  });

  it("passes a finished pack and reports the warnings that do not block", async () => {
    const store = makeMemoryStore({
      "/work/thing.pack/pack.json": JSON.stringify(minimalManifest("thing")),
    });

    const outcome = await run({ kind: "validate", directory: undefined }, makeContext(store));
    const result = outcome.result as Record<string, any>;

    expect(result["publishable"]).toBe(true);
    expect(result["errors"]).toBe(0);
    expect(result["issues"].map((issue: { code: string }) => issue.code)).toContain(
      "knowledge-absent",
    );
  });

  it("exits five with the whole report when errors block publication", async () => {
    const manifest = minimalManifest("thin");
    (manifest["integration"] as Record<string, unknown>)["prompt"] = "TODO";
    const store = makeMemoryStore({ "/work/thin.pack/pack.json": JSON.stringify(manifest) });

    const error = (await run({ kind: "validate", directory: undefined }, makeContext(store)).catch(
      (cause: unknown) => cause,
    )) as PackCliError;

    expect(error.code).toBe("not-publishable");
    expect(error.exitCode).toBe(5);
    const issues = (error.detail ?? {})["issues"] as ReadonlyArray<{ readonly code: string }>;
    expect(issues.map((issue) => issue.code)).toContain("integration-prompt-thin");
  });

  it("exits four on a manifest the format cannot read", async () => {
    const store = makeMemoryStore({ "/work/x.pack/pack.json": '{"formatVersion":"3.0"}' });

    const error = (await run({ kind: "validate", directory: undefined }, makeContext(store)).catch(
      (cause: unknown) => cause,
    )) as PackCliError;

    expect(error.code).toBe("format-version-unsupported");
    expect(error.exitCode).toBe(4);
  });

  it("exits three when there is no pack where it was told to look", async () => {
    const error = (await run(
      { kind: "validate", directory: undefined },
      makeContext(makeMemoryStore()),
    ).catch((cause: unknown) => cause)) as PackCliError;

    expect(error.code).toBe("manifest-not-found");
    expect(error.exitCode).toBe(3);
  });
});

describe("publish and version", () => {
  it("publishes private however the manifest asks to be seen", async () => {
    const store = makeMemoryStore({
      "/work/stripe-checkout.pack/pack.json": JSON.stringify(richManifest()),
    });
    const context = makeContext(store);

    const outcome = await run({ kind: "publish", directory: undefined, dryRun: false }, context);
    const result = outcome.result as Record<string, any>;

    expect(result["published"]).toBe(true);
    expect(result["visibility"]).toMatchObject({ scope: "workspace", claimedInManifest: "public" });
    const stored = store.files.get(`${REGISTRY}/acme-stripe-checkout.pack/pack.json`);
    expect(JSON.parse(stored ?? "{}")["visibility"]).toEqual({
      scope: "workspace",
      workspaceKeyId: "wsk_7f3a91",
    });
    expect(store.files.has(`${REGISTRY}/acme-stripe-checkout.pack/versions/1.2.0.json`)).toBe(true);
  });

  it("writes nothing on a dry run", async () => {
    const store = makeMemoryStore({
      "/work/stripe-checkout.pack/pack.json": JSON.stringify(richManifest()),
    });

    const outcome = await run(
      { kind: "publish", directory: undefined, dryRun: true },
      makeContext(store),
    );

    expect((outcome.result as Record<string, unknown>)["published"]).toBe(false);
    expect([...store.files.keys()].some((path) => path.startsWith(REGISTRY))).toBe(false);
  });

  it("exits six rather than rewriting a release", async () => {
    const store = makeMemoryStore({
      "/work/stripe-checkout.pack/pack.json": JSON.stringify(richManifest()),
    });
    const context = makeContext(store);
    await run({ kind: "publish", directory: undefined, dryRun: false }, context);

    const error = (await run(
      { kind: "publish", directory: undefined, dryRun: false },
      context,
    ).catch((cause: unknown) => cause)) as PackCliError;

    expect(error.code).toBe("version-exists");
    expect(error.exitCode).toBe(6);
  });

  it("records a bumped version and leaves the earlier release alone", async () => {
    const store = makeMemoryStore({
      "/work/stripe-checkout.pack/pack.json": JSON.stringify(richManifest()),
    });
    const context = makeContext(store);
    await run({ kind: "publish", directory: undefined, dryRun: false }, context);

    const outcome = await run(
      { kind: "version", directory: undefined, set: undefined, bump: "minor" },
      context,
    );

    expect(outcome.result).toMatchObject({ previousVersion: "1.2.0", version: "1.3.0" });
    expect(store.files.has(`${REGISTRY}/acme-stripe-checkout.pack/versions/1.2.0.json`)).toBe(true);
    expect(store.files.has(`${REGISTRY}/acme-stripe-checkout.pack/versions/1.3.0.json`)).toBe(true);
    const local = JSON.parse(store.files.get("/work/stripe-checkout.pack/pack.json") ?? "{}");
    expect(local["identity"]["version"]).toBe("1.3.0");
    // The bump rewrites the version and nothing else, so a field this CLI does
    // not know about cannot be dropped by a version bump.
    expect(local["knowledge"]["failureModes"]).toHaveLength(1);
  });

  it("refuses a version that is not semver", async () => {
    const store = makeMemoryStore({
      "/work/stripe-checkout.pack/pack.json": JSON.stringify(richManifest()),
    });

    const error = (await run(
      { kind: "version", directory: undefined, set: "next", bump: undefined },
      makeContext(store),
    ).catch((cause: unknown) => cause)) as PackCliError;

    expect(error.code).toBe("usage");
  });
});

// ── The envelope ────────────────────────────────────────────────────────────

describe("output", () => {
  it("wraps a success as one JSON object on stdout", () => {
    const rendered = renderSuccess("search", { result: { returned: 0 }, human: "nothing" }, false);

    expect(JSON.parse(rendered.stdout ?? "")).toEqual({
      ok: true,
      command: "search",
      result: { returned: 0 },
    });
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stderr).toBeUndefined();
  });

  it("keeps a failure on stdout in JSON mode so a caller reading stdout still sees it", () => {
    const rendered = renderFailure(
      "show",
      new PackCliError("pack-not-found", "No pack.", { pack: "nope" }),
      false,
    );

    expect(JSON.parse(rendered.stdout ?? "")).toEqual({
      ok: false,
      command: "show",
      error: { code: "pack-not-found", message: "No pack.", detail: { pack: "nope" } },
    });
    expect(rendered.exitCode).toBe(3);
  });

  it("moves a failure to stderr for a person", () => {
    const rendered = renderFailure("show", new PackCliError("pack-not-found", "No pack."), true);

    expect(rendered.stdout).toBeUndefined();
    expect(rendered.stderr).toBe("pack-not-found: No pack.");
  });

  it("renders text instead of JSON when asked", () => {
    const rendered = renderSuccess("search", { result: {}, human: "one pack" }, true);

    expect(rendered.stdout).toBe("one pack");
  });
});
