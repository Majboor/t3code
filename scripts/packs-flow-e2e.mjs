#!/usr/bin/env node
// Three people, one folder, and every surface the packs story promises.
//
//   bun run dev                 # in another terminal
//   bun run test:packs-flow
//
// The flow this walks, in the order somebody would live it:
//
//   1. Somebody makes a folder at run time and the agent builds a Flask app
//      with a Jinja front end in it.
//   2. They publish it and deploy it.
//   3. A second person changes it and updates the deployment, then takes a
//      branch, changes that, and merges it back.
//   4. A third person prompts in chat; their change is what is served.
//   5. The deploy pack is one of the packs that ship with the product, and the
//      same buttons let somebody publish a pack of their own with a link to
//      share.
//   6. The analytics pack is turned on and the metrics are agreed in
//      conversation rather than chosen from a list: the agent declares a stream
//      nobody wrote down in advance, adds the endpoint that feeds it, wires it
//      into the deploy, and the chart is drawn from that declaration.
//   7. Deploying is not only for Flask apps.
//
// Everything is deployed locally, on loopback. The point here is the chain of
// surfaces, and an SSH node adds a second thing that can be broken without
// adding anything that can be learned — `collab-deploy-analytics-e2e` already
// walks the node and the tunnel.
//
//   T3_E2E_BASE_URL        the web app       (default http://localhost:5733)
//   T3_ANALYTICS_URL       the ingest route  (default http://127.0.0.1:13773/api/analytics/events)
//   T3_E2E_KEEP_WORKSPACE  keep the directory
//   T3_E2E_PHASES          run a subset, e.g. "1,2,3"
//
// Needs a configured provider for every account it creates, since six of the
// steps are real agent turns.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const ANALYTICS_URL =
  process.env["T3_ANALYTICS_URL"] ?? "http://127.0.0.1:13773/api/analytics/events";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const ROOT_DIR = existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir();
const PROJECT_DIR = path.join(ROOT_DIR, `t3-packs-flow-${RUN_ID}`);
const BASE_DIR = path.join(os.homedir(), ".t3");
const PASSWORD = "PacksFlow!2026";
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";
const PORT = 19940 + (Number(RUN_ID) % 30);

/** Which phases to run, so a failure in one can be re-run on its own. */
const PHASES = new Set(
  (process.env["T3_E2E_PHASES"] ?? "1,2,3,4,5,6")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

// A deploy turn on a loaded machine has taken most of ten minutes, and the wait
// returns the moment the right build appears, so a generous budget costs
// nothing except on a deploy that is genuinely not coming.
const DEPLOY_TURN_MS = 600_000;
const BUILD_TURN_MS = 420_000;

const reporter = createReporter();
const { phase, check, skip, finish } = reporter;

const harness = createHarness({ baseUrl: BASE_URL, password: PASSWORD, probeFile: "README.md" });
const {
  signUp,
  addProject,
  openProject,
  sendAgentMessage,
  createInvite,
  acceptInvite,
  editFileViaUi,
  closeWorkspacePanel,
  setApprovalMode,
  openCollabPanel,
  closeCollabPanel,
  waitForCollabElement,
} = harness;

const CLI_ENTRY = path.join(REPO, "apps", "server", "src", "bin.ts");

function t3(args) {
  return execFileSync("node", [CLI_ENTRY, ...args, "--base-dir", BASE_DIR, "--dev-url", BASE_URL], {
    encoding: "utf8",
    timeout: 180_000,
  }).trim();
}

/** Writes through python3, so the change originates outside the app. */
function writeFile(relativePath, contents) {
  execFileSync("python3", [
    "-c",
    [
      "import pathlib, sys",
      "target = pathlib.Path(sys.argv[1])",
      "target.parent.mkdir(parents=True, exist_ok=True)",
      "target.write_text(sys.argv[2])",
    ].join("\n"),
    path.join(PROJECT_DIR, relativePath),
    contents,
  ]);
}

/** Git in the project, returning stdout. Throws, so callers who do not care use `tryGit`. */
function git(...args) {
  return execFileSync("git", args, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Packs Flow",
      GIT_AUTHOR_EMAIL: "packs@example.test",
      GIT_COMMITTER_NAME: "Packs Flow",
      GIT_COMMITTER_EMAIL: "packs@example.test",
    },
  }).trim();
}

/** The same, for the calls where "it did not work" is an answer rather than an error. */
function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return "";
  }
}

function sh(command, options = {}) {
  return execFileSync("bash", ["-c", command], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    ...options,
  }).trim();
}

/** Never throws: something that is not listening is a result, not an exception. */
function tryBody(url) {
  try {
    return sh(`curl -s --max-time 20 ${JSON.stringify(url)} || true`);
  } catch {
    return "";
  }
}

function tryHeaders(url) {
  try {
    return sh(`curl -s -D - -o /dev/null --max-time 20 ${JSON.stringify(url)} || true`);
  } catch {
    return "";
  }
}

const PYTHON = sh("python3 -c 'import sys; print(sys.executable)'");

/** The project row the app created for the directory. */
function projectIdFor() {
  const database = path.join(BASE_DIR, "dev", "state.sqlite");
  if (!existsSync(database)) return null;
  return (
    execFileSync("sqlite3", [
      database,
      `select project_id from projection_projects where workspace_root = '${PROJECT_DIR.replaceAll("'", "''")}' and deleted_at is null limit 1;`,
    ])
      .toString()
      .trim() || null
  );
}

/** A pack's own words, from this repository rather than whatever was published. */
function packPrompt(name) {
  return JSON.parse(readFileSync(path.join(REPO, "packs", name, "pack.json"), "utf8")).integration
    .prompt;
}

/** Reports a turn as failed for a provider reason rather than a product one. */
async function providerTrouble(page) {
  const thread = await bodyText(page);
  return (
    /No (?:Codex|Claude) account is connected|Provider turn start failed|Timed out waiting for initialize|read-only|waiting for the workspace lead/.exec(
      thread,
    )?.[0] ?? null
  );
}

// ── driving a deploy ────────────────────────────────────────────────────────

/**
 * The deploy pack's prompt plus the facts this deployment needs.
 *
 * The facts are supplied rather than left to be discovered because what is
 * under test is whether the pack's instructions produce a working deployment,
 * not whether an agent can guess a port.
 */
function deployInstruction({ buildId, projectId, analytics = null, extra = [] }) {
  const lines = [
    packPrompt("ssh-deploy"),
    "",
    `Do that for the project in ${PROJECT_DIR}. Concretely:`,
    "- The target is `local`.",
    `- The project id is ${projectId}.`,
    `- Write the build id ${buildId} into a file called BUILD before you ship, and serve it from /healthz.`,
    `- Bind 127.0.0.1:${PORT}.`,
    `- The start command must, in this order: stamp BUILD, stop whatever the last deploy left on the port (kill the pid in app.pid if it is there), start ${JSON.stringify(PYTHON)} -m gunicorn -w 2 -b 127.0.0.1:${PORT} app:app detached with nohup, and write the new pid to app.pid.`,
    "- /healthz reads BUILD once at import, so a stale process from the last deploy cannot answer for the new one. If the port is still held the new build will simply never appear, which is the point.",
    `- Nothing may be left on ${PORT} when the deploy runs, including anything you started yourself to test. Stop it first.`,
    "- Make the start command's failures readable: `gunicorn --daemon` detaches its stdio, so a bind failure lands nowhere and the run exits non-zero with an empty log. Pass `--error-logfile app.err` so there is something to read.",
    // Step 7 of the pack's own prompt. Restated because it decides whether any
    // of this is visible to the project afterwards, and the name is supplied
    // because a deployment is identified by it: renaming it on a redeploy
    // stands up a rival reporting to the same stream, which is then refused.
    `- Run it through T3 so it is recorded, not by hand: register the target with \`t3 deploy add\`, naming it exactly \`flask-${PORT}\`, and then \`t3 deploy run <targetId> --url http://127.0.0.1:${PORT}\`.`,
    `- Use that name every time. Registering \`flask-${PORT}\` again re-registers the same target, so a redeploy replaces what is there rather than standing up a second one beside it.`,
    ...extra,
  ];
  if (analytics) {
    lines.push(
      `- The deployment must report to the analytics stream \`${analytics.stream}\`.`,
      `  Let the deploy declare it and mint the key: add \`--analytics-stream ${analytics.stream} --analytics-properties ${JSON.stringify(analytics.properties)} --analytics-purpose ${JSON.stringify(analytics.purpose)}\` to \`t3 deploy run\`. The key arrives in the process as T3_ANALYTICS_INGEST_KEY and must never be written to a file.`,
      "  The other three are not secret, so set them in the target's start command itself:",
      `    T3_ANALYTICS_URL=${ANALYTICS_URL}`,
      `    T3_PROJECT_ID=${analytics.projectId}`,
      `    T3_STREAM=${analytics.stream}`,
    );
  }
  lines.push("- Do not ask questions. Do the deploy and report the address it is serving on.");
  return lines.join("\n");
}

/** Waits for the build id the deploy was told to stamp to be the one serving. */
async function waitForBuild(buildId, timeoutMs = DEPLOY_TURN_MS) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = tryBody(`http://127.0.0.1:${PORT}/healthz`);
    if (seen.includes(buildId)) return { ok: true, seen };
    await sleep(8_000);
  }
  return { ok: false, seen };
}

/**
 * How many times to tell the agent the deploy is not done before giving up.
 *
 * One. A turn can stop mid-task, and waiting longer cannot fix a turn in which
 * nobody is working — only saying so can, which is what the person sitting
 * there would do. The count is reported, so a deploy that needed chasing is
 * never recorded as a clean one.
 */
const MAX_DEPLOY_NUDGES = 1;

async function deployAndWait(page, instruction, buildId) {
  const sent = await sendAgentMessage(page, instruction);
  let result = await waitForBuild(buildId);
  let nudges = 0;
  while (!result.ok && nudges < MAX_DEPLOY_NUDGES) {
    nudges += 1;
    await sendAgentMessage(
      page,
      [
        `http://127.0.0.1:${PORT}/healthz is still not serving build ${buildId}, so the deploy is not done.`,
        "Finish it now, in this turn: register the target with `t3 deploy add` under the name you were given, run it with `t3 deploy run`, then check /healthz reports that build id.",
      ].join("\n"),
    );
    result = await waitForBuild(buildId);
  }
  return { sent, result, nudges };
}

function describeDeploy(buildId, { result, nudges }) {
  const chased = nudges === 0 ? "" : ` (after ${nudges} nudge${nudges === 1 ? "" : "s"})`;
  return result.ok ? `${buildId}${chased}` : `${result.seen.slice(0, 110)}${chased}`;
}

// ── reading the pages a person reads ────────────────────────────────────────

async function goTo(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(8_000);
}

/**
 * Invites once the dashboard has actually drawn the control.
 *
 * The owner's dashboard re-renders while another account signs up in a second
 * context, and the button arrives late often enough to end an otherwise good
 * run — so wait for the control rather than for a duration.
 */
async function inviteWhenReady(page, email, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const button = page.locator('button:has-text("Invite")').first();
    const ready = await button
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) continue;
    const link = await createInvite(page, email);
    if (link) return link;
  }
  return null;
}

/** Turns a pack on for this project from the pack's own page. */
async function enablePackForProject(page, packId) {
  await goTo(page, `/pack/${packId}`);
  const enable = page.locator('[data-testid="pack-detail-enable"]').first();
  if ((await enable.count()) === 0) return { ok: false, why: "no enable control on the pack page" };
  const project = page.locator('[data-testid="pack-enable-project"]').first();
  if ((await project.count()) === 0) return { ok: false, why: "no project offered" };
  await project.click();
  await sleep(1_000);
  await page.locator('[data-testid="pack-enable-confirm"]').first().click();
  await sleep(9_000);
  return { ok: /\/infra\//.test(page.url()), why: page.url() };
}

/**
 * What the Infrastructure tab says, once it has had the chance to say it.
 *
 * The load figure is the last thing in the chain to become true: a deploy
 * registers its stream at the end of the turn, so a single read taken right
 * after the health check passes catches the row live, listed and not yet
 * wired, and reports "not wired" about a deployment that is about to be.
 */
async function readInfraTab(page, projectId, { waitForLoadMs = 90_000 } = {}) {
  const deadline = Date.now() + waitForLoadMs;
  let seen = null;
  do {
    await goTo(page, `/infra/${projectId}`);
    const rows = page.locator('[data-testid="infra-deployment"]');
    seen = {
      deployments: await rows.count(),
      events: await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-events"))),
      loads: await page.locator('[data-testid="infra-deployment-load"]').allInnerTexts(),
      enablements: await page.locator('[data-testid="infra-enablement"]').count(),
      body: await bodyText(page),
    };
    if (seen.events.some((value) => value !== null)) return seen;
  } while (Date.now() < deadline);
  return seen;
}

/** The streams a project has, read the way the CLI reads them. */
function streamsFor(projectId) {
  try {
    return t3(["analytics", "list", "--project", projectId]);
  } catch (error) {
    return String(error?.stdout ?? "") + String(error?.stderr ?? "");
  }
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
const one = await openIsolatedSession(browser, "one");
const two = await openIsolatedSession(browser, "two");
const three = await openIsolatedSession(browser, "three");
const emailOne = `pf.one.${RUN_ID}@example.test`;
const emailTwo = `pf.two.${RUN_ID}@example.test`;
const emailThree = `pf.three.${RUN_ID}@example.test`;

let projectId = null;
let deployed = false;

try {
  // ── 1. a folder made at run time, and an agent that builds in it ─────────
  phase("1. A folder made at run time, and the agent builds a Flask app in it");
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFile("README.md", `A folder made at ${new Date().toISOString()} with nothing in it yet.\n`);
  // The branch half of step 3 needs a real repository — worktrees, branches and
  // the base-vs-head comparison all refuse to run outside one — and it has to
  // exist before anybody is looking at the project.
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "an empty folder");

  check("the first person signs up", await signUp(one, emailOne), emailOne);
  await addProject(one.page, PROJECT_DIR);
  projectId = projectIdFor();
  check("the folder is registered as a project", Boolean(projectId), projectId ?? "none");
  if (!projectId) throw new Error("no project");

  if (PHASES.has("1")) {
    check("the first person opens the project", await openProject(one.page));
    const built = await sendAgentMessage(
      one.page,
      [
        "Build a small Flask app with a Jinja HTML front end in this folder. Concretely:",
        "- `app.py` holds the Flask app.",
        "- `templates/index.html` is a Jinja template with a `{{ headline }}` expression in it, rendered by `render_template` from the `/` route.",
        "- The headline is the string `Field notes`.",
        "- Add `@app.route('/healthz')` returning `{'status': 'ok', 'build': BUILD}` where BUILD is read once at import from a file called BUILD next to app.py, defaulting to 'unstamped' when it is missing.",
        "- Do not run the server, do not install anything, and do not ask questions. Write the files and stop.",
      ].join("\n"),
    );
    check("the build prompt goes to the agent", built);

    const deadline = Date.now() + BUILD_TURN_MS;
    let appSource = "";
    let templateSource = "";
    while (Date.now() < deadline) {
      appSource = existsSync(path.join(PROJECT_DIR, "app.py"))
        ? readFileSync(path.join(PROJECT_DIR, "app.py"), "utf8")
        : "";
      templateSource = existsSync(path.join(PROJECT_DIR, "templates", "index.html"))
        ? readFileSync(path.join(PROJECT_DIR, "templates", "index.html"), "utf8")
        : "";
      if (appSource.includes("render_template") && templateSource.length > 0) break;
      await sleep(6_000);
    }

    const trouble = await providerTrouble(one.page);
    check("the turn reached a provider", trouble === null, trouble ?? "");
    check("the agent wrote a Flask app", appSource.includes("Flask("), appSource.slice(0, 90));
    check(
      "it renders a Jinja template rather than a string",
      appSource.includes("render_template"),
      appSource.includes("render_template") ? "" : "no render_template in app.py",
    );
    check(
      "the template is a Jinja template, not static HTML",
      /\{\{\s*headline\s*\}\}/.test(templateSource),
      templateSource.replace(/\s+/g, " ").slice(0, 90),
    );
    check(
      "it serves a health route the deploy can check",
      /healthz/.test(appSource),
      /healthz/.test(appSource) ? "" : "no /healthz",
    );
    // Committed so the branch step later has a base with the app on it.
    tryGit("add", "-A");
    tryGit("commit", "-m", "the agent builds the app");
  } else {
    skip("the agent builds a Flask app with a Jinja front end", "phase 1 not selected");
  }

  // ── 2. publishing, and the pack that does the deploying ─────────────────
  if (PHASES.has("2")) {
    phase("2. Publishing a pack of their own, and deploying with the shipped one");

    // The deployment pack is one of the packs that ship with the product. They
    // live in the file registry the CLI reads and are merged into what the UI
    // shows under a `verified:` id, so this is the same pack the agent finds.
    await goTo(one.page, "/pack/verified:ssh-deploy");
    const identity = one.page.locator('[data-testid="pack-detail-identity"]').first();
    check(
      "the shipped deploy pack has a page in the workspace",
      (await identity.count()) === 1,
      (await bodyText(one.page)).replace(/\s+/g, " ").slice(0, 100),
    );
    const signature = one.page.locator('[data-testid="pack-detail-signature"]').first();
    const signatureState =
      (await signature.count()) === 0 ? "none" : await signature.getAttribute("data-state");
    check(
      "its signature checks out, so the bytes are the publisher's",
      signatureState === "valid",
      signatureState ?? "none",
    );
    // Worth saying plainly rather than reading a tick as a quality tier: the
    // format dropped the verified/unverified status at 2.0 on purpose, and what
    // replaced it is a production record.
    const record = one.page.locator('[data-testid="pack-detail-record-headline"]').first();
    check(
      "and it carries a production record rather than a verified badge",
      (await record.count()) === 1,
      (await record.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 90),
    );
    skip(
      "a pack is marked verified by the registry",
      "no implementation: there is no verified flag on a pack. `verified:` is an id prefix for whatever is installed on this machine's disk (apps/server/src/packs/verifiedPacks.ts), and packs.publish never checks a signature",
    );

    // The same buttons let somebody publish a pack of their own.
    await goTo(one.page, "/");
    const publish = one.page.locator('[data-testid="dashboard-workspace-publish-pack"]').first();
    check("the project row offers to publish a pack of its own", (await publish.count()) >= 1);
    await publish.click();
    await sleep(2_500);
    check(
      "the publish dialog opens",
      (await one.page.locator('[data-testid="publish-pack-dialog"]').count()) === 1,
    );
    await one.page
      .locator('[data-testid="publish-pack-summary"]')
      .fill("Serves a Jinja front end over Flask and keeps it running");
    await one.page
      .locator('[data-testid="publish-pack-handover"]')
      .fill(
        "Built the app and the health route. The health route reads BUILD once at import on purpose, because a stale worker answering for a new deploy is how three deploys reported success while shipping nothing. No TLS and no rollback.",
      );
    await one.page.locator('[data-testid="publish-pack-requirements"]').fill("FLASK_PORT");
    await one.page.locator('[data-testid="publish-pack-confirm"]').click();
    await sleep(12_000);
    const ownPack = /\/pack\/(.+)$/.exec(one.page.url())?.[1] ?? null;
    check("it lands on the new pack's own page", Boolean(ownPack), one.page.url());

    const share = one.page.locator('[data-testid="pack-detail-share-url"]').first();
    const shareUrl = (await share.count()) === 0 ? "" : await share.innerText().catch(() => "");
    check(
      "the published page offers a link to share the pack",
      shareUrl.includes("/pack/"),
      shareUrl.replace(/\s+/g, " ").slice(0, 90),
    );
    check(
      "and there is a button to copy it",
      (await one.page.locator('[data-testid="pack-detail-share-copy"]').count()) === 1,
    );
    // Read honestly: the link is only a link. Following it needs an account on
    // this server, and there is no way for the recipient to take a copy.
    skip(
      "somebody without an account can open a shared pack",
      "no implementation: /pack/$packId sits under the authenticated _chat route, so a shared link redirects a logged-out recipient to sign in",
    );
    skip(
      "a recipient can copy or install a shared pack",
      "no implementation: there is no packs.install, no copy/fork RPC and no CLI for it — the share link only opens a read-only page",
    );

    // Turning the deploy pack on for the project.
    const enabled = await enablePackForProject(one.page, "verified:ssh-deploy");
    check("the deploy pack can be turned on for the project", enabled.ok, enabled.why);
    const listed = await one.page.locator('[data-testid="infra-enablement"]').count();
    check("infrastructure lists it as on", listed >= 1, `${listed} listed`);
    skip(
      "turning the pack on makes the agent use it",
      "no implementation: pack_enablements is a record only. `integration.prompt` is never added to any system prompt — grep shows its only readers are the clipboard button and `t3 pack show` — so a turn after enabling is identical to one before it. This suite therefore hands the pack's prompt over by hand, which is what the product's own copy tells a person to do",
    );

    // The deploy itself, driven by the pack's own words.
    phase("2. The deploy, driven by the pack's own integration prompt");
    check("the first person opens the project", await openProject(one.page));
    const firstBuild = `${RUN_ID}-1`;
    const first = await deployAndWait(
      one.page,
      deployInstruction({ buildId: firstBuild, projectId }),
      firstBuild,
    );
    check("the deploy prompt goes to the agent", first.sent);
    const deployTrouble = await providerTrouble(one.page);
    check("the deploy turn reached a provider", deployTrouble === null, deployTrouble ?? "");
    check(
      "it serves the build it was told to stamp",
      first.result.ok,
      describeDeploy(firstBuild, first),
    );
    deployed = first.result.ok;
    const front = tryBody(`http://127.0.0.1:${PORT}/`);
    check(
      "the Jinja front end is what is being served",
      front.includes("Field notes"),
      front.replace(/\s+/g, " ").slice(0, 90),
    );
    skip(
      "publishing the app puts it anywhere",
      'no implementation: "publish" in this product means publishing a pack to the registry. There is no publish-a-project, no hosted artifact page, and no public route for a deployment — Deployment.url is a string the project supplies',
    );
  } else {
    skip("publishing and deploying", "phase 2 not selected");
  }

  // ── 3. a second person changes it, redeploys, branches and merges ───────
  if (PHASES.has("3")) {
    phase("3. A second person changes it and updates the deployment");
    check("the second person signs up", await signUp(two, emailTwo), emailTwo);
    const invite = await inviteWhenReady(one.page, emailTwo);
    check("the first person invites them", Boolean(invite), invite ?? "no invite link");
    if (invite) {
      const accepted = await acceptInvite(two, invite);
      check("the second person accepts", accepted.accepted, accepted.seen.slice(0, 90));
    }

    check("the second person opens the project", await openProject(two.page));
    const edited = await editFileViaUi(two.page, {
      directory: "templates",
      file: "index.html",
      contents: [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        "    <title>{{ headline }}</title>",
        "  </head>",
        "  <body>",
        '    <h1 id="headline">{{ headline }}</h1>',
        "    <p>Revised by the second person.</p>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    });
    check("they change the front end from the editor", edited.ok, edited.why);

    if (deployed) {
      const secondBuild = `${RUN_ID}-2`;
      const second = await deployAndWait(
        two.page,
        deployInstruction({ buildId: secondBuild, projectId }),
        secondBuild,
      );
      check("they ask for the deployment to be updated", second.sent);
      const trouble = await providerTrouble(two.page);
      check("their turn reached a provider", trouble === null, trouble ?? "");
      check(
        "the update is the build now serving",
        second.result.ok,
        describeDeploy(secondBuild, second),
      );
      const served = tryBody(`http://127.0.0.1:${PORT}/`);
      check(
        "what it serves carries their change",
        served.includes("Revised by the second person"),
        served.replace(/\s+/g, " ").slice(0, 90),
      );
    } else {
      skip("the deployment is updated", "nothing was deployed in phase 2 to update");
    }

    phase("3. They take a branch, change it, and merge it back");
    // Personal branches are a workspace mode the lead sets; the offer to take
    // one only reaches the second person once it is on.
    check(
      "the lead moves the workspace onto personal branches",
      await setApprovalMode(one.page, "Own branch"),
    );
    check(
      "the second person is offered a branch",
      await waitForCollabElement(two.page, "collaboration-branch-offer"),
    );
    const create = two.page.locator('[data-testid="collaboration-branch-create"]').first();
    const offered = (await create.count()) > 0;
    if (offered) {
      await create.click();
      await sleep(8_000);
    }
    const branches = offered ? git("branch", "--list") : "";
    check("the branch exists in git", /collab\//.test(branches), branches.replace(/\s+/g, " "));

    const branchName = (git("branch", "--list", "collab/*").match(/collab\/\S+/) ?? [null])[0];
    let worktree = null;
    if (branchName) {
      const line = git("worktree", "list")
        .split("\n")
        .find((entry) => entry.includes(branchName.replace("collab/", "")));
      worktree = line ? line.split(/\s+/)[0] : null;
    }
    check("it is checked out in a worktree of its own", worktree !== null, branchName ?? "none");

    if (worktree) {
      // A file nobody else touched, so the merge has something to carry and
      // git has nothing to be confused about. A contested merge is already
      // covered by collab-e2e; what is untested is a merge that succeeds.
      execFileSync("python3", [
        "-c",
        "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])",
        path.join(worktree, "NOTES-FROM-THE-BRANCH.md"),
        `Written on ${branchName} during run ${RUN_ID}.\n`,
      ]);
      execFileSync("git", ["add", "-A"], { cwd: worktree });
      execFileSync("git", ["commit", "-m", "a change on the branch"], {
        cwd: worktree,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Packs Flow",
          GIT_AUTHOR_EMAIL: "packs@example.test",
          GIT_COMMITTER_NAME: "Packs Flow",
          GIT_COMMITTER_EMAIL: "packs@example.test",
        },
      });
      check("they commit a change on their branch", true, branchName ?? "");

      // The comparison has to catch up before the merge button stops being
      // disabled for having nothing to merge.
      check(
        "their branch is compared with the base it was cut from",
        await waitForCollabElement(two.page, "collaboration-branch-compare", 40_000),
        "",
      );
      await sleep(6_000);
      await openCollabPanel(two.page);
      const merge = two.page.locator('[data-testid="collaboration-merge-branch"]').first();
      const canMerge = (await merge.count()) > 0 && !(await merge.isDisabled().catch(() => true));
      check(
        "they can merge it back from the same panel",
        canMerge,
        canMerge ? "" : "the merge button is absent or still disabled",
      );
      if (canMerge) {
        await merge.click();
        await sleep(12_000);
        const outcome = two.page.locator('[data-testid="collaboration-merge-outcome"]').first();
        const status =
          (await outcome.count()) === 0 ? "none" : await outcome.getAttribute("data-status");
        check("the merge completes rather than conflicting", status === "completed", status ?? "none");
        const onMain = tryGit("show", "main:NOTES-FROM-THE-BRANCH.md");
        check(
          "the branch's change is on main afterwards",
          onMain.includes(RUN_ID),
          onMain.slice(0, 60) || "main has no such file",
        );
      }
      await closeCollabPanel(two.page);
    }
  } else {
    skip("the second person's update, branch and merge", "phase 3 not selected");
  }

  // ── 4. a third person prompts in chat ───────────────────────────────────
  if (PHASES.has("4")) {
    phase("4. A third person prompts in chat, and their change is what is served");
    check("the third person signs up", await signUp(three, emailThree), emailThree);
    const invite = await inviteWhenReady(one.page, emailThree);
    check("they are invited", Boolean(invite), invite ?? "no invite link");
    if (invite) {
      const accepted = await acceptInvite(three, invite);
      check("they accept", accepted.accepted, accepted.seen.slice(0, 90));
    }
    // Back off personal branches, or the third person is asked to take one
    // before they can do anything and the deploy runs in a worktree rather
    // than in the project everything else is reading.
    await setApprovalMode(one.page, "Open");
    await sleep(4_000);

    check("the third person opens the project", await openProject(three.page));
    if (deployed) {
      const thirdBuild = `${RUN_ID}-3`;
      const third = await deployAndWait(
        three.page,
        deployInstruction({
          buildId: thirdBuild,
          projectId,
          extra: [
            "- First change the headline the template renders from `Field notes` to `Field notes from three people`, in whichever file supplies it.",
          ],
        }),
        thirdBuild,
      );
      check("their prompt goes to the agent", third.sent);
      const trouble = await providerTrouble(three.page);
      check("their turn reached a provider", trouble === null, trouble ?? "");
      check(
        "the redeploy they asked for is what is serving",
        third.result.ok,
        describeDeploy(thirdBuild, third),
      );
      const served = tryBody(`http://127.0.0.1:${PORT}/`);
      check(
        "all three people's changes are in what is served",
        served.includes("Field notes from three people") &&
          served.includes("Revised by the second person"),
        served.replace(/\s+/g, " ").slice(0, 110),
      );
    } else {
      skip("the third person's change reaches the deployment", "nothing was deployed to change");
    }
  } else {
    skip("the third person's prompt", "phase 4 not selected");
  }

  // ── 5. the analytics pack, and metrics agreed in conversation ───────────
  if (PHASES.has("5")) {
    phase("5. The analytics pack, turned on and then talked about");

    await goTo(one.page, "/pack/verified:analytics-core");
    const analyticsIdentity = one.page.locator('[data-testid="pack-detail-identity"]').first();
    check(
      "the shipped analytics pack has a page too",
      (await analyticsIdentity.count()) === 1,
      (await bodyText(one.page)).replace(/\s+/g, " ").slice(0, 90),
    );
    const enabled = await enablePackForProject(one.page, "verified:analytics-core");
    check("it can be turned on for the project", enabled.ok, enabled.why);

    const infraAfterEnable = await readInfraTab(one.page, projectId, { waitForLoadMs: 1 });
    check(
      "the infrastructure page lists both packs",
      infraAfterEnable.enablements >= 2,
      `${infraAfterEnable.enablements} listed`,
    );
    // The user's flow has this happening on the infrastructure page. It cannot.
    skip(
      "an analytics pack is turned on from the infrastructure page",
      "no implementation: InfraPage only lists enablements and offers 'Turn off'. The only enable surfaces are the pack's own page and the composer quick view",
    );
    skip(
      "turning the analytics pack on declares a stream or wires anything",
      "no implementation: apps/server/src/packEnablement/ contains no reference to analytics. Enabling writes a pack_enablements row and adds a list item, nothing else — the page's own copy says it installs and sets up nothing",
    );

    if (!deployed) {
      skip("the metrics conversation", "nothing is live to report anything");
    } else {
      phase("5. What the product proposes, and what the person asks for instead");
      await goTo(one.page, `/analytics/${projectId}`);
      const rows = one.page.locator('[data-testid="analytics-deployment"]');
      check(
        "the analytics page knows what the project has live",
        (await rows.count()) >= 1,
        `${await rows.count()} live`,
      );
      const offer = one.page.locator('[data-testid="analytics-enable-deployment"]').first();
      check("it offers to make that deployment report", (await offer.count()) >= 1);
      await offer.click();
      await sleep(9_000);

      const composer = one.page.locator('[data-testid="composer-editor"], textarea').first();
      const proposed =
        (await composer.count()) === 0 ? "" : ((await composer.innerText().catch(() => "")) ?? "");
      check(
        "clicking it writes a prompt into the composer to read before sending",
        /Report a `[^`]+` stream/.test(proposed),
        proposed.replace(/\s+/g, " ").slice(0, 110),
      );
      // The proposal is generic by construction: three hardcoded property sets
      // in packages/shared/src/analyticsStreamTemplates.ts, chosen by whether
      // the thing has an address. Nothing about it is about this artefact.
      check(
        "the proposal it writes is the generic request shape, not one for this artefact",
        /path \(string\)/.test(proposed) && /duration_ms \(number\)/.test(proposed),
        proposed.replace(/\s+/g, " ").slice(0, 140),
      );
      check(
        "and it invites the person to say the proposal is wrong",
        /proposed properties are wrong/.test(proposed),
      );

      // The conversation the flow describes: the person wants metrics for what
      // this artefact is, not paths and status codes. The agent has to register
      // the events, build the endpoint that feeds them, and wire the deploy.
      const stream = "reader.progress";
      const addendum = [
        "",
        "Those proposed properties are wrong for this. Paths and status codes say nothing about a page somebody reads.",
        `Declare \`${stream}\` instead, with exactly these properties: \`section\` (string, required) — the section of the page the reader reached — and \`dwell_ms\` (number) — how long they lingered there.`,
        "Then:",
        "- Add a `POST /track` route to app.py taking JSON `{section, dwell_ms}` and reporting one event with those two properties. Reporting must never be able to break serving: wrap the post so a failure is swallowed and the route still answers 200.",
        "- Post to $T3_ANALYTICS_URL with a body of {projectId, stream, ingestKey, properties}, reading T3_ANALYTICS_URL, T3_PROJECT_ID, T3_STREAM and T3_ANALYTICS_INGEST_KEY from the environment. Never write the key into a file.",
        "- Keep every existing route working.",
        "Then redeploy, following the deploy instructions below exactly.",
        "",
        deployInstruction({
          buildId: `${RUN_ID}-4`,
          projectId,
          analytics: {
            stream,
            projectId,
            purpose: "How far a reader got and where they lingered",
            properties: "section:string:required,dwell_ms:number",
          },
        }),
      ].join("\n");

      const fourthBuild = `${RUN_ID}-4`;
      const sent = await sendAgentMessage(one.page, `${proposed}\n${addendum}`);
      check("the conversation goes back to the agent", sent);
      let wired = await waitForBuild(fourthBuild);
      if (!wired.ok) {
        await sendAgentMessage(
          one.page,
          `http://127.0.0.1:${PORT}/healthz is still not serving build ${fourthBuild}. Finish it in this turn: add the /track route, then \`t3 deploy run\` with --analytics-stream ${stream} and the properties you were given.`,
        );
        wired = await waitForBuild(fourthBuild);
      }
      check("the reporting build is the one serving", wired.ok, wired.seen.slice(0, 110));

      phase("5. A stream nobody wrote down in advance");
      const declared = streamsFor(projectId);
      check(
        "the agent registered the stream the conversation agreed",
        declared.includes(stream),
        declared.replace(/\n/g, " | ").slice(0, 130),
      );
      check(
        "with the properties the conversation agreed, not the proposed ones",
        declared.includes("section") && declared.includes("dwell_ms"),
        declared.replace(/\n/g, " | ").slice(0, 130),
      );

      // Traffic through the endpoint the agent built, which is the half of
      // "custom endpoints" that does exist: code in the deployed app.
      const visits = [
        { section: "intro", dwell_ms: 1200 },
        { section: "method", dwell_ms: 8400 },
        { section: "method", dwell_ms: 9100 },
        { section: "method", dwell_ms: 7700 },
        { section: "closing", dwell_ms: 900 },
      ];
      let accepted = 0;
      for (const visit of visits) {
        const answer = sh(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST http://127.0.0.1:${PORT}/track -H 'content-type: application/json' -d ${JSON.stringify(JSON.stringify(visit))} || true`,
        );
        if (answer === "200") accepted += 1;
      }
      check(
        "the endpoint the agent built answers every report",
        accepted === visits.length,
        `${accepted}/${visits.length}`,
      );
      await sleep(4_000);

      const counted = t3([
        "analytics",
        "query",
        "--project",
        projectId,
        "--stream",
        stream,
        "--aggregate",
        "count",
        "--group-by",
        "section",
      ]);
      check(
        "the workspace counted them under the agent's own property",
        /method\s+3/.test(counted),
        counted.replace(/\n/g, " | ").slice(0, 120),
      );

      phase("5. The chart, drawn from a declaration made during the conversation");
      await goTo(one.page, `/analytics/${projectId}`);
      const choices = one.page.locator('[data-testid="analytics-stream-choice"]');
      const names = await choices.allInnerTexts();
      check(
        "the Analytics tab lists the agent's stream",
        names.some((name) => name.includes(stream)),
        names.join(" | ").slice(0, 100),
      );
      const choice = choices.filter({ hasText: stream }).first();
      if ((await choice.count()) > 0) {
        await choice.click();
        await sleep(4_000);
      }
      const groups = await one.page.locator('[data-testid="analytics-group"]').allInnerTexts();
      check(
        "the chart controls offer the property the agent invented",
        groups.some((label) => label.includes("section")),
        groups.join(" | ").slice(0, 100),
      );
      const aggregates = await one.page
        .locator('[data-testid="analytics-aggregate"]')
        .allInnerTexts();
      check(
        "and the aggregates its numeric property makes answerable",
        aggregates.some((label) => /avg/i.test(label)),
        aggregates.join(" | ").slice(0, 100),
      );
      const group = one.page
        .locator('[data-testid="analytics-group"]')
        .filter({ hasText: "section" })
        .first();
      if ((await group.count()) > 0) {
        await group.click();
        await sleep(5_000);
      }
      const bars = await one.page
        .locator('[data-testid="analytics-bar"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-label")));
      check(
        "a chart is drawn from data that did not exist when the run started",
        bars.includes("method") && bars.includes("intro"),
        bars.join(" | ").slice(0, 100),
      );

      // What the flow asks for beyond this, and what is actually there.
      skip(
        "the agent generates its own chart or dashboard template",
        "no implementation: there is no chart, template, widget or view concept at any layer. PackAnalyticsMetric in packages/contracts/src/pack.ts:1717 is the only chart schema in the repo and nothing reads it. The Analytics page draws one thing — CSS bar divs whose group-by and aggregate come from the stream declaration",
      );
      skip(
        "the agent generates analytics endpoints in the product",
        "partially, and not in the product: the agent wrote a /track route into the deployed app, which is the check above. The product has exactly one analytics route, POST /api/analytics/events, and nothing creates routes per stream or per deployment",
      );
      skip(
        "the charts are per artefact, e.g. reader depth for a PDF",
        "no implementation: analyticsStreamTemplates.ts proposes from three hardcoded property sets chosen by whether the thing has an address. Nothing inspects the artefact. A person can talk the agent into any properties they like — the check above does exactly that — but the proposal never will",
      );
      skip(
        "a chart can be narrowed to a time range",
        "no implementation: since/until/limit exist in the analytics.query contract and the Analytics page never sends them; the CLI has no flags for them either",
      );

      const infra = await readInfraTab(one.page, projectId);
      check(
        "the Infrastructure tab shows the load it is now carrying",
        infra.events.some((value) => Number(value) >= visits.length),
        infra.loads.join(" | ").slice(0, 120),
      );
    }
  } else {
    skip("the analytics pack", "phase 5 not selected");
  }

  // ── 6. deploying something that is not a Flask app ──────────────────────
  if (PHASES.has("6")) {
    phase("6. Deploying something that is not a Flask app");
    if (!deployed) {
      skip("a document put live", "nothing was deployed to add it to");
    } else {
      const fifthBuild = `${RUN_ID}-5`;
      const doc = await deployAndWait(
        three.page,
        deployInstruction({
          buildId: fifthBuild,
          projectId,
          extra: [
            "- First make the project's document live: write `build_doc.py`, which renders a four page PDF to `doc.pdf` using reportlab, and serve that file from `/doc.pdf` with mimetype application/pdf via send_file. Run `build_doc.py` before you ship so the file exists.",
            "- The pages are titled Cover, Method, Findings and What is left.",
          ],
        }),
        fifthBuild,
      );
      check("the request to put a document live goes to the agent", doc.sent);
      const trouble = await providerTrouble(three.page);
      check("that turn reached a provider", trouble === null, trouble ?? "");
      check("the redeploy is what is serving", doc.result.ok, describeDeploy(fifthBuild, doc));
      const headers = tryHeaders(`http://127.0.0.1:${PORT}/doc.pdf`);
      check(
        "a single document is live at its own address",
        /application\/pdf/i.test(headers),
        headers.replace(/\s+/g, " ").slice(0, 110),
      );
      const bytes = tryBody(`http://127.0.0.1:${PORT}/doc.pdf`);
      check(
        "and it is a real PDF rather than an error page",
        bytes.startsWith("%PDF"),
        bytes.slice(0, 40),
      );
      // The deployment directory is one thing, so the analytics page now has a
      // document and a web page behind one address. Worth saying that this is
      // the only shape available.
      skip(
        "the document gets an address of its own, separate from the app",
        "no implementation: a Deployment is one target with one url. Putting a document live means adding a route to something already deployed, which is what the check above did",
      );
    }
    skip(
      "a TUI is deployed to the web after the agent proposes a front end",
      "already covered end to end by scripts/tui-deploy-e2e.mjs, which hands the agent a terminal program and checks it raises the front-end problem before writing a deploy command rather than shipping something nobody can reach",
    );
  } else {
    skip("deploying something that is not a Flask app", "phase 6 not selected");
  }

  phase("Result");
  console.log(`  workspace: ${PROJECT_DIR}`);
  console.log(`  serving:   http://127.0.0.1:${PORT}/`);
} catch (error) {
  check("the run completed", false, String(error).slice(0, 200));
} finally {
  sh(
    `([ -f ${JSON.stringify(path.join(PROJECT_DIR, "app.pid"))} ] && kill "$(cat ${JSON.stringify(path.join(PROJECT_DIR, "app.pid"))})" 2>/dev/null) || true`,
  );
  sh(`pkill -f "b 127.0.0.1:${PORT}" 2>/dev/null || true`);
  await browser.close().catch(() => undefined);
  if (!KEEP) {
    // A worktree left behind keeps the directory alive under a different name.
    sh(`git -C ${JSON.stringify(PROJECT_DIR)} worktree prune 2>/dev/null || true`);
    rmSync(PROJECT_DIR, { recursive: true, force: true });
    unlistProject(PROJECT_DIR);
  }
}

process.exit(finish());
