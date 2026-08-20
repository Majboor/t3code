import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicaliseUnitName,
  decideUnitCommand,
  parseHelperRefusal,
  quoteShellArgument,
  unitHelperArgv,
  unitHelperCommandLine,
  unitPathIsContained,
  UNIT_ARG_COUNT_MAX,
  UNIT_ARG_MAX,
  UNIT_DEPLOY_ROOT,
  UNIT_DESCRIPTION_MAX,
  UNIT_DIR,
  UNIT_EXIT_REFUSED,
  UNIT_HELPER_PATH,
  UNIT_MARKER,
  UNIT_NAME_MAX,
  UNIT_PREFIX,
  UNIT_PRIVILEGED_PORT_CEILING,
  UNIT_SERVICE_USER,
  UNIT_SUDOERS_PATH,
  UNIT_SUFFIX,
  UNIT_VERBS,
  type UnitCommandDecision,
  type UnitCreateFields,
  type UnitRefusalReason,
  type UnitRequest,
} from "./decideUnitCommand.ts";

const INFRA = path.resolve(import.meta.dirname, "../../../../infra/install");
const HELPER = path.join(INFRA, "t3-unit-helper.sh");
const INSTALLER = path.join(INFRA, "t3-environment.sh");

const helperSource = readFileSync(HELPER, "utf8");
const installerSource = readFileSync(INSTALLER, "utf8");

/**
 * The installer's own convention, applied to the helper's block.
 *
 * Spelled out again rather than imported from `scripts/lib`: this package does
 * not depend on that one, and a six-line parser is a smaller thing to keep than
 * a dependency edge between the server and the release scripts.
 */
const shellConstants = (script: string): ReadonlyMap<string, string> => {
  const constants = new Map<string, string>();
  const block =
    /# --- drift-checked constants ---\n([\s\S]*?)\n# --- end drift-checked constants ---/.exec(
      script,
    );
  for (const line of (block?.[1] ?? "").split("\n")) {
    const match = /^([A-Z0-9_]+)="([^"]*)"$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) constants.set(match[1], match[2]);
  }
  return constants;
};

/**
 * Comments stripped. Every trap below is discussed in the scripts' own prose,
 * and an assertion that a script never says "eval" is one that a comment
 * explaining why it never uses eval would fail.
 */
const withoutComments = (script: string) =>
  script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const create = (over: Partial<UnitCreateFields> = {}): UnitCreateFields => ({
  exec: `${UNIT_DEPLOY_ROOT}/web/run`,
  args: [],
  workingDirectory: null,
  port: null,
  description: null,
  ...over,
});

const decide = (request: UnitRequest) => decideUnitCommand(request);

const refusedWith = (decision: UnitCommandDecision): UnitRefusalReason => {
  if (decision.outcome !== "refuse") {
    throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`);
  }
  return decision.refusal.reason;
};

const allowed = (decision: UnitCommandDecision) => {
  if (decision.outcome !== "allow") {
    throw new Error(`expected an allow, got ${JSON.stringify(decision)}`);
  }
  return decision.plan;
};

/** Every way a caller could try to name something that is not theirs. */
const NAME_BYPASSES: ReadonlyArray<readonly [label: string, name: string]> = [
  ["a foreign unit outright", "days-tracker-api.service"],
  ["traversal that keeps the prefix", "t3-app-../other"],
  ["traversal with the suffix spelled out", "t3-app-../other.service"],
  ["traversal to an absolute path", "t3-app-/../../etc/systemd/system/nas-buffer.service"],
  ["a bare slash", "t3-app-a/b"],
  ["a command separator", "t3-app-x;systemctl stop chase-s3"],
  ["a pipeline", "t3-app-x|sh"],
  ["command substitution", "t3-app-$(id)"],
  ["backticks", "t3-app-`id`"],
  ["an ampersand", "t3-app-x&"],
  ["a newline", "t3-app-x\nstop days-tracker-api"],
  ["a carriage return", "t3-app-x\rfoo"],
  ["a tab", "t3-app-x\tfoo"],
  ["a space", "t3-app-x y"],
  ["a leading space", " t3-app-x"],
  ["a glob", "t3-app-*"],
  ["a template instance", "t3-app-x@bar"],
  ["a template instance escaping the prefix", "t3-app-@../other"],
  ["a systemd escape sequence", "t3-app-x\\x2fy"],
  ["capitals", "t3-app-Web"],
  ["a fullwidth lookalike", "t3-app-ｗeb"],
  ["a cyrillic lookalike", "t3-app-wеb"],
  ["a right-to-left override", "t3-app-w‮b"],
  ["a zero-width joiner", "t3-app-w‍b"],
  ["a NUL escape written out", "t3-app-x%00"],
  ["a dotted stem", "t3-app-x.y"],
  ["another unit type", "t3-app-x.mount"],
  ["a prefix lookalike", "t3-application-web"],
  ["the prefix and nothing else", "t3-app-"],
  ["a leading dash", "t3-app--x"],
  ["a trailing dash", "t3-app-x-"],
];

describe("decideUnitCommand — names", () => {
  it("allows an ordinary name, with or without the suffix", () => {
    expect(allowed(decide({ verb: "start", name: "t3-app-web" })).name).toBe("t3-app-web.service");
    expect(allowed(decide({ verb: "start", name: "t3-app-web.service" })).name).toBe(
      "t3-app-web.service",
    );
    expect(allowed(decide({ verb: "stop", name: "t3-app-api-2" })).name).toBe(
      "t3-app-api-2.service",
    );
  });

  it("canonicalises without repairing", () => {
    // A name that needed cleaning to become valid is a name the caller did not
    // mean. Trimming or lowercasing here would let two spellings address one
    // unit through two code paths.
    expect(canonicaliseUnitName("t3-app-web")).toBe("t3-app-web.service");
    expect(canonicaliseUnitName("t3-app-web.service")).toBe("t3-app-web.service");
    expect(canonicaliseUnitName(" t3-app-web ")).toBe(" t3-app-web .service");
  });

  it.each(NAME_BYPASSES)("refuses %s", (_label, name) => {
    const reason = refusedWith(decide({ verb: "stop", name }));
    expect(["unit-name-outside-prefix", "unit-name-malformed", "unit-name-empty"]).toContain(
      reason,
    );
  });

  it("refuses the empty name and a name that is only the suffix", () => {
    expect(refusedWith(decide({ verb: "stop", name: "" }))).toBe("unit-name-empty");
    expect(refusedWith(decide({ verb: "stop", name: UNIT_SUFFIX }))).toBe("unit-name-empty");
  });

  it("refuses a name over the length ceiling before looking at anything else", () => {
    const long = `${UNIT_PREFIX}${"a".repeat(UNIT_NAME_MAX)}`;
    expect(refusedWith(decide({ verb: "stop", name: long }))).toBe("unit-name-too-long");
  });

  it("says which range it manages when the name is outside it", () => {
    const decision = decide({ verb: "stop", name: "days-tracker-api" });
    if (decision.outcome !== "refuse") throw new Error("expected a refusal");
    // The wording matters as much as the refusal: an agent that reads this has
    // to stop, not look for the flag that gets around it.
    expect(decision.refusal.remedy).toContain("belongs to somebody else");
    expect(decision.refusal.remedy).not.toContain("--force");
  });
});

describe("decideUnitCommand — verbs", () => {
  it("knows exactly seven", () => {
    expect([...UNIT_VERBS]).toEqual([
      "create",
      "start",
      "stop",
      "restart",
      "enable",
      "disable",
      "status",
    ]);
  });

  it.each([
    "daemon-reload",
    "kill",
    "mask",
    "link",
    "isolate",
    "poweroff",
    "edit",
    "",
    "systemctl",
  ])("refuses %s", (verb) => {
    const request = { verb, name: "t3-app-web" } as unknown as UnitRequest;
    expect(refusedWith(decide(request))).toBe("unknown-verb");
  });

  it("has no verb that removes a unit", () => {
    expect([...UNIT_VERBS]).not.toContain("remove");
    expect([...UNIT_VERBS]).not.toContain("delete");
  });
});

describe("decideUnitCommand — create", () => {
  it("allows a plain unit", () => {
    const plan = allowed(decide({ verb: "create", name: "t3-app-web", create: create() }));
    expect(plan.create?.exec).toBe(`${UNIT_DEPLOY_ROOT}/web/run`);
    expect(plan.needsBindCapability).toBe(false);
  });

  it("refuses a missing program", () => {
    expect(
      refusedWith(decide({ verb: "create", name: "t3-app-web", create: create({ exec: "  " }) })),
    ).toBe("exec-missing");
  });

  it.each([
    ["a relative path", "run"],
    ["a home-relative path", "~/run"],
    ["a bare name", "bash"],
  ])("refuses %s as the program", (_label, exec) => {
    expect(
      refusedWith(decide({ verb: "create", name: "t3-app-web", create: create({ exec }) })),
    ).toBe("path-not-absolute");
  });

  it.each([
    ["traversal out of the deploy root", `${UNIT_DEPLOY_ROOT}/../../../bin/sh`],
    ["traversal in the middle", `${UNIT_DEPLOY_ROOT}/web/../../../bin/sh`],
    ["a bare parent", `${UNIT_DEPLOY_ROOT}/..`],
  ])("refuses %s", (_label, exec) => {
    expect(
      refusedWith(decide({ verb: "create", name: "t3-app-web", create: create({ exec }) })),
    ).toBe("path-traversal");
  });

  it.each([
    ["command substitution", `${UNIT_DEPLOY_ROOT}/we$(id)b`],
    ["a semicolon", `${UNIT_DEPLOY_ROOT}/web;id`],
    ["a space", `${UNIT_DEPLOY_ROOT}/web run`],
    ["a newline", `${UNIT_DEPLOY_ROOT}/web\nUser=root`],
    ["a quote", `${UNIT_DEPLOY_ROOT}/we"b`],
    ["a percent specifier", `${UNIT_DEPLOY_ROOT}/%h/run`],
  ])("refuses %s in a path", (_label, exec) => {
    expect(
      refusedWith(decide({ verb: "create", name: "t3-app-web", create: create({ exec }) })),
    ).toBe("path-malformed");
  });

  it("applies the same rules to the working directory", () => {
    expect(
      refusedWith(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ workingDirectory: "/etc/../etc" }),
        }),
      ),
    ).toBe("path-traversal");
    expect(
      allowed(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ workingDirectory: `${UNIT_DEPLOY_ROOT}/web` }),
        }),
      ).create?.workingDirectory,
    ).toBe(`${UNIT_DEPLOY_ROOT}/web`);
  });

  /**
   * The injection that matters. The helper writes these into a file root is
   * about to read as configuration; a newline in one is a free directive.
   */
  it.each([
    ["a newline", "--flag\nUser=root"],
    ["a directive on its own line", "\n[Service]\nUser=root\nExecStartPre=/bin/sh"],
    ["a carriage return", "--flag\rUser=root"],
    ["a tab", "--flag\tvalue"],
    ["a space", "--flag value"],
    ["a systemd specifier", "%h/.ssh/authorized_keys"],
    ["a double specifier", "%%h"],
    ["a quote", `--flag="value"`],
    ["a backslash", "--flag\\\nUser=root"],
    ["command substitution", "$(id)"],
    ["backticks", "`id`"],
    ["a semicolon", "--flag;id"],
    ["the empty string", ""],
  ])("refuses %s as an argument", (_label, argument) => {
    expect(
      refusedWith(
        decide({ verb: "create", name: "t3-app-web", create: create({ args: [argument] }) }),
      ),
    ).toBe("argument-malformed");
  });

  it("allows the arguments a real program takes", () => {
    const args = ["--port=8080", "--config", "/var/lib/t3-environment/apps/web/app.json", "-v"];
    expect(
      allowed(decide({ verb: "create", name: "t3-app-web", create: create({ args }) })).create
        ?.args,
    ).toEqual(args);
  });

  it("bounds how many arguments and how long each one is", () => {
    expect(
      refusedWith(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ args: Array.from({ length: UNIT_ARG_COUNT_MAX + 1 }, () => "-v") }),
        }),
      ),
    ).toBe("too-many-arguments");
    expect(
      refusedWith(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ args: ["a".repeat(UNIT_ARG_MAX + 1)] }),
        }),
      ),
    ).toBe("argument-too-long");
  });

  it.each([
    ["a newline", "web\nUser=root"],
    ["a trailing newline", "web\n"],
    ["a percent specifier", "%h"],
    ["a quote", 'the "web" app'],
  ])("refuses %s in the description", (_label, description) => {
    expect(
      refusedWith(decide({ verb: "create", name: "t3-app-web", create: create({ description }) })),
    ).toBe("description-malformed");
  });

  it("allows an ordinary description and bounds its length", () => {
    expect(
      allowed(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ description: "the web app (staging), port 8080" }),
        }),
      ).create?.description,
    ).toBe("the web app (staging), port 8080");
    expect(
      refusedWith(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ description: "a".repeat(UNIT_DESCRIPTION_MAX + 1) }),
        }),
      ),
    ).toBe("description-malformed");
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])("refuses %s as a port", (port) => {
    expect(
      refusedWith(decide({ verb: "create", name: "t3-app-web", create: create({ port }) })),
    ).toBe("port-out-of-range");
  });

  /**
   * The whole point of granting a capability: a service on 80 without a root
   * process anywhere in the picture.
   */
  it("asks for CAP_NET_BIND_SERVICE below the privileged ceiling, and not above it", () => {
    expect(
      allowed(decide({ verb: "create", name: "t3-app-web", create: create({ port: 80 }) }))
        .needsBindCapability,
    ).toBe(true);
    expect(
      allowed(
        decide({
          verb: "create",
          name: "t3-app-web",
          create: create({ port: UNIT_PRIVILEGED_PORT_CEILING }),
        }),
      ).needsBindCapability,
    ).toBe(false);
    expect(
      allowed(decide({ verb: "create", name: "t3-app-web", create: create({ port: 8080 }) }))
        .needsBindCapability,
    ).toBe(false);
  });

  it("checks the name before anything about the body", () => {
    expect(
      refusedWith(
        decide({
          verb: "create",
          name: "days-tracker-api",
          create: create({ exec: "/usr/bin/systemctl" }),
        }),
      ),
    ).toBe("unit-name-outside-prefix");
  });
});

describe("unitPathIsContained", () => {
  it("accepts the root and what is under it", () => {
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, UNIT_DEPLOY_ROOT)).toBe(true);
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, `${UNIT_DEPLOY_ROOT}/web/run`)).toBe(true);
  });

  it("refuses a sibling whose name merely starts the same way", () => {
    // The bug this function exists to not have: `startsWith(root)` alone puts
    // somebody else's directory inside the deploy root.
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, `${UNIT_DEPLOY_ROOT}-elsewhere/run`)).toBe(false);
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, `${UNIT_DEPLOY_ROOT}.bak`)).toBe(false);
    expect(unitPathIsContained("/var/lib/t3", "/var/lib/t3x")).toBe(false);
  });

  it("refuses anything above it", () => {
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, "/etc/passwd")).toBe(false);
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, "/var/lib/t3-environment")).toBe(false);
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, "/")).toBe(false);
  });

  it("fails closed on a path nobody resolved", () => {
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, `${UNIT_DEPLOY_ROOT}/../../etc/passwd`)).toBe(
      false,
    );
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, `${UNIT_DEPLOY_ROOT}/./run`)).toBe(false);
    expect(unitPathIsContained(UNIT_DEPLOY_ROOT, "relative/run")).toBe(false);
    expect(unitPathIsContained("relative", `${UNIT_DEPLOY_ROOT}/run`)).toBe(false);
  });

  it("fails closed on a root with a trailing separator", () => {
    // `${root}/` + "/" would make the membership test compare against a
    // doubled separator and quietly stop matching anything.
    expect(unitPathIsContained(`${UNIT_DEPLOY_ROOT}/`, `${UNIT_DEPLOY_ROOT}/run`)).toBe(false);
  });
});

describe("the argument vector", () => {
  it("is a vector, with the helper named absolutely", () => {
    const plan = allowed(
      decide({
        verb: "create",
        name: "t3-app-web",
        create: create({ args: ["--port=8080"], port: 8080, description: "the web app" }),
      }),
    );
    expect(unitHelperArgv(plan)).toEqual([
      "sudo",
      "-n",
      UNIT_HELPER_PATH,
      "create",
      "t3-app-web.service",
      "--exec",
      `${UNIT_DEPLOY_ROOT}/web/run`,
      "--arg",
      "--port=8080",
      "--port",
      "8080",
      "--description",
      "the web app",
    ]);
  });

  it("never names systemctl", () => {
    const plan = allowed(decide({ verb: "stop", name: "t3-app-web" }));
    expect(unitHelperCommandLine(plan)).not.toContain("systemctl");
    expect(unitHelperCommandLine(plan)).toBe(
      `'sudo' '-n' '${UNIT_HELPER_PATH}' 'stop' 't3-app-web.service'`,
    );
  });

  it("quotes, even though nothing that reaches it can need quoting", () => {
    expect(quoteShellArgument("it's")).toBe(`'it'\\''s'`);
    expect(quoteShellArgument("a b; c")).toBe(`'a b; c'`);
  });
});

describe("parseHelperRefusal", () => {
  it("reads the reason back off the helper's stderr", () => {
    expect(
      parseHelperRefusal("t3-unit-helper: refused (unit-not-ours): /etc/... was not written by us"),
    ).toBe("unit-not-ours");
  });

  it("is null for anything else", () => {
    expect(parseHelperRefusal("t3-unit-helper: ERROR: systemctl was not found")).toBe(null);
    expect(parseHelperRefusal("")).toBe(null);
  });
});

/**
 * The copy that actually enforces any of this.
 *
 * Everything above decides in TypeScript, on a machine that is not the box. The
 * agent has a shell on the box, so it can call the helper directly and never
 * come through the module at all — which makes these the tests that matter. The
 * helper validates before it checks for root on purpose, so the argument rules
 * are reachable here without a privileged shell.
 */
describe.skipIf(process.platform === "win32")("the helper itself", () => {
  const runHelper = (...args: ReadonlyArray<string>) => {
    const result = spawnSync("/bin/sh", [HELPER, ...args], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
  };

  it("refuses every name the module refuses, with the same reason kind", () => {
    for (const [label, name] of NAME_BYPASSES) {
      const result = runHelper("stop", name);
      expect(result.status, `${label}: ${JSON.stringify(name)}`).toBe(UNIT_EXIT_REFUSED);
      expect(parseHelperRefusal(result.stderr), label).toMatch(/^unit-name-/);
    }
  });

  it("refuses a verb it does not have", () => {
    for (const verb of ["daemon-reload", "kill", "mask", "isolate", "poweroff"]) {
      const result = runHelper(verb, "t3-app-web");
      expect(result.status, verb).toBe(UNIT_EXIT_REFUSED);
      expect(parseHelperRefusal(result.stderr)).toBe("unknown-verb");
    }
  });

  it("refuses unit-file injection through an argument or a description", () => {
    for (const injection of ["--flag\nUser=root", "%h", "a b", "$(id)"]) {
      const result = runHelper(
        "create",
        "t3-app-web",
        "--exec",
        `${UNIT_DEPLOY_ROOT}/web/run`,
        "--arg",
        injection,
      );
      expect(result.status, injection).toBe(UNIT_EXIT_REFUSED);
      expect(parseHelperRefusal(result.stderr)).toBe("argument-malformed");
    }
    for (const injection of ["ok\nUser=root", "trailing\n", "%h", 'the "web" app']) {
      const result = runHelper(
        "create",
        "t3-app-web",
        "--exec",
        `${UNIT_DEPLOY_ROOT}/web/run`,
        "--description",
        injection,
      );
      expect(result.status, injection).toBe(UNIT_EXIT_REFUSED);
      expect(parseHelperRefusal(result.stderr)).toBe("description-malformed");
    }
  });

  it("refuses a path that is not absolute, traverses, or holds metacharacters", () => {
    expect(parseHelperRefusal(runHelper("create", "t3-app-web", "--exec", "run").stderr)).toBe(
      "path-not-absolute",
    );
    expect(
      parseHelperRefusal(
        runHelper("create", "t3-app-web", "--exec", `${UNIT_DEPLOY_ROOT}/../../bin/sh`).stderr,
      ),
    ).toBe("path-traversal");
    expect(
      parseHelperRefusal(
        runHelper("create", "t3-app-web", "--exec", `${UNIT_DEPLOY_ROOT}/we$(id)b`).stderr,
      ),
    ).toBe("path-malformed");
  });

  it("refuses an option it does not know, and extra words after a lifecycle verb", () => {
    expect(
      parseHelperRefusal(
        runHelper("create", "t3-app-web", "--exec", `${UNIT_DEPLOY_ROOT}/web/run`, "--user", "root")
          .stderr,
      ),
    ).toBe("unknown-option");
    expect(parseHelperRefusal(runHelper("stop", "t3-app-web", "days-tracker-api").stderr)).toBe(
      "unknown-option",
    );
  });

  it("refuses a port that is not one", () => {
    for (const port of ["0", "65536", "80x", "99999999999999999999", "-1"]) {
      const result = runHelper(
        "create",
        "t3-app-web",
        "--exec",
        `${UNIT_DEPLOY_ROOT}/web/run`,
        "--port",
        port,
      );
      expect(parseHelperRefusal(result.stderr), port).toBe("port-out-of-range");
    }
  });

  it("stops at the root check once a request is well formed", () => {
    // Not a refusal: the request was fine and this machine is not a box. What
    // matters is that it got that far without touching anything.
    const result = runHelper("stop", "t3-app-web");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must run as root");
  });
});

/**
 * The two copies of the same rules, checked against each other.
 *
 * The helper cannot import the module — it is POSIX sh running on a box that
 * may have no runtime at all — so it carries its own constants, and this is the
 * only thing standing between "they agree" and "they agreed once".
 */
describe("the helper and the module agree", () => {
  const helper = shellConstants(helperSource);
  const installer = shellConstants(installerSource);

  it("declares a parseable constants block", () => {
    expect(helper.size).toBeGreaterThan(0);
  });

  it("agrees on what a unit is called and where it lives", () => {
    expect(helper.get("T3_UNIT_PREFIX")).toBe(UNIT_PREFIX);
    expect(helper.get("T3_UNIT_SUFFIX")).toBe(UNIT_SUFFIX);
    expect(helper.get("T3_UNIT_MARKER")).toBe(UNIT_MARKER);
    expect(helper.get("T3_UNIT_DIR")).toBe(UNIT_DIR);
    expect(helper.get("T3_SERVICE_USER")).toBe(UNIT_SERVICE_USER);
    expect(helper.get("T3_DEPLOY_ROOT")).toBe(UNIT_DEPLOY_ROOT);
    expect(helper.get("T3_HELPER_PATH")).toBe(UNIT_HELPER_PATH);
    expect(helper.get("T3_SUDOERS_PATH")).toBe(UNIT_SUDOERS_PATH);
  });

  it("agrees on the vocabulary and the bounds", () => {
    expect(helper.get("T3_VERBS")).toBe(UNIT_VERBS.join(" "));
    expect(helper.get("T3_NAME_MAX")).toBe(String(UNIT_NAME_MAX));
    expect(helper.get("T3_ARG_MAX")).toBe(String(UNIT_ARG_MAX));
    expect(helper.get("T3_ARG_COUNT_MAX")).toBe(String(UNIT_ARG_COUNT_MAX));
    expect(helper.get("T3_DESCRIPTION_MAX")).toBe(String(UNIT_DESCRIPTION_MAX));
    expect(helper.get("T3_PRIVILEGED_PORT_CEILING")).toBe(String(UNIT_PRIVILEGED_PORT_CEILING));
    expect(helper.get("T3_EXIT_REFUSED")).toBe(String(UNIT_EXIT_REFUSED));
  });

  it("agrees with the installer about where the helper and its rule go", () => {
    expect(installer.get("T3_UNIT_HELPER_PATH")).toBe(UNIT_HELPER_PATH);
    expect(installer.get("T3_SUDOERS_PATH")).toBe(UNIT_SUDOERS_PATH);
    expect(installer.get("T3_DEPLOY_ROOT")).toBe(UNIT_DEPLOY_ROOT);
    expect(installer.get("T3_SERVICE_USER")).toBe(UNIT_SERVICE_USER);
  });
});

/**
 * Properties of the shell that no test of the TypeScript could catch.
 *
 * These are assertions about the text of two scripts, which is a blunt
 * instrument — and the right one here, because each of them is a trap that
 * hands over root if it is ever quietly reintroduced.
 */
describe("the shell cannot be talked into more than it grants", () => {
  const helperCode = withoutComments(helperSource);
  const installerCode = withoutComments(installerSource);

  it("never builds a command string", () => {
    // `eval` or an `sh -c` in a root helper turns every allowlist above into a
    // suggestion. Everything it runs is invoked with an argument vector.
    expect(helperCode).not.toMatch(/\beval\b/);
    expect(helperCode).not.toMatch(/\bsh -c\b/);
    expect(helperCode).not.toMatch(/\bbash -c\b/);
    expect(helperCode).not.toMatch(/\bxargs\b/);
  });

  it("pins the generated unit to the unprivileged service user", () => {
    expect(helperCode).toContain("User=$T3_SERVICE_USER");
    expect(helperCode).toContain("Group=$T3_SERVICE_USER");
    expect(helperCode).toContain("NoNewPrivileges=yes");
    // The template is the only place a unit file comes from. If a caller could
    // supply one of these, the unit is arbitrary code as root.
    expect(helperCode).not.toMatch(/--exec-start|--unit-file|--user\b/);
    expect(helperCode).not.toMatch(/^\s*User=(?!\$T3_SERVICE_USER)/m);
  });

  it("grants a capability for a low port rather than a uid", () => {
    expect(helperCode).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(helperCode).not.toMatch(/User=root/);
  });

  it("looks systemctl up at absolute paths only", () => {
    expect(helperCode).toContain("/usr/bin/systemctl");
    expect(helperCode).not.toMatch(/\$\(command -v systemctl\)/);
  });

  it("runs no package manager", () => {
    for (const manager of ["apt-get", "apt ", "yum", "dnf", "apk", "pacman", "zypper"]) {
      expect(helperCode, manager).not.toContain(manager);
    }
  });

  it("hands sudo one absolute path and no wildcard", () => {
    const rule = /^(\S+) ALL=\(root\) NOPASSWD: (\S+)$/m.exec(installerCode);
    expect(rule, "the sudoers rule was not found in the installer").not.toBe(null);
    expect(rule?.[1]).toBe(`$T3_SERVICE_USER`);
    expect(rule?.[2]).toBe(`$T3_UNIT_HELPER_PATH`);
    // The rule that would hand over the machine. Naming systemctl — or any
    // wildcard — lets the agent stop anything on the box.
    expect(rule?.[2]).not.toContain("*");
    expect(installerCode).not.toMatch(/NOPASSWD:.*systemctl/);
    expect(installerCode).not.toMatch(/NOPASSWD:.*ALL\s*$/m);
  });

  it("validates the sudoers file before installing it and removes it on uninstall", () => {
    expect(installerCode).toContain("visudo -c");
    expect(installerCode).toContain("0440");
    expect(installerCode).toMatch(/rm -f "\$T3_SUDOERS_PATH"/);
  });
});
