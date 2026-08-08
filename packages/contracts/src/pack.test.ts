import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PACK_FORMAT_VERSION,
  PackId,
  PackManifest,
  PackManifestEnvelope,
  PackReadinessReport,
  PackSigningKeyId,
  PackSummary,
  PackWorkspaceKeyId,
} from "./pack.ts";

const decodeManifest = Schema.decodeUnknownSync(PackManifest);
const decodeEnvelope = Schema.decodeUnknownSync(PackManifestEnvelope);
const decodeSummary = Schema.decodeUnknownSync(PackSummary);
const decodeReadinessReport = Schema.decodeUnknownSync(PackReadinessReport);

const minimalManifest = {
  formatVersion: PACK_FORMAT_VERSION,
  identity: {
    id: PackId.make("pack_01J9Z0C4Q3"),
    name: "stripe-checkout",
    version: "0.1.0",
    displayName: "Stripe Checkout",
    summary: "Hosted Stripe checkout with webhook reconciliation.",
    publisher: {
      type: "user",
      handle: "waleed",
      displayName: "Waleed Ajmal",
    },
    license: "MIT",
  },
  provenance: {
    workspace: {
      workspaceKeyId: PackWorkspaceKeyId.make("wsk_7f3a91"),
    },
    extractedAt: "2026-08-07T09:12:00.000Z",
    extractedBy: {
      type: "agent",
      provider: "claudeAgent",
    },
    handover: {
      path: "handover.md",
      summary: "Lifted the checkout flow out of the storefront workspace.",
    },
  },
  capability: {
    does: "Turns a cart total into a paid Stripe order.",
  },
  requirements: {},
  interfaces: [
    {
      kind: "library",
      id: "checkout",
      title: "Checkout helpers",
      language: "typescript",
      exports: [
        {
          name: "createCheckoutSession",
          kind: "function",
          summary: "Creates a Stripe checkout session for a cart.",
        },
      ],
    },
  ],
  runtime: {
    target: "node",
    commands: {},
  },
  permissions: {},
  verification: { status: "unverified" },
  visibility: { scope: "unlisted" },
  integration: {
    prompt: "Install the stripe-checkout pack and call createCheckoutSession from your cart page.",
  },
};

const fullManifest = {
  formatVersion: PACK_FORMAT_VERSION,
  identity: {
    id: PackId.make("pack_01J9Z0C4Q3"),
    name: "stripe-checkout",
    version: "1.2.0",
    displayName: "Stripe Checkout",
    summary: "Hosted Stripe checkout with webhook reconciliation.",
    description: "Extracted from a working storefront: session creation, redirect, webhook.",
    publisher: {
      type: "organization",
      handle: "acme",
      displayName: "Acme",
      organizationId: "org-acme",
      signingKeyId: PackSigningKeyId.make("key_ed25519_01"),
      publicKey: "bXktcHVibGljLWtleQ==",
      contactUrl: "https://acme.example/support",
    },
    license: "Apache-2.0",
    categories: ["payments", "commerce"],
    tags: ["stripe", "checkout", "webhooks"],
    homepageUrl: "https://acme.example/packs/stripe-checkout",
    repositoryUrl: "https://github.com/acme/stripe-checkout",
  },
  provenance: {
    workspace: {
      workspaceKeyId: PackWorkspaceKeyId.make("wsk_7f3a91"),
      workspaceId: "workspace-storefront",
      tenantId: "tenant-acme",
      projectId: "project-storefront",
      title: "Storefront",
    },
    extractedAt: "2026-08-07T09:12:00.000Z",
    extractedBy: {
      type: "agent",
      provider: "claudeAgent",
      model: "claude-opus-5",
      onBehalfOfUserId: "user-1",
    },
    handover: {
      path: "handover.md",
      summary: "Session creation, redirect and webhook reconciliation, minus the cart UI.",
      generatedBy: {
        type: "agent",
        provider: "claudeAgent",
        model: "claude-opus-5",
      },
      generatedAt: "2026-08-07T09:12:00.000Z",
    },
    source: {
      repositoryUrl: "https://github.com/acme/storefront",
      branch: "main",
      commitSha: "9a1f2c4",
      dirty: false,
    },
    derivedFrom: {
      id: PackId.make("pack_01H0PARENT"),
      name: "payments-core",
      version: "0.4.1",
      publisherHandle: "acme",
    },
  },
  capability: {
    does: "Turns a cart total into a paid Stripe order.",
    useCases: ["One-off product checkout", "Subscription upgrade flow"],
    nonGoals: ["Does not store cards", "Does not handle refunds or disputes"],
    inputs: [
      {
        name: "cart",
        kind: "http-request",
        description: "Line items and currency for the order being paid.",
        schemaPath: "schemas/cart.json",
        required: true,
      },
    ],
    outputs: [
      {
        name: "payment-completed",
        kind: "webhook",
        description: "Fires once Stripe confirms the payment intent succeeded.",
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
        example: "sk_live_...",
        obtainUrl: "https://dashboard.stripe.com/apikeys",
        pattern: "^sk_(test|live)_[A-Za-z0-9]+$",
      },
      {
        name: "STRIPE_WEBHOOK_SECRET",
        purpose: "Verifies webhook signatures.",
        secret: true,
        required: true,
      },
      {
        name: "CHECKOUT_SUCCESS_URL",
        purpose: "Where Stripe returns the buyer after payment.",
        secret: false,
        required: true,
        defaultValue: "https://example.com/thanks",
      },
    ],
    accounts: [
      {
        service: "stripe",
        displayName: "Stripe",
        purpose: "Processes the payment and hosts the checkout page.",
        signupUrl: "https://dashboard.stripe.com/register",
        requiredScopes: ["checkout_sessions:write", "payment_intents:read"],
        costsMoney: true,
        providesEnvironment: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      },
    ],
    services: [
      {
        kind: "postgres",
        name: "orders",
        purpose: "Stores orders and their payment state.",
        versionRange: ">=14",
        connectionEnvVar: "DATABASE_URL",
      },
    ],
    toolchain: [{ name: "node", versionRange: ">=22" }],
    packs: [
      {
        id: PackId.make("pack_01H0EMAIL"),
        name: "transactional-email",
        publisherHandle: "acme",
        versionRange: "^2.0.0",
        optional: true,
      },
    ],
    setupSteps: [
      {
        title: "Create Stripe API keys",
        instructions: "Open the Stripe dashboard, create a restricted key, paste it when asked.",
        satisfies: ["STRIPE_SECRET_KEY"],
        manual: true,
      },
      {
        title: "Register the webhook endpoint",
        instructions: "Point Stripe at /api/stripe/webhook and copy the signing secret.",
        command: "stripe listen --forward-to localhost:3000/api/stripe/webhook",
        verifyCommand: "node scripts/verify-webhook.mjs",
        satisfies: ["STRIPE_WEBHOOK_SECRET"],
      },
    ],
    preflightCommand: "node scripts/preflight.mjs",
  },
  interfaces: [
    {
      kind: "api",
      id: "checkout-api",
      title: "Checkout API",
      protocol: "http",
      serviceId: "web",
      basePath: "/api/checkout",
      specPath: "schemas/openapi.json",
      operations: [
        {
          operationId: "create-session",
          method: "POST",
          path: "/sessions",
          summary: "Creates a Stripe checkout session for a cart.",
          authentication: "session",
          requiresEnvironment: ["STRIPE_SECRET_KEY"],
        },
        {
          operationId: "stripe-webhook",
          method: "POST",
          path: "/webhook",
          summary: "Receives payment lifecycle events from Stripe.",
          authentication: "signature",
        },
      ],
    },
    {
      kind: "web",
      id: "checkout-ui",
      title: "Checkout return page",
      serviceId: "web",
      basePath: "/checkout",
      framework: "react",
      requiresAuthentication: false,
    },
    {
      kind: "cli",
      id: "checkout-cli",
      title: "Order tools",
      binary: "checkout",
      commands: [
        {
          name: "reconcile",
          usage: "checkout reconcile --since 24h",
          summary: "Replays unmatched Stripe events against local orders.",
        },
      ],
    },
    {
      kind: "mcp",
      id: "checkout-mcp",
      title: "Checkout tools for agents",
      transport: "stdio",
      command: "node dist/mcp.js",
      tools: [{ name: "create-session", summary: "Creates a checkout session." }],
    },
  ],
  runtime: {
    target: "node",
    versionRange: ">=22",
    commands: {
      install: { command: "npm ci" },
      build: { command: "npm run build" },
      start: { command: "node dist/server.js", description: "Serves the API and return page." },
      dev: { command: "npm run dev" },
      test: { command: "npm test" },
      migrate: { command: "npm run db:migrate" },
      healthcheck: { command: "curl -fsS localhost:3000/healthz" },
    },
    services: [
      {
        id: "web",
        title: "Checkout server",
        protocol: "http",
        binding: { type: "environment", envVar: "PORT", defaultPort: 3000 },
        exposure: "public",
        healthPath: "/healthz",
      },
    ],
    container: {
      dockerfilePath: "Dockerfile",
      composePath: "compose.yaml",
    },
  },
  permissions: {
    network: [
      {
        host: "api.stripe.com",
        purpose: "Creates checkout sessions and reads payment intents.",
        ports: [443],
        required: true,
        dataClasses: ["payment", "pii"],
      },
      {
        host: "*.stripe.com",
        purpose: "Redirects the buyer to the hosted checkout page.",
        dataClasses: ["none"],
      },
    ],
    acceptsInboundNetwork: true,
    filesystem: [
      {
        root: "data",
        path: "receipts",
        access: "read-write",
        purpose: "Caches generated receipt PDFs.",
      },
    ],
    secrets: [
      { name: "STRIPE_SECRET_KEY", purpose: "Signs Stripe API calls." },
      { name: "STRIPE_WEBHOOK_SECRET", purpose: "Verifies inbound webhook signatures." },
    ],
    process: {
      spawnsSubprocesses: true,
      commands: ["node scripts/preflight.mjs"],
    },
    elevated: [
      {
        capability: "privileged-port",
        justification: "Binds 443 directly when deployed without a reverse proxy.",
      },
    ],
  },
  verification: {
    status: "verified",
    verifiedAt: "2026-08-07T18:00:00.000Z",
    verifier: {
      displayName: "T3 Pack Review",
      userId: "user-reviewer",
    },
    checks: [
      { id: "manifest-schema", outcome: "pass" },
      { id: "secret-scan", outcome: "pass" },
      { id: "permissions-reviewed", outcome: "pass", note: "Privileged port justified." },
      { id: "build-reproducible", outcome: "waived", note: "Build not yet deterministic." },
    ],
    expiresAt: "2027-08-07T18:00:00.000Z",
    notes: "Reviewed against release 1.2.0 bytes.",
  },
  visibility: { scope: "public" },
  integration: {
    prompt:
      "Add the stripe-checkout pack. Ask the user for STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and CHECKOUT_SUCCESS_URL, then POST the cart to /api/checkout/sessions and redirect to the returned URL.",
    installCommand: "t3 pack install acme/stripe-checkout@1.2.0",
    variants: [
      {
        target: "lovable",
        prompt: "Create a checkout button that POSTs the cart to /api/checkout/sessions.",
      },
    ],
    snippets: [
      {
        title: "Create a session",
        language: "typescript",
        code: "const { url } = await createCheckoutSession({ items });",
        description: "Server-side session creation.",
      },
    ],
    followUpQuestions: ["Which currency should orders settle in?"],
  },
  analytics: {
    events: [
      {
        name: "checkout.session_created",
        source: "backend",
        description: "A checkout session was created for a cart.",
        properties: [
          { name: "amount_minor", type: "number", pii: false },
          { name: "buyer_email", type: "string", pii: true },
        ],
      },
      {
        name: "checkout.payment_succeeded",
        source: "backend",
        description: "Stripe confirmed the payment intent.",
      },
    ],
    meteredOperations: ["create-session", "stripe-webhook"],
    metrics: [
      {
        id: "sessions-created",
        title: "Checkout sessions created",
        kind: "count",
        source: { type: "event", event: "checkout.session_created" },
      },
      {
        id: "webhook-latency",
        title: "Webhook latency",
        kind: "latency-p95",
        source: { type: "operation", operationId: "stripe-webhook" },
        unit: "ms",
      },
    ],
    sink: { kind: "t3" },
  },
  contents: {
    readmePath: "README.md",
    licensePath: "LICENSE",
    iconPath: "assets/icon.svg",
    sourceRoot: "source",
    examplesRoot: "examples",
    files: [
      {
        path: "source/server.ts",
        sha256: "3b1f2a9c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
        bytes: 4_210,
      },
    ],
    archiveSha256: "0011223344556677889900112233445566778899001122334455667788990011",
  },
  signature: {
    keyId: PackSigningKeyId.make("key_ed25519_01"),
    algorithm: "ed25519",
    publicKey: "bXktcHVibGljLWtleQ==",
    manifestSha256: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    contentsSha256: "0011223344556677889900112233445566778899001122334455667788990011",
    signature: "c2lnbmF0dXJlLWJ5dGVz",
    signedAt: "2026-08-07T18:05:00.000Z",
  },
};

describe("PackManifest", () => {
  it("decodes a complete payment-flow manifest", () => {
    const parsed = decodeManifest(fullManifest);

    expect(parsed.identity.version).toBe("1.2.0");
    expect(parsed.identity.publisher.type).toBe("organization");
    expect(parsed.provenance.handover.path).toBe("handover.md");
    expect(parsed.interfaces).toHaveLength(4);
    expect(parsed.requirements.environment?.[0]?.secret).toBe(true);
    expect(parsed.requirements.accounts?.[0]?.service).toBe("stripe");
    expect(parsed.permissions.network?.[0]?.dataClasses).toEqual(["payment", "pii"]);
    expect(parsed.analytics?.meteredOperations).toEqual(["create-session", "stripe-webhook"]);
    expect(parsed.signature?.algorithm).toBe("ed25519");
  });

  it("keeps the verified state inseparable from its verifier and checks", () => {
    const parsed = decodeManifest(fullManifest);

    if (parsed.verification.status !== "verified") {
      throw new Error("Expected a verified manifest");
    }
    expect(parsed.verification.verifier.displayName).toBe("T3 Pack Review");
    expect(parsed.verification.checks).toHaveLength(4);
  });

  it("resolves a service binding through the interface that hosts it", () => {
    const parsed = decodeManifest(fullManifest);
    const api = parsed.interfaces.find((entry) => entry.kind === "api");

    if (api?.kind !== "api") {
      throw new Error("Expected an api interface");
    }
    const service = parsed.runtime.services?.find((entry) => entry.id === api.serviceId);
    expect(service?.binding.type).toBe("environment");
    expect(service?.exposure).toBe("public");
  });

  it("decodes a minimal manifest that claims no requirements or permissions", () => {
    const parsed = decodeManifest(minimalManifest);

    expect(parsed.formatVersion).toBe(PACK_FORMAT_VERSION);
    expect(parsed.requirements.environment).toBeUndefined();
    expect(parsed.permissions.network).toBeUndefined();
    expect(parsed.verification.status).toBe("unverified");
    expect(parsed.visibility.scope).toBe("unlisted");
    expect(parsed.runtime.commands.start).toBeUndefined();
  });

  it("rejects an unsupported format version", () => {
    expect(() => decodeManifest({ ...minimalManifest, formatVersion: "2.0" })).toThrow();
  });

  it("rejects a pack with no interface", () => {
    expect(() => decodeManifest({ ...minimalManifest, interfaces: [] })).toThrow();
  });

  it("rejects a verified status without a verifier or checks", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        verification: { status: "verified", verifiedAt: "2026-08-07T18:00:00.000Z" },
      }),
    ).toThrow();

    expect(() =>
      decodeManifest({
        ...minimalManifest,
        verification: {
          status: "verified",
          verifiedAt: "2026-08-07T18:00:00.000Z",
          verifier: { displayName: "T3 Pack Review" },
          checks: [],
        },
      }),
    ).toThrow();
  });

  it("rejects a workspace-scoped pack that names no workspace key", () => {
    expect(() =>
      decodeManifest({ ...minimalManifest, visibility: { scope: "workspace" } }),
    ).toThrow();
  });

  it("rejects a non-semver version", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        identity: { ...minimalManifest.identity, version: "1.2" },
      }),
    ).toThrow();
  });

  it("rejects an uppercase pack name", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        identity: { ...minimalManifest.identity, name: "Stripe-Checkout" },
      }),
    ).toThrow();
  });

  it("rejects a lowercase environment variable requirement", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        requirements: {
          environment: [
            {
              name: "stripe_secret_key",
              purpose: "Server-side Stripe API calls.",
              secret: true,
              required: true,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects an environment requirement that omits its secrecy", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        requirements: {
          environment: [
            {
              name: "STRIPE_SECRET_KEY",
              purpose: "Server-side Stripe API calls.",
              required: true,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects a handover without a path", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        provenance: {
          ...minimalManifest.provenance,
          handover: { summary: "Lifted the checkout flow out." },
        },
      }),
    ).toThrow();
  });

  it("rejects a contents path that escapes the pack directory", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        contents: { sourceRoot: "../../etc" },
      }),
    ).toThrow();
  });

  it("rejects an egress host that allows everything", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        permissions: {
          network: [{ host: "*", purpose: "Talks to whatever it likes." }],
        },
      }),
    ).toThrow();
  });

  it("rejects an elevated capability with no justification", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        permissions: { elevated: [{ capability: "docker-socket" }] },
      }),
    ).toThrow();
  });

  it("rejects an api interface with no operations", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        interfaces: [
          {
            kind: "api",
            id: "checkout-api",
            title: "Checkout API",
            protocol: "http",
            operations: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an unknown interface kind", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        interfaces: [{ kind: "desktop", id: "app", title: "App" }],
      }),
    ).toThrow();
  });
});

describe("PackManifestEnvelope", () => {
  it("reads the format version ahead of the rest of the manifest", () => {
    const parsed = decodeEnvelope({ formatVersion: "9.9", identity: { garbage: true } });

    expect(parsed.formatVersion).toBe("9.9");
  });
});

describe("pack registry projections", () => {
  it("flattens a manifest into something an agent can scan", () => {
    const parsed = decodeSummary({
      ref: {
        id: PackId.make("pack_01J9Z0C4Q3"),
        name: "stripe-checkout",
        version: "1.2.0",
        publisherHandle: "acme",
      },
      displayName: "Stripe Checkout",
      summary: "Hosted Stripe checkout with webhook reconciliation.",
      does: "Turns a cart total into a paid Stripe order.",
      categories: ["payments"],
      tags: ["stripe"],
      interfaceKinds: ["api", "web"],
      requiredEnvironment: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      requiredAccounts: ["stripe"],
      verificationStatus: "verified",
      visibilityScope: "public",
      license: "Apache-2.0",
      updatedAt: "2026-08-07T18:00:00.000Z",
    });

    expect(parsed.requiredEnvironment).toHaveLength(2);
    expect(parsed.interfaceKinds).toEqual(["api", "web"]);
  });

  it("reports publish readiness separately from schema validity", () => {
    const parsed = decodeReadinessReport({
      ref: {
        id: PackId.make("pack_01J9Z0C4Q3"),
        name: "stripe-checkout",
        version: "0.1.0",
        publisherHandle: "waleed",
      },
      publishable: false,
      issues: [
        {
          code: "start-command-missing",
          severity: "error",
          path: "runtime.commands.start",
          message: "A pack exposing an api interface must declare how it starts.",
        },
        {
          code: "signature-missing",
          severity: "warning",
          path: "signature",
          message: "Unsigned releases cannot be attributed to a publisher key.",
        },
      ],
    });

    expect(parsed.publishable).toBe(false);
    expect(parsed.issues[0]?.code).toBe("start-command-missing");
  });
});
