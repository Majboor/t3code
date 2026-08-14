#!/usr/bin/env node
// The conversational half of analytics: paste a pack's integration prompt into
// the agent and see the app come back reporting what it does, then ask the
// workspace which page held people longest.
//
//   bun run dev                 # in another terminal
//   bun run test:analytics-agent
//
// This is the flow the pack format is built around — a pack carries an
// integration prompt precisely so it can be handed to an agent — so the suite
// hands over the real one rather than instructions written for the test.
//
// Needs a configured provider, since it drives a real agent turn.

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
} from "./lib/e2e-harness.mjs";

const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const ANALYTICS_URL =
  process.env["T3_ANALYTICS_URL"] ?? "http://127.0.0.1:13773/api/analytics/events";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const APP_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-aa-${RUN_ID}`);
const PASSWORD = "AgentAnalytics!2026";
const ACCOUNT = `aa.${RUN_ID}@example.test`;
const BASE_DIR = path.join(os.homedir(), ".t3");
const STREAM = "page.view";
const AGENT_TURN_MS = 180_000;
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

const { phase, check, finish } = createReporter();
const { signUp, addProject, openProject, sendAgentMessage } = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  probeFile: "app.py",
});

const CLI_ENTRY = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "apps",
  "server",
  "src",
  "bin.ts",
);
function t3(args) {
  return execFileSync("node", [CLI_ENTRY, ...args, "--base-dir", BASE_DIR, "--dev-url", BASE_URL], {
    encoding: "utf8",
    timeout: 180_000,
  }).trim();
}

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
        "analytics-core",
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

function projectIdFor() {
  const database = path.join(BASE_DIR, "dev", "state.sqlite");
  if (!existsSync(database)) return null;
  return (
    execFileSync(
      "sqlite3",
      [
        database,
        `select project_id from projection_projects where workspace_root = '${APP_DIR}' and deleted_at is null limit 1;`,
      ],
      { encoding: "utf8" },
    ).trim() || null
  );
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
  phase("An app that reports nothing yet");
  mkdirSync(APP_DIR, { recursive: true });
  writeFile(
    "app.py",
    [
      "from flask import Flask",
      "",
      "app = Flask(__name__)",
      "",
      "",
      '@app.route("/<page>")',
      "def show(page):",
      '    return f"you are reading {page}"',
      "",
    ].join("\n"),
  );
  check(
    "the app exists and reports nothing",
    !readFileSync(path.join(APP_DIR, "app.py"), "utf8").includes("analytics"),
  );

  phase("The project, and a stream for it to report to");
  check("the account signs up", await signUp(account, ACCOUNT), ACCOUNT);
  await addProject(account.page, APP_DIR);
  const projectId = projectIdFor();
  check("the project is registered", Boolean(projectId), projectId ?? "none");
  if (!projectId) throw new Error("no project");

  // Step one of the pack's own instructions: declare before anything sends.
  const declared = t3([
    "analytics",
    "declare",
    "--project",
    projectId,
    "--name",
    STREAM,
    "--purpose",
    "Which pages get read",
    "--properties",
    "path:string:required,seconds:number",
  ]);
  const ingestKey = /Ingest key \(shown once\): (\S+)/.exec(declared)?.[1] ?? null;
  check("the stream is declared and hands back a key", Boolean(ingestKey));
  if (!ingestKey) throw new Error("no ingest key");

  phase("Hand the pack's integration prompt to the agent");
  const prompt = integrationPrompt();
  check(
    "the pack has an integration prompt to hand over",
    prompt.length > 200,
    `${prompt.length} characters`,
  );
  check("A opens the project", await openProject(account.page));

  const instruction = [
    prompt,
    "",
    "Do that for app.py in this workspace. Concretely:",
    `- The endpoint is ${ANALYTICS_URL}`,
    `- projectId is ${projectId}`,
    `- stream is ${STREAM}`,
    `- ingestKey is ${ingestKey}`,
    "- Report every page view with properties {path, seconds}, where seconds is how long the request took.",
    "- Keep the existing route working. Do not ask questions; edit app.py and stop.",
  ].join("\n");
  check("the prompt goes to the agent", await sendAgentMessage(account.page, instruction));

  phase("What the agent wrote");
  const deadline = Date.now() + AGENT_TURN_MS;
  let source = "";
  let reports = false;
  const appPath = path.join(APP_DIR, "app.py");
  while (Date.now() < deadline && !reports) {
    // The agent rewrites the file rather than editing in place, so it is
    // briefly absent. Treating that as an error ends the run mid-edit.
    source = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";
    reports = source.includes(ANALYTICS_URL) && source.includes(ingestKey);
    if (!reports) await sleep(6_000);
  }
  check(
    "app.py is still there when the turn ends",
    existsSync(appPath),
    existsSync(appPath) ? "" : `directory holds: ${readdirSync(APP_DIR).join(", ")}`,
  );
  // A turn that never ran and a turn that ran badly look the same on disk, so
  // say which before reporting the file as unchanged.
  const thread = await bodyText(account.page);
  const providerTrouble =
    /Provider turn start failed|Timed out waiting for initialize|read-only|waiting for the workspace lead/.exec(
      thread,
    );
  check("the turn reached a provider", providerTrouble === null, providerTrouble?.[0] ?? "");
  check(
    "the app now posts to the analytics endpoint",
    reports,
    reports ? "" : `still: ${source.replace(/\s+/g, " ").slice(0, 120)}`,
  );
  check("it sends the declared properties", /path/.test(source) && /seconds/.test(source));
  // The pack says reporting must never break serving; check it was heeded.
  check(
    "it wrapped the report so a failure cannot break the page",
    /try\s*:/.test(source) && /except/.test(source),
    /try\s*:/.test(source) ? "" : "no try/except around the post",
  );

  phase("Run it and read a few pages");
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  }).trim();
  const port = String(19800 + (Number(RUN_ID) % 150));
  execFileSync("bash", [
    "-c",
    `cd ${JSON.stringify(APP_DIR)} && (nohup ${JSON.stringify(python)} -m gunicorn -w 1 -b 127.0.0.1:${port} app:app > run.log 2>&1 & echo $! > app.pid)`,
  ]);
  await sleep(6_000);

  let served = 0;
  for (const page of ["intro", "middle", "middle", "end"]) {
    // curl exits non-zero when nothing is listening, and that is a result to
    // report rather than an exception that ends the run.
    const status = execFileSync(
      "bash",
      ["-c", `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/${page} || true`],
      { encoding: "utf8" },
    ).trim();
    if (status === "200") served += 1;
  }
  const runLog = existsSync(path.join(APP_DIR, "run.log"))
    ? readFileSync(path.join(APP_DIR, "run.log"), "utf8")
    : "";
  check(
    "the app still serves its pages",
    served === 4,
    served === 4 ? "" : `${served}/4 — ${runLog.replace(/\s+/g, " ").slice(-140)}`,
  );
  await sleep(4_000);

  phase("Ask the workspace what happened");
  const counted = t3([
    "analytics",
    "query",
    "--project",
    projectId,
    "--stream",
    STREAM,
    "--aggregate",
    "count",
    "--group-by",
    "path",
  ]);
  check(
    "the reads reached the workspace",
    /middle/.test(counted),
    counted.replace(/\n/g, " | ").slice(0, 120),
  );
  check(
    "the page read twice is counted twice",
    /middle\s+2/.test(counted),
    counted.replace(/\n/g, " | ").slice(0, 120),
  );

  phase("Result");
  console.log(`  workspace: ${APP_DIR}`);
  console.log(`  served on: http://127.0.0.1:${port}/`);
} finally {
  const pidFile = path.join(APP_DIR, "app.pid");
  if (existsSync(pidFile)) {
    execFileSync("bash", ["-c", `kill "$(cat ${JSON.stringify(pidFile)})" 2>/dev/null || true`]);
  }
  await browser.close();
  if (!KEEP) rmSync(APP_DIR, { recursive: true, force: true });
}

process.exit(finish());
