#!/usr/bin/env node
// Does the agent go and get a pack on its own?
//
//   bun run dev                    # in another terminal
//   bun run test:pack-discovery
//
// The tui-deploy suite hands the agent the pack's integration prompt and then
// checks the knowledge steers it. That proves the knowledge is good; it proves
// nothing about whether the agent would ever have found it. A user watched an
// agent build and deploy a page without ever mentioning a pack, which is what
// that gap looks like from outside.
//
// So this suite tells the agent nothing. It asks for a deploy, in a project
// holding a terminal program, and checks the agent looks a pack up by itself,
// says which one it is using, and arrives at the terminal-program problem it
// was never told about.
//
// Needs a configured provider.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import {
  bodyText,
  createHarness,
  createReporter,
  openIsolatedSession,
  sleep,
  unlistProject,
} from "./lib/e2e-harness.mjs";

const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const APP_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-disc-${RUN_ID}`);
const ACCOUNT = `disc.${RUN_ID}@example.test`;
const PASSWORD = "Disc-passw0rd!";
const KEEP = process.env["T3_E2E_KEEP"] === "1";
const AGENT_TURN_MS = 300_000;

// The server writes the shim under its own home, and the home it is running
// with is not this process's. Guessing one path is how this suite first
// reported "no shim" while the shim existed a directory away.
const SHIM_CANDIDATES = [
  process.env["T3CODE_HOME"],
  path.join(os.homedir(), ".t3code"),
  path.join(os.homedir(), ".t3"),
  path.join(os.homedir(), ".t3-staging"),
]
  .filter((home) => home !== undefined && home.length > 0)
  .map((home) => path.join(home, "bin", "t3"));

const findShim = () => SHIM_CANDIDATES.find((candidate) => existsSync(candidate));

const { phase, check, skip, finish } = createReporter();
const { signUp, addProject, openProject, sendAgentMessage } = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  probeFile: "todo.py",
});

async function waitForAny(page, matches, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await bodyText(page);
    if (matches.test(seen)) return { found: true, seen };
    await sleep(6_000);
  }
  return { found: false, seen };
}

const reachable = await fetch(BASE_URL, { redirect: "manual" }).then(
  () => true,
  () => false,
);
if (!reachable) {
  console.error(`Nothing is answering at ${BASE_URL}. Start one with \`bun run dev\`.`);
  process.exit(1);
}

const browser = await chromium.launch();
const account = await openIsolatedSession(browser, "A");

try {
  phase("A terminal program, and no mention of packs anywhere");
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(
    path.join(APP_DIR, "todo.py"),
    [
      '"""A task list that runs in the terminal."""',
      "",
      "import sys",
      "",
      "TASKS = []",
      "",
      "",
      "def main():",
      "    while True:",
      '        sys.stdout.write("> ")',
      "        sys.stdout.flush()",
      "        line = sys.stdin.readline()",
      "        if not line:",
      "            return",
      '        if line.strip() == "quit":',
      "            return",
      "        TASKS.append(line.strip())",
      "",
      "",
      'if __name__ == "__main__":',
      "    main()",
      "",
    ].join("\n"),
  );
  check("the program exists", existsSync(path.join(APP_DIR, "todo.py")), APP_DIR);
  check(
    "and it opens no socket",
    !/\b(import (flask|http\.server|socket)|from flask|app\.run|listen\()/i.test(
      readFileSync(path.join(APP_DIR, "todo.py"), "utf8"),
    ),
  );

  // Removed so its reappearance means this run's agent session wrote it,
  // rather than some earlier run having left it lying around.
  for (const candidate of SHIM_CANDIDATES) rmSync(candidate, { force: true });
  check(
    "no t3 shim on disk before the agent starts",
    findShim() === undefined,
    SHIM_CANDIDATES.join(", "),
  );

  phase("Ask for a deploy, and say nothing else");
  check("the account signs up", await signUp(account, ACCOUNT), ACCOUNT);
  await addProject(account.page, APP_DIR);
  check("A opens the project", await openProject(account.page));

  const prompt = "Deploy todo.py from this workspace to a server.";
  check(
    "the prompt mentions no pack, no CLI, and no front end",
    !/pack|t3 pack|front ?end|web/i.test(prompt),
    prompt,
  );
  check("the request goes to the agent", await sendAgentMessage(account.page, prompt));

  phase("Does it go and look?");
  const looked = await waitForAny(account.page, /t3 pack (search|show)/i, AGENT_TURN_MS);
  check(
    "the agent runs t3 pack search or show without being told to",
    looked.found,
    looked.found ? "" : `saw: ${looked.seen.replace(/\s+/g, " ").slice(-200)}`,
  );

  // The instruction says to run the CLI; this is whether the CLI was there to
  // run. Written by the server when the agent session spawned.
  const shimPath = findShim();
  check(
    "the shim the agent needs was put on its PATH",
    shimPath !== undefined,
    shimPath ?? `none of: ${SHIM_CANDIDATES.join(", ")}`,
  );
  if (shimPath !== undefined) {
    check("and it is executable", (statSync(shimPath).mode & 0o111) !== 0);
    // The whole point: run it the way the agent would, and get a pack back.
    const found = execFileSync(shimPath, ["pack", "search", "deploy"], {
      encoding: "utf8",
      env: {
        ...process.env,
        T3CODE_HOME: process.env["T3CODE_HOME"] ?? path.join(os.homedir(), ".t3"),
      },
    });
    check("and running it returns the deploy pack", /ssh-deploy/.test(found), found.split("\n")[0]);
  } else {
    skip("and it is executable", "no shim was written, so there is nothing to check");
    skip("and running it returns the deploy pack", "no shim was written");
  }

  phase("Does it say what it found, and use it?");
  const named = await waitForAny(account.page, /ssh-deploy/i, 90_000);
  check(
    "the agent names the pack it is following",
    named.found,
    named.found ? "" : `saw: ${named.seen.replace(/\s+/g, " ").slice(-200)}`,
  );

  // Nothing in the prompt says this program has no web surface. If the agent
  // raises it, it read it out of the pack.
  const raised = await waitForAny(
    account.page,
    // "front-end" with a hyphen is how it gets written about half the time, and
    // `front ?end` does not match it — a run was recorded as a failure for
    // spelling rather than behaviour.
    /no web surface|no port|cannot be reached|nobody (can|could) reach|front[\s-]?end|web (interface|ui)|http interface/i,
    AGENT_TURN_MS,
  );
  check(
    "and arrives at the terminal-program problem it was never told about",
    raised.found,
    raised.found ? "" : `saw: ${raised.seen.replace(/\s+/g, " ").slice(-200)}`,
  );
} finally {
  await browser.close();
  if (!KEEP) {
    rmSync(APP_DIR, { recursive: true, force: true });
    unlistProject(APP_DIR);
  }
}

process.exit(finish());
