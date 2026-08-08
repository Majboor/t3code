#!/usr/bin/env node
// Builds a Flask app in a real workspace, registers it as a deploy target, and
// deploys it to a server by following the procedure the ssh-flask-deploy pack
// describes. Then it checks every page the app declares actually answers.
//
//   bun run dev                 # in another terminal
//   bun run test:pack-deploy
//
// The deploy host comes from the environment, never from this file:
//
//   T3_DEPLOY_SSH_HOST   host to deploy to        (required)
//   T3_DEPLOY_SSH_USER   ssh user                 (default: root)
//   T3_DEPLOY_REMOTE_DIR remote directory         (default: /srv/t3-pack-<run id>)
//   T3_DEPLOY_PORT       loopback port on the host (default: 18902)
//
// Authentication is by key: the pack refuses to put a password on a command
// line, and a `command` target never receives one anyway.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("playwright");

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const APP_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-pack-${RUN_ID}`);
const PASSWORD = "PackDeploy!2026";
const ACCOUNT = `pack.${RUN_ID}@example.test`;

const SSH_HOST = process.env["T3_DEPLOY_SSH_HOST"] ?? "";
const SSH_USER = process.env["T3_DEPLOY_SSH_USER"] ?? "root";
const REMOTE_DIR = process.env["T3_DEPLOY_REMOTE_DIR"] ?? `/srv/t3-pack-${RUN_ID}`;
const PORT = process.env["T3_DEPLOY_PORT"] ?? "18902";
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

const UI_SETTLE_MS = 2_500;
const NAVIGATION_MS = 9_000;

// Every page the app serves, so "all pages work" is a list rather than a claim.
const PAGES = ["/", "/about", "/items", "/healthz"];

const results = [];
let currentPhase = "setup";

function phase(title) {
  currentPhase = title;
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

function check(step, ok, detail = "") {
  results.push({ phase: currentPhase, step, ok });
  console.log(`  ${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${step}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeViaPython(relativePath, contents) {
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

function ssh(command) {
  return execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", `${SSH_USER}@${SSH_HOST}`, command],
    { encoding: "utf8", timeout: 120_000 },
  ).trim();
}

// The CLI keeps its own store unless told otherwise, and a deploy target the
// running app cannot see is not much of a deploy target.
const BASE_DIR = process.env["T3CODE_HOME"] ?? path.join(os.homedir(), ".t3", "dev");

const CLI_ENTRY = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "apps",
  "server",
  "src",
  "bin.ts",
);

/**
 * Runs the product's own CLI, which is the path an agent would take. `deploy
 * run` tars whatever directory it is called from, so the caller's cwd is part
 * of the command rather than an incidental detail.
 */
function t3(args, options = {}) {
  return execFileSync("node", [CLI_ENTRY, ...args, "--base-dir", BASE_DIR], {
    cwd: options.cwd ?? APP_DIR,
    encoding: "utf8",
    timeout: 180_000,
  }).trim();
}

function buildFlaskApp() {
  writeViaPython(
    "app.py",
    [
      "from flask import Flask, render_template",
      "",
      "app = Flask(__name__)",
      "",
      'PAGES = [("/", "Home"), ("/about", "About"), ("/items", "Items")]',
      'ITEMS = ["first", "second", "third"]',
      "",
      "",
      '@app.route("/")',
      "def index():",
      '    return render_template("index.html", title="Home", pages=PAGES)',
      "",
      "",
      '@app.route("/about")',
      "def about():",
      '    return render_template("about.html", title="About", pages=PAGES)',
      "",
      "",
      '@app.route("/items")',
      "def items():",
      '    return render_template("items.html", title="Items", pages=PAGES, items=ITEMS)',
      "",
      "",
      '@app.route("/healthz")',
      "def healthz():",
      '    return {"status": "ok"}, 200',
      "",
    ].join("\n"),
  );
  writeViaPython(
    "templates/base.html",
    [
      "<!doctype html>",
      "<title>{{ title }} — t3 pack</title>",
      '<nav>{% for href, label in pages %}<a href="{{ href }}">{{ label }}</a> {% endfor %}</nav>',
      "<main>{% block body %}{% endblock %}</main>",
      "",
    ].join("\n"),
  );
  writeViaPython(
    "templates/index.html",
    '{% extends "base.html" %}{% block body %}<h1 data-page="home">Home</h1>{% endblock %}\n',
  );
  writeViaPython(
    "templates/about.html",
    '{% extends "base.html" %}{% block body %}<h1 data-page="about">About</h1>{% endblock %}\n',
  );
  writeViaPython(
    "templates/items.html",
    [
      '{% extends "base.html" %}{% block body %}<h1 data-page="items">Items</h1>',
      "<ul>{% for item in items %}<li>{{ item }}</li>{% endfor %}</ul>{% endblock %}",
      "",
    ].join("\n"),
  );
}

/**
 * The four steps the pack's integration prompt lays out: preflight, ship,
 * start detached, then verify from a separate session.
 */
function buildDeployCommand() {
  const remote = [
    `mkdir -p ${REMOTE_DIR}`,
    `tar xzf - -C ${REMOTE_DIR}`,
    `cd ${REMOTE_DIR}`,
    // Stop the previous run by its recorded pid. `pkill -f` would match this
    // very ssh command, whose line contains the gunicorn invocation, and kill
    // the shell running the deploy.
    "([ -f app.pid ] && kill \"$(cat app.pid)\" 2>/dev/null || true)",
    "sleep 1",
    // nohup and a pid file, or the server dies with this ssh session.
    `(nohup gunicorn -w 2 -b 127.0.0.1:${PORT} app:app > deploy.log 2>&1 & echo $! > app.pid)`,
    "sleep 4",
    `curl -fsS http://127.0.0.1:${PORT}/healthz`,
  ].join(" && ");
  return `tar czf - --exclude .git . | ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${SSH_USER}@${SSH_HOST} ${JSON.stringify(remote)}`;
}

async function signUp(page) {
  await page.goto(`${BASE_URL}/pair`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await sleep(4_000);
  await page.locator('button:has-text("Sign up")').first().click().catch(() => undefined);
  await sleep(1_000);
  await page.fill('input[type="email"]', ACCOUNT);
  await page.fill('input[type="password"]', PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await sleep(NAVIGATION_MS);
  return !page.url().includes("/pair");
}

async function addProject(page) {
  await page.locator('button:has-text("Add project")').first().click();
  await sleep(UI_SETTLE_MS);
  await page.locator("[data-base-ui-portal] input").first().fill(APP_DIR);
  await sleep(3_000);
  await page.keyboard.press("Enter");
  await sleep(NAVIGATION_MS);
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(1_000);
}

/**
 * The route carries the project id once a project is open. The projection is
 * the fallback: the deploy CLI needs the id, and a link that has not rendered
 * yet should not be the reason this run stops.
 */
async function openProjectAndReadId(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  const link = page.locator('[data-testid="dashboard-workspace-project-link"]').first();
  if ((await link.count()) > 0) {
    await link.click();
    await sleep(NAVIGATION_MS);
    const fromRoute = /\/project\/[^/]+\/([^/?#]+)/.exec(page.url())?.[1];
    if (fromRoute) return fromRoute;
  }
  const database = path.join(os.homedir(), ".t3", "dev", "state.sqlite");
  if (!existsSync(database)) return null;
  const row = execFileSync(
    "sqlite3",
    [database, `select project_id from projection_projects where workspace_root = '${APP_DIR}' and deleted_at is null limit 1;`],
    { encoding: "utf8" },
  ).trim();
  return row || null;
}

// ── the run ─────────────────────────────────────────────────────────────────

if (!SSH_HOST) {
  console.error("Set T3_DEPLOY_SSH_HOST to the host this should deploy to.");
  process.exit(1);
}

const reachable = await fetch(BASE_URL, { redirect: "manual" }).then(() => true, () => false);
if (!reachable) {
  console.error(`Nothing is answering at ${BASE_URL}. Start one with \`bun run dev\`.`);
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

try {
  phase("A Flask app in a real workspace");
  mkdirSync(APP_DIR, { recursive: true });
  buildFlaskApp();
  check("python wrote the app", existsSync(path.join(APP_DIR, "app.py")), APP_DIR);
  check("the templates use inheritance", existsSync(path.join(APP_DIR, "templates/base.html")));

  phase("The workspace becomes a project");
  check("the account signs up", await signUp(page), ACCOUNT);
  await addProject(page);
  const projectId = await openProjectAndReadId(page);
  check("the project opens and carries an id", Boolean(projectId), projectId ?? "none");
  if (!projectId) throw new Error("no project id to attach a deploy target to");

  phase("Preflight, the way the pack asks for it");
  const remoteTools = ssh("command -v python3 gunicorn >/dev/null && echo tools-ok || echo tools-missing");
  check("the host has python3 and gunicorn", remoteTools.includes("tools-ok"), remoteTools);
  const portFree = ssh(`ss -ltn | grep -q ':${PORT} ' && echo busy || echo free`);
  check("the deploy port is free before shipping", portFree.includes("free"), `port ${PORT}: ${portFree}`);

  phase("Register the deploy target");
  const added = t3(["deploy", "add", "--project", projectId, "--name", `VPS ${RUN_ID}`, "--command", buildDeployCommand()]);
  const targetId = /target (\S+)/.exec(added)?.[1] ?? null;
  check("a deploy target is registered", Boolean(targetId), targetId ?? added);
  const listed = t3(["deploy", "list", "--project", projectId]);
  check("the target is listed against the project", listed.includes(targetId ?? " "));
  if (!targetId) throw new Error("no deploy target to run");

  phase("Deploy");
  let deployOutput = "";
  let deployFailed = null;
  try {
    deployOutput = t3(["deploy", "run", targetId]);
  } catch (error) {
    deployFailed = error instanceof Error ? error.message : String(error);
    deployOutput = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
  }
  check("the deploy run succeeds", deployFailed === null,
    deployFailed ? deployOutput.replace(/\s+/g, " ").slice(0, 200) : "");
  const runs = t3(["deploy", "runs", "--target", targetId]);
  check("the run is recorded for later inspection", /succeeded|failed/.test(runs),
    runs.replace(/\s+/g, " ").slice(0, 160));

  phase("Every page the app declares");
  for (const route of PAGES) {
    const status = ssh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}${route}`);
    check(`${route} answers 200`, status === "200", status);
  }
  const home = ssh(`curl -s http://127.0.0.1:${PORT}/`);
  check("jinja2 rendered the page, not the template", home.includes('data-page="home"') && !home.includes("{%"));
  const items = ssh(`curl -s http://127.0.0.1:${PORT}/items`);
  check("the loop rendered its items", ["first", "second", "third"].every((item) => items.includes(item)));

  phase("It is still up after the session that started it closed");
  await sleep(3_000);
  const survived = ssh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/healthz`);
  check("the service outlived its deploy session", survived === "200", survived);

  phase("Result");
  console.log(`  workspace: ${APP_DIR}`);
  console.log(`  deployed:  ${SSH_USER}@${SSH_HOST}:${REMOTE_DIR} on 127.0.0.1:${PORT}`);
} finally {
  await browser.close();
  if (!KEEP) rmSync(APP_DIR, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const result of failed) console.log(`  FAILED  [${result.phase}] ${result.step}`);
process.exit(failed.length === 0 ? 0 : 1);
