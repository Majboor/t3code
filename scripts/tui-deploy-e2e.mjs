#!/usr/bin/env node
// Does the deploy pack's knowledge actually steer an agent?
//
//   bun run dev                 # in another terminal
//   bun run test:tui-deploy
//
// A terminal program has no port and cannot pass a health check, so deploying
// it unchanged produces something nobody can reach. The ssh-deploy pack says
// so, and says to stop and agree a front end first. This suite hands the agent
// that pack and a TUI, and checks the agent raises the problem instead of
// writing a deploy command — then that it builds the front end it proposed.
//
// The first half is the interesting one: it is the difference between knowledge
// sitting in a manifest and knowledge changing what happens.
//
// Needs a configured provider.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const APP_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-tui-${RUN_ID}`);
const PASSWORD = "TuiDeploy!2026";
const ACCOUNT = `tui.${RUN_ID}@example.test`;
const AGENT_TURN_MS = 240_000;
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

const { phase, check, finish } = createReporter();
const { signUp, addProject, openProject, sendAgentMessage } = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  probeFile: "todo.py",
});

/**
 * The pack's own words, read from the copy in this repository rather than from
 * whatever happens to be in the local registry. A suite that depends on a pack
 * somebody published on one machine is a suite that only runs there.
 */
function integrationPrompt() {
  const manifest = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "packs",
        "ssh-deploy",
        "pack.json",
      ),
      "utf8",
    ),
  );
  return manifest.integration.prompt;
}

function writeFile(relativePath, contents) {
  execFileSync("python3", [
    "-c",
    [
      "import pathlib, sys",
      "target = pathlib.Path(sys.argv[1])",
      "target.parent.mkdir(parents=True, exist_ok=True)",
      "target.write_text(sys.argv[2])",
    ].join("\n"),
    path.join(APP_DIR, relativePath),
    contents,
  ]);
}

/** Waits for the agent to stop writing, so the reply is read whole. */
async function waitForReply(page, matches, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await bodyText(page);
    if (matches.test(seen)) return { found: true, seen };
    await sleep(6_000);
  }
  return { found: false, seen };
}

// ── the run ─────────────────────────────────────────────────────────────────

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
  phase("A program with no web surface at all");
  mkdirSync(APP_DIR, { recursive: true });
  writeFile(
    "todo.py",
    [
      '"""A todo list you drive from a terminal. It opens no port and serves nothing."""',
      "import sys",
      "",
      "TASKS = []",
      "",
      "",
      "def render():",
      '    print("\\n== todo ==")',
      "    for index, task in enumerate(TASKS, start=1):",
      '        print(f"{index}. {task}")',
      '    print("[a]dd  [d]one  [q]uit")',
      "",
      "",
      "def main():",
      "    while True:",
      "        render()",
      "        key = sys.stdin.readline().strip()",
      '        if key == "q":',
      "            return",
      '        if key == "a":',
      "            TASKS.append(sys.stdin.readline().strip())",
      '        elif key == "d" and TASKS:',
      "            TASKS.pop(0)",
      "",
      "",
      'if __name__ == "__main__":',
      "    main()",
      "",
    ].join("\n"),
  );
  check("the program exists", existsSync(path.join(APP_DIR, "todo.py")), APP_DIR);
  // Look for the constructs that would open a socket, not for the words. The
  // docstring says "opens no port", and matching prose failed this check
  // against a file that is exactly what it claims to be.
  check(
    "and it opens no socket",
    !/\b(import (flask|http\.server|socket)|from flask|app\.run|listen\()/i.test(
      readFileSync(path.join(APP_DIR, "todo.py"), "utf8"),
    ),
  );

  phase("Ask the agent to deploy it, with the pack in hand");
  check("the account signs up", await signUp(account, ACCOUNT), ACCOUNT);
  await addProject(account.page, APP_DIR);
  check("A opens the project", await openProject(account.page));

  const prompt = integrationPrompt();
  check(
    "the deploy pack has an integration prompt",
    prompt.length > 200,
    `${prompt.length} characters`,
  );
  check(
    "the pack itself raises the terminal-program case",
    /terminal program/i.test(prompt),
    prompt.replace(/\s+/g, " ").slice(0, 90),
  );

  check(
    "the request goes to the agent",
    await sendAgentMessage(
      account.page,
      [prompt, "", "Deploy todo.py from this workspace. Follow the guidance above."].join("\n"),
    ),
  );

  phase("What the agent does with a thing that has no port");
  // The pack's claim is that an agent holding it will not silently ship a
  // program nobody can reach. This is that claim, checked.
  const raised = await waitForReply(
    account.page,
    /no web surface|no port|cannot be reached|nobody (can|could) reach|health check|front end|frontend|web interface/i,
    AGENT_TURN_MS,
  );
  check(
    "the agent raises the problem rather than writing a deploy command",
    raised.found,
    raised.found ? "" : `saw: ${raised.seen.replace(/\s+/g, " ").slice(-160)}`,
  );

  const proposes = /front ?end|web (interface|ui|version|surface)|http interface/i.test(
    raised.seen,
  );
  check(
    "and offers to build a front end over the same functionality",
    proposes,
    proposes ? "" : raised.seen.replace(/\s+/g, " ").slice(-160),
  );

  // Shipping the TUI unchanged is exactly the failure the pack exists to stop.
  const filesNow = readdirSync(APP_DIR);
  check(
    "nothing was deployed behind the question",
    !filesNow.includes("BUILD") && !filesNow.includes("app.pid"),
    filesNow.join(", "),
  );

  phase("Agree the front end, and let it build");
  check(
    "the go-ahead goes to the agent",
    await sendAgentMessage(
      account.page,
      [
        "Yes, build that web front end over the same functionality.",
        "Put it in web.py as a Flask app: list tasks, add one, complete one.",
        "Give it a /healthz that returns 200. Do not ask further questions.",
      ].join("\n"),
    ),
  );

  const deadline = Date.now() + AGENT_TURN_MS;
  let web = "";
  while (Date.now() < deadline && !web.includes("healthz")) {
    const target = path.join(APP_DIR, "web.py");
    web = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (!web.includes("healthz")) await sleep(6_000);
  }
  check(
    "a web front end now exists",
    web.length > 0,
    web.length > 0 ? "" : `directory holds: ${readdirSync(APP_DIR).join(", ")}`,
  );
  check("it answers a health check, which is what makes it deployable", web.includes("healthz"));
  check("the original program is left alone", existsSync(path.join(APP_DIR, "todo.py")));

  phase("Result");
  console.log(`  workspace: ${APP_DIR}`);
} finally {
  await browser.close();
  if (!KEEP) {
    rmSync(APP_DIR, { recursive: true, force: true });
    unlistProject(APP_DIR);
  }
}

process.exit(finish());
