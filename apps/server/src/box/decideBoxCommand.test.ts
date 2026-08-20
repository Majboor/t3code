import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";
import { describe, expect, it } from "vitest";

import {
  BOX_OUTPUT_HEAD_BYTES,
  BOX_OUTPUT_TAIL_BYTES,
  boundCommandOutput,
  boxStopAcknowledgement,
  decideBoxCommand,
  findBoxServices,
  type BoxFacts,
  type BoxRefusalReason,
  type BoxRequest,
} from "./decideBoxCommand.ts";

const USER = "supabase:abc";
const OTHER = "supabase:xyz";

const box = (over: Partial<BoxFacts> = {}): BoxFacts => ({
  machineId: "machine-1",
  revoked: false,
  reachable: true,
  ...over,
});

const service = (over: Partial<EnvironmentService> = {}): EnvironmentService => ({
  port: 3000,
  name: "web",
  state: "listening",
  ownership: "ours",
  ownershipReason: "pid 4821 is the process T3 started for this port.",
  pid: 4821,
  command: "npm run dev",
  address: "127.0.0.1",
  since: "2026-08-20T10:00:00.000Z",
  startedBy: USER,
  managedId: "svc-1",
  canManage: true,
  ...over,
});

/** A stranger's process: seen, named, and emphatically not ours. */
const strangers = (over: Partial<EnvironmentService> = {}): EnvironmentService =>
  service({
    port: 5432,
    name: "postgres",
    ownership: "not-ours",
    ownershipReason: "pid 991 (postgres) holds this port and is not a process T3 started.",
    pid: 991,
    command: null,
    since: null,
    startedBy: null,
    managedId: null,
    canManage: false,
    ...over,
  });

const claim = (over: Partial<PortClaim> = {}): PortClaim => ({
  port: 4000,
  claimedBy: USER,
  purpose: "the api while it builds",
  claimedAt: "2026-08-20T10:00:00.000Z",
  expiresAt: "2026-08-20T10:10:00.000Z",
  ...over,
});

const decide = (
  request: BoxRequest,
  over: {
    readonly box?: BoxFacts;
    readonly services?: ReadonlyArray<EnvironmentService>;
    readonly claims?: ReadonlyArray<PortClaim>;
    readonly actorUserId?: string;
  } = {},
) =>
  decideBoxCommand({
    box: over.box ?? box(),
    request,
    services: over.services ?? [],
    claims: over.claims ?? [],
    actorUserId: over.actorUserId ?? USER,
  });

const refusedWith = (decision: ReturnType<typeof decide>): BoxRefusalReason => {
  if (decision.outcome !== "refuse") {
    throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`);
  }
  return decision.refusal.reason;
};

const RUN: BoxRequest = { verb: "run", command: "npm ci", detach: false };

describe("decideBoxCommand — the box itself", () => {
  it("refuses every verb on a machine the account disconnected", () => {
    const requests: ReadonlyArray<BoxRequest> = [
      RUN,
      { verb: "services" },
      { verb: "history" },
      { verb: "logs", target: "web" },
      { verb: "stop", target: "web", acknowledgedTarget: null },
      { verb: "claim-port", port: 4000, purpose: "the api" },
      { verb: "release-port", port: 4000 },
    ];
    for (const request of requests) {
      expect(refusedWith(decide(request, { box: box({ revoked: true }) }))).toBe("machine-revoked");
    }
  });

  it("puts revocation ahead of reachability, so a disconnected machine never reads as merely offline", () => {
    const decision = decide(RUN, { box: box({ revoked: true, reachable: false }) });
    expect(refusedWith(decision)).toBe("machine-revoked");
  });

  it("refuses work on an unreachable box rather than letting it hang", () => {
    expect(refusedWith(decide(RUN, { box: box({ reachable: false }) }))).toBe("box-unreachable");
    expect(refusedWith(decide({ verb: "services" }, { box: box({ reachable: false }) }))).toBe(
      "box-unreachable",
    );
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "web", acknowledgedTarget: null },
          { box: box({ reachable: false }) },
        ),
      ),
    ).toBe("box-unreachable");
  });

  it("still answers history when the box is unreachable, which is when it is asked", () => {
    const decision = decide({ verb: "history" }, { box: box({ reachable: false }) });
    expect(decision).toEqual({ outcome: "allow", plan: { verb: "history" } });
  });
});

describe("decideBoxCommand — run", () => {
  it("allows a command and trims it", () => {
    const decision = decide({ verb: "run", command: "  npm ci  ", detach: false });
    expect(decision).toEqual({
      outcome: "allow",
      plan: { verb: "run", command: "npm ci", detach: false },
    });
  });

  it("carries the detach intent through untouched", () => {
    const decision = decide({ verb: "run", command: "npm start", detach: true });
    expect(decision).toEqual({
      outcome: "allow",
      plan: { verb: "run", command: "npm start", detach: true },
    });
  });

  it("refuses an empty or blank command", () => {
    expect(refusedWith(decide({ verb: "run", command: "", detach: false }))).toBe("empty-command");
    expect(refusedWith(decide({ verb: "run", command: "   \n\t ", detach: false }))).toBe(
      "empty-command",
    );
  });
});

describe("decideBoxCommand — stop refuses what we did not start", () => {
  it("stops something T3 started", () => {
    const web = service();
    const decision = decide(
      { verb: "stop", target: "web", acknowledgedTarget: null },
      {
        services: [web],
      },
    );
    expect(decision).toEqual({
      outcome: "allow",
      plan: { verb: "stop", service: web, pid: 4821, unmanaged: false },
    });
  });

  it("refuses a process T3 did not start, with no override", () => {
    const decision = decide(
      { verb: "stop", target: "postgres", acknowledgedTarget: null },
      {
        services: [strangers()],
      },
    );
    expect(refusedWith(decision)).toBe("service-not-ours");
  });

  it("refuses an `unknown` process just as hard as a known stranger", () => {
    const opaque = strangers({
      ownership: "unknown",
      ownershipReason: "This machine would not say which process holds this port.",
      pid: 7000,
    });
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "postgres", acknowledgedTarget: null },
          {
            services: [opaque],
          },
        ),
      ),
    ).toBe("service-not-ours");
  });

  it("never names the override flag in the refusal it would satisfy", () => {
    const decision = decide(
      { verb: "stop", target: "postgres", acknowledgedTarget: null },
      {
        services: [strangers()],
      },
    );
    if (decision.outcome !== "refuse") throw new Error("expected a refusal");
    const words = `${decision.refusal.headline} ${decision.refusal.remedy}`;
    expect(words).not.toContain("--");
    expect(words.toLowerCase()).not.toContain("override");
    expect(words.toLowerCase()).toContain("ask the person");
  });

  it("accepts an override that names the exact pid", () => {
    const postgres = strangers();
    const decision = decide(
      { verb: "stop", target: "postgres", acknowledgedTarget: "pid:991" },
      {
        services: [postgres],
      },
    );
    expect(decision).toEqual({
      outcome: "allow",
      plan: { verb: "stop", service: postgres, pid: 991, unmanaged: true },
    });
  });

  it("tolerates surrounding whitespace in the override but nothing else", () => {
    const postgres = strangers();
    expect(
      decide(
        { verb: "stop", target: "postgres", acknowledgedTarget: "  pid:991 " },
        {
          services: [postgres],
        },
      ).outcome,
    ).toBe("allow");
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "postgres", acknowledgedTarget: "991" },
          {
            services: [postgres],
          },
        ),
      ),
    ).toBe("override-mismatch");
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "postgres", acknowledgedTarget: "PID:991" },
          {
            services: [postgres],
          },
        ),
      ),
    ).toBe("override-mismatch");
  });

  it("refuses an override copied from before the process restarted", () => {
    const restarted = strangers({ pid: 1201 });
    const decision = decide(
      { verb: "stop", target: "postgres", acknowledgedTarget: "pid:991" },
      {
        services: [restarted],
      },
    );
    expect(refusedWith(decision)).toBe("override-mismatch");
  });

  it("refuses to stop anything when the machine will not name the process", () => {
    const anonymous = strangers({ pid: null, ownership: "unknown" });
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "postgres", acknowledgedTarget: null },
          {
            services: [anonymous],
          },
        ),
      ),
    ).toBe("service-unidentifiable");
    // An override cannot supply a fact the machine declined to give.
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "postgres", acknowledgedTarget: "pid:991" },
          {
            services: [anonymous],
          },
        ),
      ),
    ).toBe("service-unidentifiable");
  });

  it("refuses when the registry says ours but withholds canManage", () => {
    const inconsistent = service({ canManage: false });
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "web", acknowledgedTarget: null },
          {
            services: [inconsistent],
          },
        ),
      ),
    ).toBe("service-not-ours");
  });

  it("ignores an override on something already ours", () => {
    const web = service();
    const decision = decide(
      { verb: "stop", target: "web", acknowledgedTarget: "pid:999" },
      {
        services: [web],
      },
    );
    expect(decision).toEqual({
      outcome: "allow",
      plan: { verb: "stop", service: web, pid: 4821, unmanaged: false },
    });
  });

  it("stops a displaced record, which is ours even though it no longer serves", () => {
    const displaced = service({ state: "displaced", address: null });
    const decision = decide(
      { verb: "stop", target: "web", acknowledgedTarget: null },
      {
        services: [displaced],
      },
    );
    expect(decision.outcome).toBe("allow");
  });
});

describe("decideBoxCommand — resolving a target", () => {
  it("refuses a name nothing answers to", () => {
    expect(
      refusedWith(
        decide(
          { verb: "stop", target: "nope", acknowledgedTarget: null },
          {
            services: [service()],
          },
        ),
      ),
    ).toBe("unknown-service");
  });

  it("refuses a name two services share rather than picking one", () => {
    const decision = decide(
      { verb: "stop", target: "api", acknowledgedTarget: null },
      {
        services: [service({ name: "api", port: 3001 }), service({ name: "api", port: 3002 })],
      },
    );
    expect(refusedWith(decision)).toBe("ambiguous-service");
    if (decision.outcome !== "refuse") throw new Error("expected a refusal");
    expect(decision.refusal.remedy).toContain(":3001");
    expect(decision.refusal.remedy).toContain(":3002");
  });

  it("matches a port with or without a leading colon, and case-insensitively by name", () => {
    const web = service();
    expect(findBoxServices([web], "3000")).toEqual([web]);
    expect(findBoxServices([web], ":3000")).toEqual([web]);
    expect(findBoxServices([web], "WEB")).toEqual([web]);
    expect(findBoxServices([web], " web ")).toEqual([web]);
    expect(findBoxServices([web], "")).toEqual([]);
    expect(findBoxServices([web], "3001")).toEqual([]);
  });

  it("never treats an out-of-range number as a name", () => {
    const named = service({ name: "70000", port: 3000 });
    expect(findBoxServices([named], "70000")).toEqual([named]);
    expect(findBoxServices([named], "0")).toEqual([]);
  });

  it("skips unnamed services when matching by name", () => {
    expect(findBoxServices([service({ name: null })], "web")).toEqual([]);
  });

  it("returns every service sharing a contested port", () => {
    const ours = service({ state: "displaced" });
    const theirs = strangers({ port: 3000 });
    expect(findBoxServices([ours, theirs], ":3000")).toEqual([ours, theirs]);
  });
});

describe("decideBoxCommand — logs", () => {
  it("allows logs for something T3 started", () => {
    const web = service();
    expect(decide({ verb: "logs", target: "web" }, { services: [web] })).toEqual({
      outcome: "allow",
      plan: { verb: "logs", service: web, managedId: "svc-1" },
    });
  });

  it("explains that a stranger's logs were never captured, without calling it a permission", () => {
    const decision = decide({ verb: "logs", target: "postgres" }, { services: [strangers()] });
    expect(refusedWith(decision)).toBe("no-captured-logs");
    if (decision.outcome !== "refuse") throw new Error("expected a refusal");
    expect(decision.refusal.remedy.toLowerCase()).not.toContain("not allowed");
  });

  it("refuses an unknown or ambiguous logs target the same way stop does", () => {
    expect(refusedWith(decide({ verb: "logs", target: "nope" }, { services: [service()] }))).toBe(
      "unknown-service",
    );
    expect(
      refusedWith(
        decide(
          { verb: "logs", target: "api" },
          {
            services: [service({ name: "api", port: 3001 }), service({ name: "api", port: 3002 })],
          },
        ),
      ),
    ).toBe("ambiguous-service");
  });
});

describe("decideBoxCommand — ports", () => {
  it("allows a claim in range and trims the purpose", () => {
    expect(decide({ verb: "claim-port", port: 4000, purpose: "  the api  " })).toEqual({
      outcome: "allow",
      plan: { verb: "claim-port", port: 4000, purpose: "the api" },
    });
  });

  it("refuses a port that is not a port", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(refusedWith(decide({ verb: "claim-port", port, purpose: "x" }))).toBe(
        "port-out-of-range",
      );
    }
  });

  it("allows both ends of the range", () => {
    expect(decide({ verb: "claim-port", port: 1, purpose: "x" }).outcome).toBe("allow");
    expect(decide({ verb: "claim-port", port: 65_535, purpose: "x" }).outcome).toBe("allow");
  });

  it("releases a reservation the asker holds", () => {
    const held = claim();
    expect(decide({ verb: "release-port", port: 4000 }, { claims: [held] })).toEqual({
      outcome: "allow",
      plan: { verb: "release-port", port: 4000, claim: held },
    });
  });

  it("refuses to release somebody else's reservation", () => {
    const decision = decide(
      { verb: "release-port", port: 4000 },
      {
        claims: [claim({ claimedBy: OTHER })],
      },
    );
    expect(refusedWith(decision)).toBe("claim-not-yours");
  });

  it("refuses to release a port nobody reserved", () => {
    expect(refusedWith(decide({ verb: "release-port", port: 4000 }))).toBe("claim-not-found");
    expect(refusedWith(decide({ verb: "release-port", port: 4001 }, { claims: [claim()] }))).toBe(
      "claim-not-found",
    );
  });
});

describe("boxStopAcknowledgement", () => {
  it("names the pid, so a value cannot be produced without having looked", () => {
    expect(boxStopAcknowledgement(strangers())).toBe("pid:991");
  });

  it("has no answer for a process the machine would not name", () => {
    expect(boxStopAcknowledgement(strangers({ pid: null }))).toBeNull();
  });
});

describe("boundCommandOutput", () => {
  it("leaves short output exactly as it was", () => {
    const out = boundCommandOutput("done\n");
    expect(out).toEqual({ text: "done\n", truncated: false, totalBytes: 5, omittedBytes: 0 });
  });

  it("leaves output that exactly fills the budget alone", () => {
    const text = "a".repeat(BOX_OUTPUT_HEAD_BYTES + BOX_OUTPUT_TAIL_BYTES);
    const out = boundCommandOutput(text);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(text);
  });

  it("keeps both ends of a long stream and says how much it dropped", () => {
    const head = "START".padEnd(BOX_OUTPUT_HEAD_BYTES, "h");
    const middle = "m".repeat(50_000);
    const tail = "t".repeat(BOX_OUTPUT_TAIL_BYTES - 5) + "ERROR";
    const out = boundCommandOutput(head + middle + tail);

    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("START")).toBe(true);
    expect(out.text.endsWith("ERROR")).toBe(true);
    expect(out.omittedBytes).toBe(50_000);
    expect(out.totalBytes).toBe(head.length + middle.length + tail.length);
    expect(out.text).toContain("[… 50000 bytes omitted …]");
  });

  it("never lets a head and tail read as adjacent", () => {
    const out = boundCommandOutput("a".repeat(10_000), { headBytes: 10, tailBytes: 10 });
    expect(out.text).toBe(`${"a".repeat(10)}\n[… 9980 bytes omitted …]\n${"a".repeat(10)}`);
  });

  it("bounds a thousand-line install to a few kilobytes", () => {
    const noisy = Array.from({ length: 12_000 }, (_, index) => `line ${index}`).join("\n");
    const out = boundCommandOutput(noisy);
    expect(out.totalBytes).toBeGreaterThan(100_000);
    expect(out.text.length).toBeLessThan(BOX_OUTPUT_HEAD_BYTES + BOX_OUTPUT_TAIL_BYTES + 100);
    expect(out.text).toContain("line 0");
    expect(out.text).toContain("line 11999");
  });

  it("counts bytes and not characters", () => {
    // Four code points, ten UTF-8 bytes: one ASCII, one two-byte, one
    // three-byte, one four-byte astral character.
    const mixed = "aé€\u{1f600}";
    expect(boundCommandOutput(mixed).totalBytes).toBe(10);
  });

  it("never splits a multi-byte character at either boundary", () => {
    const text = `${"\u{1f600}".repeat(50)}MID${"\u{1f600}".repeat(50)}`;
    const out = boundCommandOutput(text, { headBytes: 10, tailBytes: 10 });
    // 10 bytes holds two four-byte emoji with two bytes to spare, and the third
    // must not be halved.
    expect(out.text.startsWith("\u{1f600}\u{1f600}\n")).toBe(true);
    expect(out.text.endsWith("\n\u{1f600}\u{1f600}")).toBe(true);
    expect(out.text).not.toContain("�");
  });

  it("drops everything when the budget is zero, and still reports the size", () => {
    const out = boundCommandOutput("hello", { headBytes: 0, tailBytes: 0 });
    expect(out).toEqual({
      text: "\n[… 5 bytes omitted …]\n",
      truncated: true,
      totalBytes: 5,
      omittedBytes: 5,
    });
  });

  it("treats a negative budget as zero rather than slicing backwards", () => {
    const out = boundCommandOutput("hello", { headBytes: -10, tailBytes: -10 });
    expect(out.omittedBytes).toBe(5);
  });

  it("handles empty output", () => {
    expect(boundCommandOutput("")).toEqual({
      text: "",
      truncated: false,
      totalBytes: 0,
      omittedBytes: 0,
    });
  });

  it("counts an unpaired surrogate as three bytes rather than looping", () => {
    expect(boundCommandOutput("\ud800").totalBytes).toBe(3);
    expect(boundCommandOutput("\udc00x").totalBytes).toBe(4);
  });
});
