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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import {
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
const APP_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-pack-${RUN_ID}`);
const PASSWORD = "PackDeploy!2026";
const ACCOUNT_A = `pack.a.${RUN_ID}@example.test`;
const ACCOUNT_B = `pack.b.${RUN_ID}@example.test`;
const ACCOUNT_C = `pack.c.${RUN_ID}@example.test`;

const SSH_HOST = process.env["T3_DEPLOY_SSH_HOST"] ?? "";
const SSH_USER = process.env["T3_DEPLOY_SSH_USER"] ?? "root";
const REMOTE_DIR = process.env["T3_DEPLOY_REMOTE_DIR"] ?? `/srv/t3-pack-${RUN_ID}`;
const PORT = process.env["T3_DEPLOY_PORT"] ?? String(19000 + (Number(RUN_ID) % 400));
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

const UI_SETTLE_MS = 2_500;
const NAVIGATION_MS = 9_000;
const AGENT_TURN_MS = 120_000;

// Every page the app serves, so "all pages work" is a list rather than a claim.
const PAGES = ["/", "/about", "/items", "/healthz"];

const { phase, check, finish } = createReporter();
const {
  signUp,
  addProject,
  openProject,
  visibleFileNames,
  editFileViaUi,
  sendAgentMessage,
  createInvite,
  acceptInvite,
  setApprovalMode,
} = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  uiSettleMs: UI_SETTLE_MS,
  navigationMs: NAVIGATION_MS,
  probeFile: "app.py",
});

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
      "import pathlib",
      "",
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
      "    build = pathlib.Path(__file__).with_name('BUILD').read_text().strip()",
      '    return {"status": "ok", "build": build}, 200',
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
    // Free the port by whoever holds it, not by command-line pattern: `pkill -f`
    // would match this very ssh command, whose line contains the gunicorn
    // invocation, and kill the shell running the deploy.
    `fuser -k ${PORT}/tcp 2>/dev/null || true`,
    "sleep 2",
    // nohup and a pid file, or the server dies with this ssh session.
    `(nohup gunicorn -w 2 -b 127.0.0.1:${PORT} app:app > deploy.log 2>&1 & echo $! > app.pid)`,
    "sleep 4",
    // Asking only "is something listening" passes against the deployment that
    // was already on this port. Demand the build id this deploy just shipped.
    `curl -fsS http://127.0.0.1:${PORT}/healthz | grep -q "$(cat BUILD)"`,
  ].join(" && ");
  return `tar czf - --exclude .git . | ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${SSH_USER}@${SSH_HOST} ${JSON.stringify(remote)}`;
}

/**
 * The route carries the project id once a project is open. The projection is
 * the fallback: the deploy CLI needs the id, and a link that has not rendered
 * yet should not be the reason this run stops.
 */
async function readProjectId(page) {
  const fromRoute = /\/project\/[^/]+\/([^/?#]+)/.exec(page.url())?.[1];
  if (fromRoute) return fromRoute;
  const database = path.join(BASE_DIR, "state.sqlite");
  if (!existsSync(database)) return null;
  const row = execFileSync(
    "sqlite3",
    [
      database,
      `select project_id from projection_projects where workspace_root = '${APP_DIR}' and deleted_at is null limit 1;`,
    ],
    { encoding: "utf8" },
  ).trim();
  return row || null;
}

/**
 * Ships whatever is in the workspace now. Each deploy stamps a new build id
 * first, so the remote health check can tell this deployment from the one that
 * was already on the port.
 */
function deploy(targetId) {
  const build = `${RUN_ID}-${(deployCount += 1)}`;
  writeViaPython("BUILD", `${build}\n`);
  try {
    t3(["deploy", "run", targetId]);
    return { ok: true, build, output: "" };
  } catch (error) {
    return {
      ok: false,
      build,
      output: `${error?.stdout ?? ""}${error?.stderr ?? ""}`.slice(0, 300),
    };
  }
}

/** A deploy is only done when the build now answering is the one just shipped. */
function checkDeployed(label, result) {
  check(`${label} deploy succeeds`, result.ok, result.ok ? "" : result.output);
  const live = liveBuild();
  check(
    `${label} deployment serves the build just shipped`,
    live === result.build,
    live === result.build ? "" : `serving ${live || "nothing"}, shipped ${result.build}`,
  );
  return result.ok && live === result.build;
}

/** What the deployed site actually serves, fetched from the host itself. */
function fetchPage(route) {
  return ssh(`curl -s http://127.0.0.1:${PORT}${route}`);
}

/** The build id the running deployment reports, or "" when it cannot say. */
function liveBuild() {
  return /"build"\s*:\s*"([^"]+)"/.exec(fetchPage("/healthz"))?.[1] ?? "";
}

function pageStatus(route) {
  return ssh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}${route}`);
}

let deployCount = 0;

function gitInWorkspace(...args) {
  return execFileSync("git", args, {
    cwd: APP_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pack Deploy E2E",
      GIT_AUTHOR_EMAIL: "pack@example.test",
      GIT_COMMITTER_NAME: "Pack Deploy E2E",
      GIT_COMMITTER_EMAIL: "pack@example.test",
    },
  }).trim();
}

// ── the run ─────────────────────────────────────────────────────────────────

if (!SSH_HOST) {
  console.error("Set T3_DEPLOY_SSH_HOST to the host this should deploy to.");
  process.exit(1);
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
const accountA = await openIsolatedSession(browser, "A");
const accountB = await openIsolatedSession(browser, "B");
const accountC = await openIsolatedSession(browser, "C");

try {
  phase("A Flask app in a real workspace");
  mkdirSync(APP_DIR, { recursive: true });
  buildFlaskApp();
  gitInWorkspace("init", "--initial-branch=main");
  gitInWorkspace("add", ".");
  gitInWorkspace("commit", "-m", "seed");
  check("python wrote the app", existsSync(path.join(APP_DIR, "app.py")), APP_DIR);
  check("the templates use inheritance", existsSync(path.join(APP_DIR, "templates/base.html")));

  phase("A: the workspace becomes a project");
  check("A signs up", await signUp(accountA, ACCOUNT_A), ACCOUNT_A);
  await addProject(accountA.page, APP_DIR);
  check("A opens the project", await openProject(accountA.page));
  const projectId = await readProjectId(accountA.page);
  check("the project carries an id", Boolean(projectId), projectId ?? "none");
  if (!projectId) throw new Error("no project id to attach a deploy target to");

  phase("Preflight, the way the pack asks for it");
  const remoteTools = ssh(
    "command -v python3 gunicorn >/dev/null && echo tools-ok || echo tools-missing",
  );
  check("the host has python3 and gunicorn", remoteTools.includes("tools-ok"), remoteTools);
  const portFree = ssh(`ss -ltn | grep -q ':${PORT} ' && echo busy || echo free`);
  check(
    "the deploy port is free before shipping",
    portFree.includes("free"),
    `port ${PORT}: ${portFree}`,
  );

  phase("A: register the deploy target and deploy");
  const added = t3([
    "deploy",
    "add",
    "--project",
    projectId,
    "--name",
    `VPS ${RUN_ID}`,
    "--command",
    buildDeployCommand(),
  ]);
  const targetId = /target (\S+)/.exec(added)?.[1] ?? null;
  check("a deploy target is registered", Boolean(targetId), targetId ?? added);
  if (!targetId) throw new Error("no deploy target to run");
  checkDeployed("A's first", deploy(targetId));

  phase("Every page the app declares");
  for (const route of PAGES) {
    check(`${route} answers 200`, pageStatus(route) === "200", pageStatus(route));
  }
  const home = fetchPage("/");
  check(
    "jinja2 rendered the page, not the template",
    home.includes('data-page="home"') && !home.includes("{%"),
  );
  check(
    "the loop rendered its items",
    ["first", "second", "third"].every((item) => fetchPage("/items").includes(item)),
  );

  phase("It is still up after the session that started it closed");
  await sleep(3_000);
  check("the service outlived its deploy session", pageStatus("/healthz") === "200");

  phase("B joins the workspace");
  const inviteB = await createInvite(accountA.page, ACCOUNT_B);
  check("A invites B", Boolean(inviteB), inviteB ?? "none");
  if (!inviteB) throw new Error("no invite for B");
  await accountB.page.goto(inviteB, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  check("B signs up from the invite", await signUp(accountB, ACCOUNT_B), ACCOUNT_B);
  const bAccepted = await acceptInvite(accountB, inviteB);
  check("B accepts the invite", bAccepted.accepted);
  check("B opens the shared project", await openProject(accountB.page));
  const bFiles = await visibleFileNames(accountB.page);
  check("B sees the app files", bFiles.includes("app.py"), bFiles.join(", "));

  phase("B changes the front end and redeploys");
  const bHeading = `edited-by-b-${RUN_ID}`;
  const bEdited = await editFileViaUi(accountB.page, {
    directory: "templates",
    file: "index.html",
    contents: `{% extends "base.html" %}{% block body %}<h1 data-page="home">${bHeading}</h1>{% endblock %}\n`,
  });
  check("B edits the template in the editor", bEdited.ok, bEdited.why);
  check(
    "B's edit reached the disk",
    readFileSync(path.join(APP_DIR, "templates/index.html"), "utf8").includes(bHeading),
  );
  checkDeployed("B's re", deploy(targetId));
  check("B's change is live on the deployment", fetchPage("/").includes(bHeading));

  phase("B works on their own branch and merges it back");
  check("A is back in the project", await openProject(accountA.page));
  check(
    "A puts the workspace on personal branches",
    await setApprovalMode(accountA.page, "Own branch"),
  );
  const branch = `collab/pack-b-${RUN_ID}`;
  gitInWorkspace("checkout", "-b", branch);
  const branchHeading = `from-branch-${RUN_ID}`;
  writeViaPython(
    "templates/about.html",
    `{% extends "base.html" %}{% block body %}<h1 data-page="about">${branchHeading}</h1>{% endblock %}\n`,
  );
  gitInWorkspace("commit", "-am", "B edits about on their branch");
  check("the branch holds B's change", gitInWorkspace("branch", "--list").includes(branch));
  gitInWorkspace("checkout", "main");
  check(
    "main does not have it yet",
    !readFileSync(path.join(APP_DIR, "templates/about.html"), "utf8").includes(branchHeading),
  );
  gitInWorkspace("merge", "--no-ff", "-m", "merge B's branch", branch);
  check(
    "the merge brings it to main",
    readFileSync(path.join(APP_DIR, "templates/about.html"), "utf8").includes(branchHeading),
  );
  checkDeployed("the merged branch's", deploy(targetId));
  check("the merged change is live", fetchPage("/about").includes(branchHeading));

  phase("C joins and changes the app by prompting the agent");
  const inviteC = await createInvite(accountA.page, ACCOUNT_C);
  check("A invites C", Boolean(inviteC), inviteC ?? "none");
  if (inviteC) {
    await accountC.page.goto(inviteC, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(6_000);
    check("C signs up from the invite", await signUp(accountC, ACCOUNT_C), ACCOUNT_C);
    const cAccepted = await acceptInvite(accountC, inviteC);
    check("C accepts the invite", cAccepted.accepted);
    check("C opens the shared project", await openProject(accountC.page));

    const cHeading = `from-c-${RUN_ID}`;
    const cFile = "templates/items.html";
    check(
      "C sends a prompt to the agent",
      await sendAgentMessage(
        accountC.page,
        `Edit ${cFile} so the h1 text is exactly ${cHeading}. Keep the extends and block tags. Do not ask questions.`,
      ),
    );
    const deadline = Date.now() + AGENT_TURN_MS;
    let applied = false;
    while (Date.now() < deadline && !applied) {
      applied = readFileSync(path.join(APP_DIR, cFile), "utf8").includes(cHeading);
      if (!applied) await sleep(5_000);
    }
    check(
      "the agent made C's change on disk",
      applied,
      applied
        ? ""
        : readFileSync(path.join(APP_DIR, cFile), "utf8").replace(/\s+/g, " ").slice(0, 120),
    );
    if (applied) {
      checkDeployed("C's", deploy(targetId));
      check("C's change is live", fetchPage("/items").includes(cHeading));
    }
  }

  phase("Everything still serves after four deploys");
  for (const route of PAGES) {
    check(`${route} still answers 200`, pageStatus(route) === "200");
  }
  const runs = t3(["deploy", "runs", "--target", targetId]);
  check(
    "every deploy is recorded",
    (runs.match(/succeeded/g) ?? []).length >= 3,
    `${(runs.match(/succeeded/g) ?? []).length} succeeded`,
  );

  phase("Result");
  console.log(`  workspace: ${APP_DIR}`);
  console.log(`  deployed:  ${SSH_USER}@${SSH_HOST}:${REMOTE_DIR} on 127.0.0.1:${PORT}`);
} finally {
  await browser.close();
  if (!KEEP) {
    rmSync(APP_DIR, { recursive: true, force: true });
    unlistProject(APP_DIR);
  }
}

process.exit(finish());
