import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PACK_FORMAT_VERSION,
  PACK_SUPERSEDED_FORMAT_VERSIONS,
  PACK_SURFACE_HALF_LIFE_DAYS,
  PACK_VISIBILITY_WIDTH,
  PackId,
  PackManifest,
  PackManifestEnvelope,
  PackReadinessReport,
  PackReleaseHistory,
  PackSigningKeyId,
  PackSummary,
  PackWorkspaceKeyId,
} from "./pack.ts";

const decodeManifest = Schema.decodeUnknownSync(PackManifest);
const decodeEnvelope = Schema.decodeUnknownSync(PackManifestEnvelope);
const decodeSummary = Schema.decodeUnknownSync(PackSummary);
const decodeReadinessReport = Schema.decodeUnknownSync(PackReadinessReport);
const decodeReleaseHistory = Schema.decodeUnknownSync(PackReleaseHistory);

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
  knowledge: {},
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
  verification: {
    record: {
      measuredAt: "2026-08-07T09:12:00.000Z",
      installsAttempted: 0,
      installsSucceeded: 0,
      deploymentsAttempted: 0,
      deploymentsSurviving: 0,
      cumulativeServiceDays: 0,
      breakagesCaught: 0,
      breakagesFixed: 0,
    },
  },
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
  knowledge: {
    failureModes: [
      {
        id: "webhook-retry-double-charge",
        symptom: "A buyer is charged twice for one cart within a few seconds.",
        trigger:
          "Stripe redelivers payment_intent.succeeded when the first delivery times out. Handlers keyed on the event id alone still create a second order because the order write and the event write are not in one transaction.",
        triggerKinds: ["retry", "idempotency", "race-condition"],
        attributedTo: { kind: "provider", service: "stripe", apiVersion: "2026-04-10" },
        severity: "critical",
        silent: true,
        detection: {
          signal: "reconciliation-mismatch",
          match: "orders.payment_intent_id count > 1",
          checkId: "webhook-idempotency",
        },
        resolution: {
          kind: "fixed",
          inVersion: "1.1.0",
          change:
            "Insert the event id into a processed_events table inside the same transaction as the order write, and return 200 on conflict.",
          checkId: "webhook-idempotency",
        },
        standing: {
          state: "holding",
          heldInDeployments: 26,
          recurredInDeployments: 0,
          lastCheckedAt: "2026-08-07T06:00:00.000Z",
        },
        firstSeenAt: "2026-05-02T04:19:00.000Z",
        lastSeenAt: "2026-06-18T22:40:00.000Z",
        deploymentsAffected: 11,
        conditions: {
          observedAt: "2026-06-18T22:40:00.000Z",
          accountTier: "standard",
          regions: ["us", "eu-west-1"],
          apiVersion: "2026-04-10",
          observedAcrossDeployments: 11,
          untestedAxes: ["plan"],
          rot: { basis: "assumed", surface: "protocol-invariant" },
        },
        origin: {
          introducedIn: "1.1.0",
          source: {
            kind: "maintenance-agent",
            provider: "claudeAgent",
            model: "claude-opus-5",
            runId: "run_01J9ZMAINT",
          },
          recordedAt: "2026-05-02T05:00:00.000Z",
          deploymentKeyIds: ["dep_1f8c", "dep_44ae"],
        },
      },
      {
        id: "restricted-key-missing-read-scope",
        symptom: "Reconciliation returns 403 while checkout itself keeps working.",
        trigger:
          "A restricted key created with only checkout_sessions:write passes install, because nothing reads payment intents until the first reconcile run hours later.",
        triggerKinds: ["permission-denied", "misconfiguration"],
        attributedTo: { kind: "provider", service: "stripe" },
        severity: "medium",
        detection: { signal: "provider-error-code", match: "resource_missing|permission_error" },
        resolution: {
          kind: "open",
          currentAdvice:
            "Run `checkout reconcile --since 1h` immediately after install so a missing scope fails while the console is still open.",
        },
        standing: {
          state: "recurring",
          heldInDeployments: 0,
          recurredInDeployments: 4,
          lastCheckedAt: "2026-08-07T06:00:00.000Z",
        },
        firstSeenAt: "2026-07-11T13:05:00.000Z",
        deploymentsAffected: 4,
        conditions: {
          observedAt: "2026-07-11T13:05:00.000Z",
          accountTier: "standard",
          regions: ["us"],
          consoleVersion: "2026.07",
          untestedAxes: ["account-tier", "region"],
          rot: { basis: "assumed", surface: "console-navigation" },
        },
        origin: {
          introducedIn: "1.2.0",
          source: { kind: "install-report", target: "cursor" },
          recordedAt: "2026-07-11T14:00:00.000Z",
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
          consoleUrl: "https://dashboard.stripe.com/apikeys",
          navigation: [
            {
              action: "Open Developers → API keys in the Stripe dashboard.",
              url: "https://dashboard.stripe.com/apikeys",
              expect: "A table headed Standard keys with a Restricted keys section beneath it.",
            },
            {
              action: "Choose Create restricted key, not Reveal on the standard secret key.",
              expect: "A permission list with every resource set to None by default.",
            },
            {
              action:
                "Set Checkout Sessions to Write and Payment Intents to Read, leave the rest at None, then create.",
              expect: "The key is shown once, prefixed rk_live_ rather than sk_live_.",
            },
          ],
          scopes: [
            {
              name: "checkout_sessions:write",
              purpose: "Creates the hosted session the buyer is redirected to.",
              required: true,
            },
            {
              name: "payment_intents:read",
              purpose: "Reconciles orders against Stripe after a missed webhook.",
              required: true,
            },
          ],
          rotation:
            "Restricted keys are not rotated by Stripe. Create the replacement, deploy, then delete the old key from the same screen.",
        },
        conditions: {
          observedAt: "2026-07-30T09:00:00.000Z",
          accountTier: "standard",
          regions: ["us"],
          consoleVersion: "2026.07",
          observedAcrossDeployments: 26,
          untestedAxes: ["account-tier", "region", "locale"],
          rot: {
            basis: "observed",
            surface: "console-navigation",
            halfLifeDays: 63,
            fromInstalls: 27,
            measuredAt: "2026-08-07T18:00:00.000Z",
          },
        },
        origin: {
          introducedIn: "1.0.0",
          source: { kind: "human-report", reportedByUserId: "user-1" },
          recordedAt: "2026-03-04T11:00:00.000Z",
          supersedes: "stripe-secret-key-legacy",
        },
        standing: {
          state: "holding",
          confirmedInInstalls: 26,
          contradictedInInstalls: 1,
          lastConfirmedAt: "2026-07-30T09:00:00.000Z",
        },
        commonMistake:
          "Models send the installer to Settings → API keys and tell them to copy the standard secret key, which grants the whole account and is the wrong key entirely.",
        preventsFailureModeIds: ["restricted-key-missing-read-scope"],
      },
      {
        id: "wire-webhook-before-cart",
        title: "Mount the webhook route before touching the cart page",
        detail: {
          kind: "wiring",
          prompt:
            "Mount POST /api/checkout/webhook with the raw request body, verify the signature, then persist the event id and the order in one transaction. Only once that round-trips should you add the cart button that calls /api/checkout/sessions.",
          interfaceId: "checkout-api",
          touches: ["source/server.ts", "source/webhook.ts"],
        },
        conditions: {
          observedAt: "2026-07-30T09:00:00.000Z",
          observedAcrossDeployments: 26,
        },
        origin: {
          introducedIn: "1.1.0",
          source: { kind: "deployment-telemetry", signal: "checkout.payment_succeeded" },
          recordedAt: "2026-05-03T08:00:00.000Z",
        },
        preventsFailureModeIds: ["webhook-retry-double-charge"],
      },
      {
        id: "checkout-customisation-boundary",
        title: "What is safe to change in the checkout flow",
        detail: {
          kind: "boundary",
          decisions: [
            {
              subject: "Success and cancel URLs, currency, and the line item labels.",
              latitude: "safe-to-change",
              reason: "Read from configuration and never used to key anything.",
            },
            {
              subject: "The processed_events insert inside the order transaction.",
              latitude: "frozen",
              reason: "Removing it reintroduces duplicate charges under webhook retries.",
              failureModeId: "webhook-retry-double-charge",
              path: "source/webhook.ts",
            },
          ],
        },
        conditions: { observedAt: "2026-07-30T09:00:00.000Z" },
        origin: {
          introducedIn: "1.1.0",
          source: {
            kind: "maintenance-agent",
            provider: "claudeAgent",
            model: "claude-opus-5",
          },
          recordedAt: "2026-05-03T08:00:00.000Z",
        },
      },
      {
        id: "idempotency-pattern",
        title: "Key idempotency on the provider event id, not the order id",
        detail: {
          kind: "pattern",
          rule: "Every handler writes the provider event id to a uniquely indexed table in the same transaction as the effect it causes, and treats a conflict as success.",
          rationale:
            "Retries are the provider's normal behaviour, so at-least-once delivery has to be absorbed rather than avoided.",
          example: "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
        },
        conditions: {
          observedAt: "2026-07-30T09:00:00.000Z",
          apiVersion: "2026-04-10",
          observedAcrossDeployments: 26,
        },
        origin: {
          introducedIn: "1.1.0",
          source: {
            kind: "inherited",
            packId: PackId.make("pack_01H0PARENT"),
            packName: "payments-core",
            packVersion: "0.4.1",
            entryId: "idempotency-pattern",
          },
          recordedAt: "2026-05-03T08:00:00.000Z",
        },
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
        cost: {
          model: "metered",
          billedOn: "A percentage of every payment processed.",
          pricingUrl: "https://stripe.com/pricing",
        },
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
        cost: {
          model: "free-tier",
          billedOn: "Storage and connection hours on whatever hosts it.",
          freeTierLimit: "Most managed providers stop being free somewhere near 500MB.",
        },
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
    record: {
      measuredAt: "2026-08-07T18:00:00.000Z",
      scope: "lineage",
      installsAttempted: 41,
      installsSucceeded: 37,
      deploymentsAttempted: 37,
      deploymentsSurviving: 29,
      survival: {
        cohortSize: 37,
        aliveAtDay30: 31,
        aliveAtDay60: 27,
        aliveAtDay90: 22,
      },
      cumulativeServiceDays: 2_940,
      longestServiceDays: 188,
      firstDeployedAt: "2026-02-01T10:00:00.000Z",
      breakagesCaught: 2,
      breakagesFixed: 1,
      knowledgeContradictions: 1,
    },
    checks: [
      {
        id: "webhook-idempotency",
        title: "Replays a duplicate payment_intent.succeeded and expects one order.",
        command: "npm run test:idempotency",
        runsOn: ["install", "schedule"],
        guardsFailureModeId: "webhook-retry-double-charge",
        runs: 812,
        passes: 810,
        deploymentsCovered: 29,
        lastRunAt: "2026-08-07T06:00:00.000Z",
        lastOutcome: "pass",
      },
      {
        id: "restricted-key-scopes",
        title: "Calls both Stripe endpoints the pack needs with the supplied key.",
        command: "node scripts/verify-key.mjs",
        runsOn: ["install"],
        runs: 37,
        passes: 33,
        deploymentsCovered: 37,
        lastRunAt: "2026-08-05T12:00:00.000Z",
        lastOutcome: "pass",
      },
    ],
    attestations: [
      {
        attestedAt: "2026-08-07T18:00:00.000Z",
        attestedBy: { type: "user", userId: "user-reviewer", displayName: "Acme Platform" },
        did: ["installed-from-clean", "ran-checks", "deployed-to-production"],
        conditions: {
          observedAt: "2026-08-07T18:00:00.000Z",
          accountTier: "standard",
          regions: ["us"],
        },
        note: "Installed into an unrelated Next.js storefront from a clean checkout.",
      },
    ],
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

  it("carries production signals a consumer can threshold itself", () => {
    const parsed = decodeManifest(fullManifest);
    const record = parsed.verification.record;

    expect(record.installsAttempted).toBeGreaterThan(record.installsSucceeded);
    expect(record.deploymentsSurviving).toBe(29);
    expect(record.breakagesCaught).toBe(2);
    expect(parsed.verification.checks?.[0]?.guardsFailureModeId).toBe(
      "webhook-retry-double-charge",
    );
    expect(parsed.verification.advisories).toBeUndefined();
  });

  it("says whether a record covers one release or the whole line", () => {
    const parsed = decodeManifest(fullManifest);
    const minimal = decodeManifest(minimalManifest);

    expect(parsed.verification.record.scope).toBe("lineage");
    // Absent means lineage, which is what every record written before the field
    // existed meant — so an old manifest keeps reading correctly.
    expect(minimal.verification.record.scope).toBeUndefined();
  });

  it("carries the cost of a service, not only of a third-party account", () => {
    const parsed = decodeManifest(fullManifest);
    const account = parsed.requirements.accounts?.[0];
    const service = parsed.requirements.services?.[0];

    expect(account?.cost?.model).toBe("metered");
    expect(account?.costsMoney).toBe(true);
    expect(service?.cost?.model).toBe("free-tier");
    expect(service?.cost?.freeTierLimit).toContain("500MB");
  });

  it("drops a price rather than freezing one into a manifest that outlives it", () => {
    const parsed = decodeManifest({
      ...minimalManifest,
      requirements: {
        services: [
          {
            kind: "object-storage",
            name: "receipts",
            purpose: "Holds rendered receipts.",
            cost: { model: "metered", monthlyUsd: 12, pricingUrl: "https://example.com/pricing" },
          },
        ],
      },
    });

    const cost = parsed.requirements.services?.[0]?.cost;
    expect(cost?.model).toBe("metered");
    expect(Object.keys(cost ?? {})).not.toContain("monthlyUsd");
    expect(cost?.pricingUrl).toBe("https://example.com/pricing");
  });

  it("keeps an attestation from outranking what production reported", () => {
    const parsed = decodeManifest(fullManifest);
    const attestation = parsed.verification.attestations?.[0];

    expect(attestation?.did).toContain("deployed-to-production");
    expect(attestation?.conditions?.accountTier).toBe("standard");
    expect(Object.keys(parsed.verification)).not.toContain("status");
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
    expect(parsed.knowledge.failureModes).toBeUndefined();
    expect(parsed.verification.record.deploymentsAttempted).toBe(0);
    expect(parsed.visibility.scope).toBe("unlisted");
    expect(parsed.runtime.commands.start).toBeUndefined();
  });

  it("rejects an unsupported format version", () => {
    expect(() => decodeManifest({ ...minimalManifest, formatVersion: "3.0" })).toThrow();
    expect(() =>
      decodeManifest({ ...minimalManifest, formatVersion: PACK_SUPERSEDED_FORMAT_VERSIONS[0] }),
    ).toThrow();
  });

  it("insists on a knowledge section even when there is nothing in it", () => {
    const { knowledge: _knowledge, ...withoutKnowledge } = minimalManifest;

    expect(() => decodeManifest(withoutKnowledge)).toThrow();
  });

  it("insists on a scar record even when every count is zero", () => {
    expect(() => decodeManifest({ ...minimalManifest, verification: {} })).toThrow();
  });

  it("rejects a pack with no interface", () => {
    expect(() => decodeManifest({ ...minimalManifest, interfaces: [] })).toThrow();
  });

  it("rejects a scar record with no as-of moment", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        verification: {
          record: {
            installsAttempted: 40,
            installsSucceeded: 40,
            deploymentsAttempted: 40,
            deploymentsSurviving: 40,
            cumulativeServiceDays: 900,
            breakagesCaught: 0,
            breakagesFixed: 0,
          },
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

describe("pack knowledge", () => {
  const knowledge = decodeManifest(fullManifest).knowledge;

  it("carries the credential retrieval a model would otherwise invent", () => {
    const entry = knowledge.integration?.find((item) => item.id === "stripe-restricted-key");

    if (entry?.detail.kind !== "credential-retrieval") {
      throw new Error("Expected credential retrieval knowledge");
    }
    expect(entry.detail.environmentVariable).toBe("STRIPE_SECRET_KEY");
    expect(entry.detail.navigation).toHaveLength(3);
    expect(entry.detail.navigation[0]?.expect).toBeDefined();
    expect(entry.detail.scopes?.every((scope) => scope.required)).toBe(true);
    expect(entry.commonMistake).toContain("standard secret key");
  });

  it("scopes each claim to the conditions it was seen under rather than the pack", () => {
    const observedAt = knowledge.integration?.map((entry) => entry.conditions.observedAt);
    const credential = knowledge.integration?.[0];

    expect(observedAt).toHaveLength(4);
    expect(credential?.conditions.accountTier).toBe("standard");
    expect(credential?.conditions.untestedAxes).toContain("region");
    expect(knowledge.failureModes?.[0]?.conditions.regions).toEqual(["us", "eu-west-1"]);
  });

  it("records which release introduced each piece and where it came from", () => {
    const inherited = knowledge.integration?.find((entry) => entry.id === "idempotency-pattern");
    const failure = knowledge.failureModes?.[0];

    if (inherited?.origin.source.kind !== "inherited") {
      throw new Error("Expected inherited knowledge");
    }
    expect(inherited.origin.source.packName).toBe("payments-core");
    expect(inherited.origin.introducedIn).toBe("1.1.0");
    expect(failure?.origin.source.kind).toBe("maintenance-agent");
    expect(failure?.origin.deploymentKeyIds).toHaveLength(2);
  });

  it("ties a frozen customisation decision to the failure that froze it", () => {
    const boundary = knowledge.integration?.find(
      (entry) => entry.id === "checkout-customisation-boundary",
    );

    if (boundary?.detail.kind !== "boundary") {
      throw new Error("Expected boundary knowledge");
    }
    const frozen = boundary.detail.decisions.find((entry) => entry.latitude === "frozen");
    expect(frozen?.failureModeId).toBe("webhook-retry-double-charge");
  });

  it("keeps an unresolved failure mode carrying advice rather than silence", () => {
    const open = knowledge.failureModes?.find(
      (entry) => entry.id === "restricted-key-missing-read-scope",
    );

    if (open?.resolution.kind !== "open") {
      throw new Error("Expected an open failure mode");
    }
    expect(open.resolution.currentAdvice).toContain("reconcile");
    expect(open.deploymentsAffected).toBe(4);
  });

  it("rejects a failure mode with no conditions", () => {
    const [first] = knowledge.failureModes ?? [];
    const { conditions: _conditions, ...unconditioned } = first ?? {};

    expect(() =>
      decodeManifest({
        ...minimalManifest,
        knowledge: { failureModes: [unconditioned] },
      }),
    ).toThrow();
  });

  it("rejects conditions with no observation date", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        knowledge: {
          integration: [
            {
              id: "stripe-restricted-key",
              title: "Create the restricted Stripe key.",
              detail: {
                kind: "credential-retrieval",
                environmentVariable: "STRIPE_SECRET_KEY",
                service: "stripe",
                navigation: [{ action: "Open Developers → API keys." }],
              },
              conditions: { accountTier: "standard" },
              origin: {
                introducedIn: "1.0.0",
                source: { kind: "deployment-telemetry" },
                recordedAt: "2026-03-04T11:00:00.000Z",
              },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("ages a console path faster than a protocol invariant", () => {
    const credential = knowledge.integration?.find((entry) => entry.id === "stripe-restricted-key");
    const doubleCharge = knowledge.failureModes?.find(
      (entry) => entry.id === "webhook-retry-double-charge",
    );

    if (credential?.conditions.rot?.basis !== "observed") {
      throw new Error("Expected a measured rot rate");
    }
    expect(credential.conditions.rot.halfLifeDays).toBe(63);
    expect(credential.conditions.rot.fromInstalls).toBe(27);

    expect(doubleCharge?.conditions.rot?.surface).toBe("protocol-invariant");
    expect(PACK_SURFACE_HALF_LIFE_DAYS["protocol-invariant"]).toBeNull();
    expect(PACK_SURFACE_HALF_LIFE_DAYS["console-navigation"]).toBeLessThan(
      PACK_SURFACE_HALF_LIFE_DAYS["provider-api"] ?? 0,
    );
  });

  it("keeps a measured rot rate distinguishable from the default for its surface", () => {
    const assumed = knowledge.failureModes?.[1]?.conditions.rot;

    expect(assumed?.basis).toBe("assumed");
    if (assumed?.basis !== "assumed") throw new Error("Expected an assumed rot rate");
    expect(Object.keys(assumed)).not.toContain("halfLifeDays");
  });

  it("rejects a rot rate that claims measurement without saying what from", () => {
    const [first] = knowledge.failureModes ?? [];

    expect(() =>
      decodeManifest({
        ...minimalManifest,
        knowledge: {
          failureModes: [
            {
              ...first,
              conditions: {
                observedAt: "2026-06-18T22:40:00.000Z",
                rot: { basis: "observed", surface: "console-navigation", halfLifeDays: 63 },
              },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("answers 'is this still holding?' for a failure mode as well as an instruction", () => {
    const fixed = knowledge.failureModes?.find(
      (entry) => entry.id === "webhook-retry-double-charge",
    );
    const open = knowledge.failureModes?.find(
      (entry) => entry.id === "restricted-key-missing-read-scope",
    );

    expect(fixed?.standing?.state).toBe("holding");
    expect(fixed?.standing?.recurredInDeployments).toBe(0);
    expect(open?.standing?.state).toBe("recurring");
    expect(open?.standing?.recurredInDeployments).toBe(4);
  });

  it("counts a failure mode's standing in deployments and an instruction's in installs", () => {
    const failure = knowledge.failureModes?.[0]?.standing;
    const instruction = knowledge.integration?.[0]?.standing;

    expect(Object.keys(failure ?? {})).not.toContain("confirmedInInstalls");
    expect(Object.keys(instruction ?? {})).not.toContain("heldInDeployments");
  });

  it("rejects credential knowledge that names no way to reach the console", () => {
    expect(() =>
      decodeManifest({
        ...minimalManifest,
        knowledge: {
          integration: [
            {
              id: "stripe-restricted-key",
              title: "Create the restricted Stripe key.",
              detail: {
                kind: "credential-retrieval",
                environmentVariable: "STRIPE_SECRET_KEY",
                service: "stripe",
                navigation: [],
              },
              conditions: { observedAt: "2026-07-30T09:00:00.000Z" },
              origin: {
                introducedIn: "1.0.0",
                source: { kind: "deployment-telemetry" },
                recordedAt: "2026-03-04T11:00:00.000Z",
              },
            },
          ],
        },
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
      installsAttempted: 41,
      installsSucceeded: 37,
      deploymentsSurviving: 29,
      cumulativeServiceDays: 2_940,
      breakagesCaught: 2,
      knownFailureModes: 2,
      openFailureModes: 1,
      integrationKnowledgeEntries: 4,
      knowledgeOldestObservedAt: "2026-06-18T22:40:00.000Z",
      hasAdvisory: false,
      visibilityScope: "public",
      license: "Apache-2.0",
      updatedAt: "2026-08-07T18:00:00.000Z",
    });

    expect(parsed.requiredEnvironment).toHaveLength(2);
    expect(parsed.interfaceKinds).toEqual(["api", "web"]);
    expect(parsed.installsSucceeded).toBeLessThan(parsed.installsAttempted);
    expect(parsed.openFailureModes).toBe(1);
  });

  it("dates a release by when it became visible, not by when it was cut", () => {
    const history = decodeReleaseHistory({
      packId: PackId.make("pack_01J9Z0C4Q3"),
      latestVersion: "1.2.0",
      releases: [
        {
          version: "1.2.0",
          cutAt: "2026-07-29T16:00:00.000Z",
          publications: [
            { scope: "workspace", at: "2026-07-30T09:00:00.000Z" },
            { scope: "public", at: "2026-08-01T10:00:00.000Z" },
          ],
          signals: {
            measuredAt: "2026-08-07T18:00:00.000Z",
            scope: "release",
            installsAttempted: 13,
            installsSucceeded: 12,
            deploymentsAttempted: 12,
            deploymentsSurviving: 11,
            cumulativeServiceDays: 96,
            breakagesCaught: 0,
            breakagesFixed: 0,
          },
        },
      ],
    });

    const release = history.releases[0];
    expect(release.cutAt).not.toBe(release.publications[0]?.at);
    expect(release.publications.at(-1)?.scope).toBe("public");
    expect(release.signals?.scope).toBe("release");
    expect(PACK_VISIBILITY_WIDTH.public).toBeGreaterThan(PACK_VISIBILITY_WIDTH.workspace);
  });

  it("keeps a withdrawal in the log rather than erasing the publication", () => {
    const history = decodeReleaseHistory({
      packId: PackId.make("pack_01J9Z0C4Q3"),
      latestVersion: "1.0.0",
      releases: [
        {
          version: "1.0.0",
          cutAt: "2026-02-01T09:00:00.000Z",
          publications: [
            { scope: "public", at: "2026-02-01T10:00:00.000Z" },
            { scope: "workspace", at: "2026-03-01T10:00:00.000Z" },
          ],
        },
      ],
    });

    const publications = history.releases[0].publications;
    expect(publications).toHaveLength(2);
    expect(
      PACK_VISIBILITY_WIDTH[publications[1]?.scope ?? "public"] <
        PACK_VISIBILITY_WIDTH[publications[0]?.scope ?? "workspace"],
    ).toBe(true);
  });

  it("treats a release nobody has published as published nowhere rather than as missing", () => {
    const history = decodeReleaseHistory({
      packId: PackId.make("pack_01K2NEW7RS"),
      latestVersion: "0.1.0",
      releases: [{ version: "0.1.0", cutAt: "2026-08-08T08:40:00.000Z", publications: [] }],
    });

    expect(history.releases[0].publications).toEqual([]);
  });

  it("rejects a release history with no releases in it", () => {
    expect(() =>
      decodeReleaseHistory({
        packId: PackId.make("pack_01K2NEW7RS"),
        latestVersion: "0.1.0",
        releases: [],
      }),
    ).toThrow();
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
