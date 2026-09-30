import { describe, expect, it } from "vitest";

import { isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

/**
 * Whether this install may seed a provider home from the operator's own login.
 *
 * Mirrors the condition in ws.ts `seedProviderHomeFromOperator`. Kept as a test
 * of the boundary rather than of the copy itself, because the copy is the easy
 * part and *who it is allowed for* is the part that went wrong.
 */
const mayLendOperatorCredentials = (host: string | undefined): boolean =>
  isLoopbackHost(host) && !isWildcardHost(host);

describe("lending the operator's provider login", () => {
  // The operator's own computer: the only person it can seed from is the person
  // sitting at it, and a freshly isolated provider home is otherwise unusable.
  it("is allowed on a single-machine install", () => {
    expect(mayLendOperatorCredentials("127.0.0.1")).toBe(true);
    expect(mayLendOperatorCredentials("localhost")).toBe(true);
  });

  // The defect: seeding copies one subscription into every account's provider
  // home. On a live instance that left 390 byte-identical copies of a single
  // OpenAI credential, each shown to its holder as their own account with the
  // operator's email on it. LogicPacks gives every account GLM free through the
  // gateway; Codex and Claude are logins people bring themselves.
  it("is refused on a published host", () => {
    expect(mayLendOperatorCredentials("0.0.0.0")).toBe(false);
    expect(mayLendOperatorCredentials("192.168.18.210")).toBe(false);
  });

  // A wildcard bind is reachable from off the machine even though the literal
  // string looks local-ish, so it must not count as single-machine.
  it("does not treat a wildcard bind as single-machine", () => {
    expect(mayLendOperatorCredentials("::")).toBe(false);
  });
});
