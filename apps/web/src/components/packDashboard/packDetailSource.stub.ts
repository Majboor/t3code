import {
  OrganizationId,
  PACK_FORMAT_VERSION,
  PackDeploymentKeyId,
  PackId,
  PackWorkspaceKeyId,
  TenantId,
  UserId,
  WorkspaceId,
  type PackManifest,
  type PackVisibility,
} from "@t3tools/contracts";

import type {
  PackDetail,
  PackDetailRequest,
  PackDetailSource,
  PackRelease,
  PackVisibilityChangeRequest,
  PackVisibilityScope,
} from "./packDetailSource";

/**
 * STUB DATA SOURCE. There is no pack RPC yet, so this stands in for one. What
 * it returns is a real `PackManifest`, which is the point: the served registry
 * has the same shape to meet and nothing above `packDetailSource.ts` has to
 * change when it arrives. Nothing else in the app imports this file.
 *
 * The two entries are deliberately opposite. One has six months of production
 * behind it and a record to read; the other was cut this morning and has
 * learned nothing, which the page has to be able to say without dressing it up.
 */

const WORKSPACE_KEY_ID = PackWorkspaceKeyId.make("wsk_7f3a91");

const STRIPE_CHECKOUT: PackManifest = {
  formatVersion: PACK_FORMAT_VERSION,
  identity: {
    id: PackId.make("pack_01J9Z0C4Q3"),
    name: "stripe-checkout",
    version: "1.2.0",
    displayName: "Stripe Checkout",
    summary: "Hosted Stripe checkout with webhook reconciliation.",
    description:
      "Extracted from a working storefront after six months in production: session creation, the redirect, and the webhook handler that keeps orders in step with Stripe.",
    publisher: {
      type: "organization",
      handle: "acme",
      displayName: "Acme",
      contactUrl: "https://acme.example/support",
    },
    license: "Apache-2.0",
    categories: ["payments", "commerce"],
    tags: ["stripe", "checkout", "webhooks"],
    repositoryUrl: "https://github.com/acme/storefront",
  },
  provenance: {
    workspace: {
      workspaceKeyId: WORKSPACE_KEY_ID,
      workspaceId: WorkspaceId.make("workspace-storefront"),
      title: "Storefront",
    },
    extractedAt: "2026-08-07T09:12:00.000Z",
    extractedBy: {
      type: "agent",
      provider: "claudeAgent",
      model: "claude-opus-5",
      onBehalfOfUserId: UserId.make("user-1"),
    },
    handover: {
      path: "handover.md",
      summary:
        "Session creation, redirect and webhook reconciliation, minus the cart UI. The reconcile command is the part to run first after install; it is what surfaces a key created with the wrong scopes.",
      generatedAt: "2026-08-07T09:12:00.000Z",
    },
    source: {
      repositoryUrl: "https://github.com/acme/storefront",
      branch: "main",
      commitSha: "9a1f2c4",
      dirty: false,
    },
  },
  capability: {
    does: "Turns a cart total into a paid Stripe order.",
    useCases: ["One-off product checkout", "Subscription upgrade flow"],
    nonGoals: [
      "Does not store cards",
      "Does not handle refunds or disputes",
      "Does not price or tax the cart",
    ],
  },
  knowledge: {
    failureModes: [
      {
        id: "webhook-retry-double-charge",
        symptom: "A buyer is charged twice for one cart within a few seconds.",
        trigger:
          "Stripe redelivers payment_intent.succeeded when the first delivery times out. Handlers keyed on the event id alone still create a second order, because the order write and the event write are not in one transaction.",
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
          deploymentKeyIds: [
            PackDeploymentKeyId.make("dep_1f8c"),
            PackDeploymentKeyId.make("dep_44ae"),
          ],
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
        detection: {
          signal: "provider-error-code",
          match: "resource_missing|permission_error",
        },
        resolution: {
          kind: "open",
          currentAdvice:
            "Run `checkout reconcile --since 1h` immediately after install, so a missing scope fails while the console is still open in front of you.",
        },
        firstSeenAt: "2026-07-11T13:05:00.000Z",
        deploymentsAffected: 4,
        conditions: {
          observedAt: "2026-07-11T13:05:00.000Z",
          accountTier: "standard",
          regions: ["us"],
          consoleVersion: "2026.07",
          untestedAxes: ["account-tier", "region"],
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
              expect: "A table headed Standard keys, with a Restricted keys section beneath it.",
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
        },
        origin: {
          introducedIn: "1.0.0",
          source: { kind: "human-report", reportedByUserId: UserId.make("user-1") },
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
          source: { kind: "maintenance-agent", provider: "claudeAgent", model: "claude-opus-5" },
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
        example: "rk_live_...",
        obtainUrl: "https://dashboard.stripe.com/apikeys",
        pattern: "^rk_(test|live)_[A-Za-z0-9]+$",
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
    setupSteps: [
      {
        title: "Create the restricted Stripe key",
        instructions:
          "Open the Stripe dashboard, create a restricted key with the two scopes below, and paste it when asked.",
        satisfies: ["STRIPE_SECRET_KEY"],
        manual: true,
      },
      {
        title: "Register the webhook endpoint",
        instructions: "Point Stripe at /api/checkout/webhook and copy the signing secret.",
        command: "stripe listen --forward-to localhost:3000/api/checkout/webhook",
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
      start: { command: "node dist/server.js", description: "Serves the API and return page." },
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
    ],
    acceptsInboundNetwork: true,
    secrets: [
      { name: "STRIPE_SECRET_KEY", purpose: "Signs Stripe API calls." },
      { name: "STRIPE_WEBHOOK_SECRET", purpose: "Verifies inbound webhook signatures." },
    ],
  },
  verification: {
    record: {
      measuredAt: "2026-08-07T18:00:00.000Z",
      installsAttempted: 41,
      installsSucceeded: 37,
      deploymentsAttempted: 37,
      deploymentsSurviving: 29,
      survival: { cohortSize: 37, aliveAtDay30: 31, aliveAtDay60: 27, aliveAtDay90: 22 },
      cumulativeServiceDays: 2940,
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
        attestedBy: {
          type: "user",
          userId: UserId.make("user-reviewer"),
          displayName: "Acme Platform",
        },
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
  visibility: { scope: "workspace", workspaceKeyId: WORKSPACE_KEY_ID },
  integration: {
    prompt:
      "Add the acme/stripe-checkout pack. Ask me for STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and CHECKOUT_SUCCESS_URL before writing anything. Mount POST /api/checkout/webhook first, verify the signature against the raw body, and write the Stripe event id and the order in one transaction — a retried delivery must not create a second order. Only then add the cart button that POSTs to /api/checkout/sessions and redirects to the returned URL. Read the pack's integration knowledge before you write code, and keep its checks running after install.",
    installCommand: "t3 pack install acme/stripe-checkout@1.2.0",
    variants: [
      {
        target: "lovable",
        prompt:
          "Use the acme/stripe-checkout pack for payments. Lovable hosts the app, so point the pack's webhook at your own deployed URL rather than a tunnel: create a checkout button that POSTs the cart to /api/checkout/sessions, redirect to the returned URL, and add the /api/checkout/webhook route with raw-body signature verification. Write the Stripe event id alongside the order in one transaction, or a retried webhook will charge the buyer twice.",
      },
      {
        target: "replit",
        prompt:
          "Use the acme/stripe-checkout pack for payments. Put STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Replit Secrets rather than a .env file, and bind the server to the PORT Replit provides. Mount /api/checkout/webhook with the raw body before adding the cart button, and persist the Stripe event id in the same transaction as the order so a redelivery cannot double-charge.",
      },
    ],
    followUpQuestions: [
      "Which currency should orders settle in?",
      "Is there an existing orders table this should write into, or should it create one?",
    ],
  },
};

const RECEIPT_PDF: PackManifest = {
  formatVersion: PACK_FORMAT_VERSION,
  identity: {
    id: PackId.make("pack_01K2NEW7RS"),
    name: "receipt-pdf",
    version: "0.1.0",
    displayName: "Receipt PDF",
    summary: "Renders an order into a printable receipt PDF.",
    publisher: { type: "user", handle: "waleed", displayName: "Waleed" },
    license: "MIT",
    categories: ["media"],
  },
  provenance: {
    workspace: {
      workspaceKeyId: WORKSPACE_KEY_ID,
      workspaceId: WorkspaceId.make("workspace-storefront"),
      title: "Storefront",
    },
    extractedAt: "2026-08-08T08:40:00.000Z",
    extractedBy: {
      type: "agent",
      provider: "claudeAgent",
      model: "claude-opus-5",
      onBehalfOfUserId: UserId.make("user-1"),
    },
    handover: {
      path: "handover.md",
      summary:
        "Cut this morning out of the storefront's receipt route. It renders and it has never been deployed anywhere.",
      generatedAt: "2026-08-08T08:40:00.000Z",
    },
  },
  capability: {
    does: "Renders an order into a printable receipt PDF.",
    nonGoals: ["Does not email the receipt", "Does not calculate tax"],
  },
  knowledge: {},
  requirements: {
    toolchain: [{ name: "node", versionRange: ">=22" }],
  },
  interfaces: [
    {
      kind: "library",
      id: "receipt",
      title: "Receipt renderer",
      language: "typescript",
      importPath: "source/index.ts",
      exports: [
        {
          name: "renderReceipt",
          kind: "function",
          summary: "Renders an order object into a PDF buffer.",
          signature: "(order: Order) => Promise<Uint8Array>",
        },
      ],
    },
  ],
  runtime: {
    target: "node",
    commands: { install: { command: "npm ci" }, test: { command: "npm test" } },
  },
  permissions: {},
  verification: {
    record: {
      measuredAt: "2026-08-08T08:40:00.000Z",
      installsAttempted: 0,
      installsSucceeded: 0,
      deploymentsAttempted: 0,
      deploymentsSurviving: 0,
      cumulativeServiceDays: 0,
      breakagesCaught: 0,
      breakagesFixed: 0,
    },
  },
  visibility: { scope: "workspace", workspaceKeyId: WORKSPACE_KEY_ID },
  integration: {
    prompt:
      "Add the waleed/receipt-pdf pack. Import renderReceipt from the pack and call it with an order to get a PDF buffer back. Nothing has run behind this pack yet, so treat its guidance as untested: check the output against a real order before putting it in front of a customer.",
  },
};

interface StubEntry {
  readonly manifest: PackManifest;
  /** Every release, newest first. Only the newest one has a manifest here. */
  readonly releases: readonly PackRelease[];
  /** What each earlier release said, so history is readable rather than a list. */
  readonly olderManifests: ReadonlyMap<string, PackManifest>;
}

/**
 * An older release is the same manifest as it stood then: fewer knowledge
 * entries and a smaller record. Reconstructed here by subtraction, because the
 * registry will hold each release's own manifest and the page must not assume
 * the newest one is the only one that exists.
 */
function asEarlierRelease(
  manifest: PackManifest,
  version: string,
  record: PackManifest["verification"]["record"],
): PackManifest {
  const keptFailureModes = (manifest.knowledge.failureModes ?? []).filter(
    (entry) => entry.origin.introducedIn <= version,
  );
  const keptIntegration = (manifest.knowledge.integration ?? []).filter(
    (entry) => entry.origin.introducedIn <= version,
  );

  return {
    ...manifest,
    identity: { ...manifest.identity, version },
    knowledge: {
      ...(keptFailureModes.length > 0 ? { failureModes: keptFailureModes } : {}),
      ...(keptIntegration.length > 0 ? { integration: keptIntegration } : {}),
    },
    verification: { ...manifest.verification, record },
  };
}

const STUB_ENTRIES: readonly StubEntry[] = [
  {
    manifest: STRIPE_CHECKOUT,
    releases: [
      {
        version: "1.2.0",
        publishedAt: "2026-07-30T09:00:00.000Z",
        visibilityScope: "workspace",
        note: "Records the restricted key created without the read scope, which passes install and fails hours later.",
      },
      {
        version: "1.1.0",
        publishedAt: "2026-05-03T08:00:00.000Z",
        visibilityScope: "workspace",
        note: "Writes the Stripe event id in the same transaction as the order, so a redelivery cannot double-charge.",
      },
      {
        version: "1.0.0",
        publishedAt: "2026-02-01T10:00:00.000Z",
        visibilityScope: "workspace",
        note: "First release: session creation, redirect and a webhook handler.",
      },
    ],
    olderManifests: new Map([
      [
        "1.1.0",
        asEarlierRelease(STRIPE_CHECKOUT, "1.1.0", {
          measuredAt: "2026-07-30T09:00:00.000Z",
          installsAttempted: 28,
          installsSucceeded: 26,
          deploymentsAttempted: 26,
          deploymentsSurviving: 21,
          cumulativeServiceDays: 1810,
          longestServiceDays: 118,
          firstDeployedAt: "2026-02-01T10:00:00.000Z",
          breakagesCaught: 1,
          breakagesFixed: 1,
        }),
      ],
      [
        "1.0.0",
        asEarlierRelease(STRIPE_CHECKOUT, "1.0.0", {
          measuredAt: "2026-05-03T08:00:00.000Z",
          installsAttempted: 9,
          installsSucceeded: 8,
          deploymentsAttempted: 8,
          deploymentsSurviving: 5,
          cumulativeServiceDays: 340,
          longestServiceDays: 91,
          firstDeployedAt: "2026-02-01T10:00:00.000Z",
          breakagesCaught: 0,
          breakagesFixed: 0,
        }),
      ],
    ]),
  },
  {
    manifest: RECEIPT_PDF,
    releases: [
      {
        version: "0.1.0",
        publishedAt: "2026-08-08T08:40:00.000Z",
        visibilityScope: "workspace",
        note: "Cut from the storefront workspace. Nothing has run it.",
      },
    ],
    olderManifests: new Map(),
  },
];

/** Visibility is the one thing this stub mutates, because the page changes it. */
const visibilityByPackId = new Map<string, PackVisibility>();

function currentVisibility(manifest: PackManifest): PackVisibility {
  return visibilityByPackId.get(manifest.identity.id) ?? manifest.visibility;
}

function findEntry(packId: string): StubEntry | undefined {
  return STUB_ENTRIES.find(
    (entry) => entry.manifest.identity.id === packId || entry.manifest.identity.name === packId,
  );
}

function resolveVisibility(scope: PackVisibilityScope): PackVisibility {
  switch (scope) {
    case "workspace":
      return { scope: "workspace", workspaceKeyId: WORKSPACE_KEY_ID };
    case "tenant":
      return { scope: "tenant", tenantId: TenantId.make("tenant-acme") };
    case "organization":
      return { scope: "organization", organizationId: OrganizationId.make("org-acme") };
    case "unlisted":
      return { scope: "unlisted" };
    case "public":
      return { scope: "public" };
  }
}

export const stubPackDetailSource: PackDetailSource = {
  loadPack(request: PackDetailRequest): Promise<PackDetail | null> {
    const entry = findEntry(request.packId);
    if (!entry) return Promise.resolve(null);

    const latest = entry.manifest;
    const requested =
      request.version === undefined || request.version === latest.identity.version
        ? latest
        : entry.olderManifests.get(request.version);
    if (!requested) return Promise.resolve(null);

    return Promise.resolve({
      manifest: { ...requested, visibility: currentVisibility(latest) },
      releases: entry.releases,
    });
  },

  setVisibility(request: PackVisibilityChangeRequest): Promise<PackVisibility> {
    const entry = findEntry(request.packId);
    if (!entry) return Promise.reject(new Error("That pack is not in this workspace."));
    const visibility = resolveVisibility(request.scope);
    visibilityByPackId.set(entry.manifest.identity.id, visibility);
    return Promise.resolve(visibility);
  },
};
