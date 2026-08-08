import type { Pack } from "./packMode.logic";
import { packMeetsRequirements } from "./packMode.logic";
import type { PackDirectory, PackSearchRequest } from "./packDirectory";

/**
 * STUB DATA SOURCE. There is no pack RPC yet, so this stands in for it: the
 * shape of what comes back is the contract the real directory has to meet.
 * Nothing else in the app imports this file — `packDirectory.ts` picks the
 * implementation, so swapping in the served directory is that one binding.
 */

interface StubEntry {
  readonly pack: Pack;
  /** Relevance is the directory's job; the stub fakes it with keywords. */
  readonly keywords: readonly string[];
}

const STUB_ENTRIES: readonly StubEntry[] = [
  {
    keywords: ["stripe", "billing", "subscription", "checkout", "payment", "webhook", "invoice"],
    pack: {
      id: "stripe-subscription-billing",
      name: "Stripe subscription billing",
      version: "2.4.1",
      scope: "ecosystem",
      summary:
        "Checkout, the webhook handler, and the subscription state your app has to keep in sync with Stripe's.",
      handles: [
        "duplicate webhook deliveries that charge a customer twice",
        "events arriving out of order, so a cancellation cannot be overwritten by a stale renewal",
        "the signature check failing silently behind a proxy that rewrites the raw body",
      ],
      requires: ["a Stripe secret key", "a webhook signing secret", "a public checkout return URL"],
      signals: {
        deployments: 341,
        monthsInService: 14,
        independentOperators: 87,
        cleanInstallRate: 0.96,
        breakagesCaught: 9,
      },
    },
  },
  {
    keywords: ["auth", "login", "signin", "session", "oauth", "password", "signup", "magic link"],
    pack: {
      id: "session-auth",
      name: "Email and OAuth sign-in",
      version: "5.0.3",
      scope: "ecosystem",
      summary:
        "Sign-up, sign-in, sessions, and account linking, with the redirect and cookie rules that differ between local, preview, and production.",
      handles: [
        "the same person signing up twice through two providers with one email",
        "session cookies dropped on preview domains because SameSite was wrong",
        "password reset links that stay valid after the password already changed",
      ],
      requires: ["an OAuth client ID and secret per provider", "a transactional email sender"],
      signals: {
        deployments: 512,
        monthsInService: 21,
        independentOperators: 140,
        cleanInstallRate: 0.93,
        breakagesCaught: 17,
      },
    },
  },
  {
    keywords: ["upload", "file", "image", "s3", "storage", "attachment", "avatar"],
    pack: {
      id: "direct-uploads",
      name: "Direct file uploads",
      version: "1.8.0",
      scope: "ecosystem",
      summary:
        "Browser-to-storage uploads with presigned URLs, so large files never pass through your server.",
      handles: [
        "uploads that succeed in storage but never get recorded in your database",
        "content types the browser reports wrongly, which breaks inline previews later",
        "abandoned uploads accumulating cost until something sweeps them",
      ],
      requires: ["a storage bucket", "credentials scoped to that bucket only"],
      signals: {
        deployments: 96,
        monthsInService: 7,
        independentOperators: 24,
        cleanInstallRate: 0.98,
        breakagesCaught: 3,
      },
    },
  },
  {
    keywords: ["admin", "dashboard", "internal", "back office", "crud", "moderation"],
    pack: {
      id: "internal-admin-console",
      name: "Internal admin console",
      version: "0.9.2",
      scope: "workspace",
      summary:
        "A read-and-repair console over your own tables, with an audit trail of who changed what.",
      handles: [
        "an internal tool quietly becoming a production write path with no record of it",
        "staff accounts outliving the person who needed them",
      ],
      requires: ["a database connection", "the list of roles allowed in"],
      signals: {
        deployments: 12,
        monthsInService: 4,
        independentOperators: 0,
        cleanInstallRate: 1,
        breakagesCaught: 1,
      },
    },
  },
  {
    keywords: ["email", "notification", "transactional", "digest", "reminder"],
    pack: {
      id: "transactional-email",
      name: "Transactional email",
      version: "3.1.4",
      scope: "ecosystem",
      summary:
        "Templated sends, retries, and the delivery bookkeeping that tells you whether a message actually arrived.",
      handles: [
        "retries after a provider timeout sending the same email twice",
        "a domain landing in spam because the sending records were never verified",
        "bounces that never come back to the account that caused them",
      ],
      requires: ["an email provider API key", "a verified sending domain"],
      signals: {
        deployments: 208,
        monthsInService: 16,
        independentOperators: 61,
        cleanInstallRate: 0.97,
        breakagesCaught: 11,
      },
    },
  },
];

function matchesQuery(entry: StubEntry, query: string): boolean {
  const normalized = query.toLowerCase();
  return entry.keywords.some((keyword) => normalized.includes(keyword));
}

export const stubPackDirectory: PackDirectory = {
  searchPacks(request: PackSearchRequest): Promise<readonly Pack[]> {
    const query = request.query.trim();
    if (query.length === 0) return Promise.resolve([]);
    const matches = STUB_ENTRIES.filter(
      (entry) =>
        matchesQuery(entry, query) &&
        (request.scope === "ecosystem" || entry.pack.scope === "workspace") &&
        packMeetsRequirements(entry.pack, request.requirements),
    ).map((entry) => entry.pack);
    return Promise.resolve(matches);
  },
};
