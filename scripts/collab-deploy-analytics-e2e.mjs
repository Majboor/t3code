#!/usr/bin/env node
// Six people, three things, three ways of putting them live.
//
//   bun run dev                     # in another terminal
//   bun run test:collab-deploy
//
// Three artifacts — a PDF, an HTML page and a React app — each owned by one
// account and edited by a second, so six accounts. Each one goes out by a
// different route, because the pack claims all three work and only one of them
// was ever exercised end to end:
//
//   pdf    -> local        the start command runs here, bound to loopback
//   html   -> tunnel       started here, published by a cloudflare quick tunnel
//   react  -> ssh          shipped to the deployment node and started there
//
// The deploys are driven by prompting the agent with the ssh-deploy pack's own
// integration prompt, not by calling the CLI: the pack exists to be handed to an
// agent, so a suite that calls the CLI directly tests everything except the part
// that is supposed to work.
//
// Per artifact: the owner deploys it, the collaborator changes it and deploys
// again, the owner then wires analytics, mock traffic is sent, and the run reads
// the Analytics and Infrastructure tabs the way a person would.
//
//   T3_E2E_BASE_URL        the web app          (default http://localhost:5733)
//   T3_ANALYTICS_URL       the ingest route     (default http://127.0.0.1:13773/api/analytics/events)
//   T3_DEPLOY_SSH_HOST     the node             (default 164.68.117.31)
//   T3_E2E_ONLY            run one artifact     (pdf | html | react)
//   T3_E2E_KEEP_WORKSPACE  keep the directories
//
// Needs a configured provider, since every deploy here is a real agent turn.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
const SSH_HOST = process.env["T3_DEPLOY_SSH_HOST"] ?? "164.68.117.31";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const ROOT_DIR = existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir();
const BASE_DIR = path.join(os.homedir(), ".t3");
const PASSWORD = "CollabDeploy!2026";
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";
const ONLY = process.env["T3_E2E_ONLY"] ?? "";
// A real deploy turn — read the project, build, register the target, run it,
// verify — took 5m44s on a loaded machine and was failed by a five minute
// budget that expired sixteen seconds early, on a deploy that then completed
// and served exactly the build it was asked for. The budget only costs
// anything when a deploy is genuinely broken: the wait polls and returns the
// moment the right build id appears.
const AGENT_TURN_MS = 600_000;

const reporter = createReporter();
const { phase, check, skip, finish } = reporter;

const harness = createHarness({ baseUrl: BASE_URL, password: PASSWORD, probeFile: "app.py" });
const { signUp, addProject, openProject, sendAgentMessage, createInvite, acceptInvite } = harness;

const CLI_ENTRY = path.join(REPO, "apps", "server", "src", "bin.ts");

function t3(args) {
  return execFileSync("node", [CLI_ENTRY, ...args, "--base-dir", BASE_DIR, "--dev-url", BASE_URL], {
    encoding: "utf8",
    timeout: 180_000,
  }).trim();
}

function writeFile(dir, relativePath, contents) {
  execFileSync("python3", [
    "-c",
    [
      "import pathlib, sys",
      "target = pathlib.Path(sys.argv[1])",
      "target.parent.mkdir(parents=True, exist_ok=True)",
      "target.write_text(sys.argv[2])",
    ].join("\n"),
    path.join(dir, relativePath),
    contents,
  ]);
}

/** The project row the app created for a directory, which is the id everything else takes. */
function projectIdFor(dir) {
  const database = path.join(BASE_DIR, "dev", "state.sqlite");
  if (!existsSync(database)) return null;
  return (
    execFileSync("sqlite3", [
      database,
      `select project_id from projection_projects where workspace_root = '${dir.replaceAll("'", "''")}' and deleted_at is null limit 1;`,
    ])
      .toString()
      .trim() || null
  );
}

/** The pack's own words, from this repository rather than whatever was published. */
function deployPrompt() {
  return JSON.parse(readFileSync(path.join(REPO, "packs", "ssh-deploy", "pack.json"), "utf8"))
    .integration.prompt;
}

function sh(command, options = {}) {
  return execFileSync("bash", ["-c", command], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    ...options,
  }).trim();
}

/** Never throws: a curl against something that is not listening is a result. */
function tryStatus(url) {
  try {
    return sh(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 ${JSON.stringify(url)} || true`,
    );
  } catch {
    return "000";
  }
}

function tryBody(url) {
  try {
    return sh(`curl -s --max-time 20 ${JSON.stringify(url)} || true`);
  } catch {
    return "";
  }
}

const PYTHON = sh("python3 -c 'import sys; print(sys.executable)'");

// ── the three things being deployed ─────────────────────────────────────────
//
// Each writes an app that serves a build id from /healthz — the only way to
// tell a redeploy from the previous deployment still answering — and a /visit
// route that reports to analytics once a key is wired in.

const PDF_PAGES = ["Cover", "Why it broke", "What we changed", "What is left"];

function reportingHelper() {
  return [
    "import json",
    "import os",
    "import urllib.error",
    "import urllib.request",
    "",
    "ANALYTICS_URL = os.environ.get('T3_ANALYTICS_URL', '')",
    "PROJECT_ID = os.environ.get('T3_PROJECT_ID', '')",
    "STREAM = os.environ.get('T3_STREAM', '')",
    "# Minted by the deploy and injected into this process. Never written down:",
    "# a key in a file is a key anyone who reads the repository can post with.",
    "INGEST_KEY = os.environ.get('T3_ANALYTICS_INGEST_KEY', '')",
    "",
    "",
    "def report(properties):",
    '    """Reporting must never be able to break serving."""',
    "    if not (ANALYTICS_URL and INGEST_KEY):",
    "        # Distinguished from a rejection: nothing was wired in at all.",
    "        return 0",
    "    body = json.dumps({",
    "        'projectId': PROJECT_ID,",
    "        'stream': STREAM,",
    "        'ingestKey': INGEST_KEY,",
    "        'properties': properties,",
    "    }).encode()",
    "    request = urllib.request.Request(",
    "        ANALYTICS_URL, data=body, headers={'content-type': 'application/json'}",
    "    )",
    "    try:",
    "        with urllib.request.urlopen(request, timeout=10) as response:",
    "            return response.status",
    "    except urllib.error.HTTPError as rejected:",
    "        # The status is the whole diagnosis and collapsing it to 0 cost real",
    "        # debugging time: 403 is a key minted for a different stream than",
    "        # T3_STREAM names, 422 is an event that does not match the",
    "        # declaration. Both look identical to a caller that only sees 0.",
    "        return rejected.code",
    "    except Exception:",
    "        return -1",
    "",
  ].join("\n");
}

/** Turns what `report` returned into the reason the deploy is wrong. */
function explainReport(status) {
  switch (status) {
    case "0":
      return "0 (no key in the process: the deploy did not pass --analytics-stream)";
    case "403":
      // The route will not say which of the three was wrong, so name all of
      // them rather than guess: the second reading is the one that was true
      // when a reissued key was handed out but its digest never stored.
      return "403 (refused: no such stream on this project, or a key the stream no longer answers to, or one minted for a different stream than T3_STREAM names)";
    case "422":
      return "422 (the event does not match the stream declaration)";
    case "-1":
      return "-1 (the ingest route was unreachable from the deployment)";
    default:
      return status;
  }
}

function buildPdfArtifact(dir) {
  writeFile(
    dir,
    "build_pdf.py",
    [
      "import pathlib",
      "",
      "from reportlab.lib.pagesizes import A4",
      "from reportlab.pdfgen import canvas",
      "",
      `PAGES = ${JSON.stringify(PDF_PAGES)}`,
      "",
      "",
      "def build(target: pathlib.Path) -> None:",
      "    pdf = canvas.Canvas(str(target), pagesize=A4)",
      "    for number, title in enumerate(PAGES, start=1):",
      "        pdf.setFont('Helvetica-Bold', 24)",
      "        pdf.drawString(72, 720, title)",
      "        pdf.setFont('Helvetica', 12)",
      "        pdf.drawString(72, 690, f'Page {number} of {len(PAGES)}')",
      "        pdf.showPage()",
      "    pdf.save()",
      "",
      "",
      "if __name__ == '__main__':",
      "    build(pathlib.Path(__file__).with_name('doc.pdf'))",
      "",
    ].join("\n"),
  );
  writeFile(
    dir,
    "app.py",
    [
      "import pathlib",
      "",
      "from flask import Flask, send_file",
      "",
      "import build_pdf",
      "from reporting import report",
      "",
      "app = Flask(__name__)",
      "HERE = pathlib.Path(__file__).parent",
      "# Read once, on purpose: see /healthz below.",
      "BUILD = (HERE / 'BUILD').read_text().strip() if (HERE / 'BUILD').exists() else 'unstamped'",
      "",
      "",
      "@app.route('/doc.pdf')",
      "def document():",
      "    return send_file(HERE / 'doc.pdf', mimetype='application/pdf')",
      "",
      "",
      "@app.route('/visit/<path:where>')",
      "def visit(where):",
      "    return {'reported': report({'path': '/' + where, 'seconds': 1})}, 200",
      "",
      "",
      "@app.route('/healthz')",
      "def healthz():",
      "    # The titles are echoed because a PDF's text is compressed inside the",
      "    # file: checking a redeploy shipped an edit cannot be done by grepping",
      "    # the bytes, so the service says what it rendered.",
      "    return {'status': 'ok', 'build': BUILD, 'pages': build_pdf.PAGES}, 200",
      "",
    ].join("\n"),
  );
  writeFile(dir, "reporting.py", reportingHelper());
}

function buildHtmlArtifact(dir) {
  writeFile(
    dir,
    "templates/index.html",
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      "    <title>Release notes</title>",
      "  </head>",
      "  <body>",
      '    <h1 id="headline">Release notes</h1>',
      "    <p>What changed, and why it took so long.</p>",
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  writeFile(
    dir,
    "app.py",
    [
      "import pathlib",
      "",
      "from flask import Flask, render_template",
      "",
      "from reporting import report",
      "",
      "app = Flask(__name__)",
      "HERE = pathlib.Path(__file__).parent",
      "# Read once, on purpose: see /healthz below.",
      "BUILD = (HERE / 'BUILD').read_text().strip() if (HERE / 'BUILD').exists() else 'unstamped'",
      "",
      "",
      "@app.route('/')",
      "def index():",
      "    return render_template('index.html')",
      "",
      "",
      "@app.route('/visit/<path:where>')",
      "def visit(where):",
      "    return {'reported': report({'path': '/' + where, 'seconds': 1})}, 200",
      "",
      "",
      "@app.route('/healthz')",
      "def healthz():",
      "    return {'status': 'ok', 'build': BUILD}, 200",
      "",
    ].join("\n"),
  );
  writeFile(dir, "reporting.py", reportingHelper());
}

function buildReactArtifact(dir) {
  writeFile(
    dir,
    "src/App.jsx",
    [
      "import { useState } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "",
      "export function App() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <main>",
      '      <h1 id="headline">Deploy dashboard</h1>',
      "      <button onClick={() => setCount(count + 1)}>clicked {count} times</button>",
      "    </main>",
      "  );",
      "}",
      "",
      "createRoot(document.getElementById('root')).render(<App />);",
      "",
    ].join("\n"),
  );
  writeFile(
    dir,
    "templates/index.html",
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      "    <title>Deploy dashboard</title>",
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      '    <script src="/static/bundle.js"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  writeFile(
    dir,
    "app.py",
    [
      "import pathlib",
      "",
      "from flask import Flask, render_template",
      "",
      "from reporting import report",
      "",
      "app = Flask(__name__)",
      "HERE = pathlib.Path(__file__).parent",
      "# Read once, on purpose: see /healthz below.",
      "BUILD = (HERE / 'BUILD').read_text().strip() if (HERE / 'BUILD').exists() else 'unstamped'",
      "",
      "",
      "@app.route('/')",
      "def index():",
      "    return render_template('index.html')",
      "",
      "",
      "@app.route('/visit/<path:where>')",
      "def visit(where):",
      "    return {'reported': report({'path': '/' + where, 'seconds': 1})}, 200",
      "",
      "",
      "@app.route('/healthz')",
      "def healthz():",
      "    return {'status': 'ok', 'build': BUILD}, 200",
      "",
    ].join("\n"),
  );
  writeFile(dir, "reporting.py", reportingHelper());
  // Bundled with the repository's own react, so the deploy needs no network and
  // the thing shipped to the node is a real build rather than a CDN script tag.
  //
  // The workspace lives outside the repository, so bun resolves nothing from
  // it by default: without this link `bun build` fails with `Could not resolve:
  // "react"` and the agent never gets as far as deploying anything. Linked
  // rather than installed because the point is to need no network.
  const modules = path.join(dir, "node_modules");
  if (!existsSync(modules)) {
    symlinkSync(path.join(REPO, "apps", "web", "node_modules"), modules, "dir");
  }
  writeFile(
    dir,
    "build.sh",
    `#!/bin/sh\nset -e\nbun build src/App.jsx --outfile static/bundle.js --minify\n`,
  );
}

const ARTIFACTS = [
  {
    kind: "pdf",
    mode: "local",
    label: "a PDF, deployed locally",
    stream: "pdf.page_read",
    build: buildPdfArtifact,
    /** Proves the collaborator's edit is what is being served. */
    edit: { file: "build_pdf.py", find: "What is left", replace: "What the collaborator changed" },
    marker: "What the collaborator changed",
    markerRoute: "/healthz",
  },
  {
    kind: "html",
    mode: "tunnel",
    label: "an HTML page, published by a cloudflare tunnel",
    stream: "page.view",
    build: buildHtmlArtifact,
    edit: {
      file: "templates/index.html",
      find: "Release notes",
      replace: "Release notes, revised",
    },
    marker: "Release notes, revised",
    markerRoute: "/",
  },
  {
    kind: "react",
    mode: "ssh",
    label: "a React app, shipped to the node over SSH",
    stream: "app.view",
    build: buildReactArtifact,
    edit: { file: "src/App.jsx", find: "Deploy dashboard", replace: "Deploy dashboard, revised" },
    marker: "Deploy dashboard, revised",
    markerRoute: "/static/bundle.js",
  },
];

// ── driving a deploy through the agent ──────────────────────────────────────

/**
 * Hands over the pack's prompt plus the facts this particular deploy needs.
 *
 * The facts are supplied rather than left to be discovered because the point
 * under test is whether the pack's instructions produce a working deployment,
 * not whether an agent can guess a port.
 */
function deployInstruction({ artifact, dir, port, buildId, projectId, analytics }) {
  const lines = [
    deployPrompt(),
    "",
    `Do that for the project in ${dir}. Concretely:`,
    `- The target is \`${artifact.mode === "ssh" ? "ssh" : "local"}\`.`,
    `- The project id is ${projectId}.`,
    `- Write the build id ${buildId} into a file called BUILD before you ship, and serve it from /healthz.`,
    `- Bind 127.0.0.1:${port}.`,
    `- The start command must, in this order: stamp BUILD, stop whatever the last deploy left on the port (kill the pid in app.pid if it is there), start ${JSON.stringify(PYTHON)} -m gunicorn -w 2 -b 127.0.0.1:${port} app:app detached with nohup, and write the new pid to app.pid.`,
    "- /healthz reads BUILD once at import, so a stale process from the last deploy cannot answer for the new one. If the port is still held the new build will simply never appear, which is the point.",
    // An agent that tries the server by hand and leaves it running is holding
    // the port its own deploy needs; the deploy is then the thing that fails.
    `- Nothing may be left on ${port} when the deploy runs, including anything you started yourself to test. Stop it first.`,
    "- Make the start command's failures readable: `gunicorn --daemon` detaches its stdio, so a bind failure lands nowhere and the run exits non-zero with an empty log. Pass `--error-logfile app.err` (or do not use `--daemon`) so there is something to read.",
    // Step 7 of the pack's own prompt. Restated because it is the step that
    // decides whether any of this is visible to the project afterwards.
    // The target name is a supplied fact for the same reason the port is. Left
    // to choose, an agent with no memory of the last deploy names it afresh
    // ("local", then "local-analytics"), and a deployment is identified by its
    // name: the redeploy becomes a rival reporting to the same stream, and is
    // refused for taking numbers away from what is really its own past self.
    `- Run it through T3 so it is recorded, not by hand: register the target with \`t3 deploy add\`, naming it exactly \`${artifact.kind}-${port}\`, and then \`t3 deploy run <targetId> --url http://127.0.0.1:${port}\`.`,
    `- Use that name every time. Registering \`${artifact.kind}-${port}\` again re-registers the same target, so a redeploy replaces what is there rather than standing up a second one beside it.`,
  ];
  if (artifact.kind === "pdf") {
    lines.push(`- Build the document first: ${JSON.stringify(PYTHON)} build_pdf.py`);
  }
  if (artifact.kind === "react") {
    lines.push(
      "- Build the front end first: sh build.sh — it bundles `static/bundle.js`, which is the thing that actually gets served.",
      // A link to the repo's modules, so bun can resolve react without a
      // network. It means nothing on the far side and is 400MB if followed.
      "- `node_modules` is a symlink used only by that build. Do not ship it: add `--exclude='node_modules'` to the rsync, and never follow symlinks (`-aL`) when copying.",
    );
  }
  if (artifact.mode === "ssh") {
    lines.push(
      `- Ship it to ${SSH_HOST} as root, into /srv/t3-pack-${path.basename(dir)}.`,
      "- Read the SSH password from the server secret store secret named `logicpacks-node-root`.",
    );
  }
  if (artifact.mode === "tunnel") {
    lines.push(
      // `cloudflared tunnel --url` never exits. Run in the foreground it holds
      // the turn open until something kills it, which ends the deploy with the
      // app on loopback and no address to report — exactly what happened.
      "- Once it is listening, publish it with a cloudflare quick tunnel, detached, and read the address back out of its log:",
      `    nohup cloudflared tunnel --url http://127.0.0.1:${port} > tunnel.log 2>&1 &`,
      "  then poll `tunnel.log` until the `https://….trycloudflare.com` line appears. Do not run it in the foreground: it does not exit.",
      "  Tell me that address in your reply, and pass it to `t3 deploy run --url` instead of the loopback one.",
    );
  }
  if (analytics) {
    lines.push(
      `- The deployment must report to analytics on the stream \`${analytics.stream}\`, which is already declared.`,
      `  Use that exact name. Do not declare a stream of your own: the key is minted for one stream, and a key minted for a name other than the \`T3_STREAM\` below is refused with a 403 on every event, which looks from the outside like reporting silently doing nothing.`,
      `  Let the deploy wire the key: add \`--analytics-stream ${analytics.stream}\` to \`t3 deploy run\`, which injects it as T3_ANALYTICS_INGEST_KEY.`,
      "  The other three are not secret, so set them in the target's start command itself:",
      `    T3_ANALYTICS_URL=${analytics.url}`,
      `    T3_PROJECT_ID=${analytics.projectId}`,
      `    T3_STREAM=${analytics.stream}`,
      "  `reporting.py` already reads all four; you do not need to write reporting code, and you must not write the key into a file.",
    );
  }
  lines.push("- Do not ask questions. Do the deploy and report the address it is serving on.");
  return lines.join("\n");
}

/** Waits for the build id the deploy was told to stamp to be the one being served. */
async function waitForBuild(healthUrl, buildId, timeoutMs = AGENT_TURN_MS) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = tryBody(healthUrl);
    if (seen.includes(buildId)) return { ok: true, seen };
    await sleep(8_000);
  }
  return { ok: false, seen };
}

/**
 * How many times to tell the agent the deploy is not done before giving up.
 *
 * One, because the wait before it is already generous: a second round would
 * mostly buy time for a deploy that is not coming, at twenty minutes a go.
 */
const MAX_DEPLOY_NUDGES = 1;

/**
 * Asks for a deploy and waits for the stamped build to be the one serving,
 * saying so again if the agent's turn ended before it finished.
 *
 * A turn can stop mid-task — "I only need to stamp the BUILD file before I
 * register and run the deploy target" was a real reply, after which nothing was
 * registered and nothing ran. Waiting longer cannot fix that, because nobody is
 * working; only saying so can, which is exactly what the person sitting there
 * would do. Without it this measures one turn's stamina rather than whether the
 * pack's instructions produce a working deployment.
 *
 * The nudge count comes back and is reported, so a deploy that needed chasing
 * is never recorded as a clean one.
 */
async function deployAndWait({ page, instruction, healthUrl, buildId }) {
  const sent = await sendAgentMessage(page, instruction);
  let result = await waitForBuild(healthUrl, buildId);
  let nudges = 0;
  while (!result.ok && nudges < MAX_DEPLOY_NUDGES) {
    nudges += 1;
    await sendAgentMessage(
      page,
      [
        `${healthUrl} is still not serving build ${buildId}, so the deploy is not done.`,
        "Finish it now, in this turn: register the target with `t3 deploy add` under the name you were given, run it with `t3 deploy run`, and then check /healthz reports that build id.",
      ].join("\n"),
    );
    result = await waitForBuild(healthUrl, buildId);
  }
  return { sent, result, nudges };
}

/** Says how a deploy went, naming the chasing it needed rather than hiding it. */
function describeDeploy(buildId, { result, nudges }) {
  const chased = nudges === 0 ? "" : ` (after ${nudges} nudge${nudges === 1 ? "" : "s"})`;
  return result.ok ? `${buildId}${chased}` : `${result.seen.slice(0, 110)}${chased}`;
}

/** Reports the turn as failed for a provider reason rather than a deploy reason. */
async function providerTrouble(page) {
  const thread = await bodyText(page);
  return (
    /Provider turn start failed|Timed out waiting for initialize|read-only|waiting for the workspace lead/.exec(
      thread,
    )?.[0] ?? null
  );
}

/**
 * Invites, once the dashboard has actually drawn the control.
 *
 * `createInvite` assumes a fixed settle before clicking "Invite", which is
 * enough for a suite that only signs one account in. Here the owner's dashboard
 * is re-rendering while a second account signs up in another context, and the
 * button arrives late often enough to end an otherwise good run — so wait for
 * the control rather than for a duration.
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

// ── reading the two tabs a person reads ─────────────────────────────────────

async function readAnalyticsTab(page, projectId, stream) {
  await page.goto(`${BASE_URL}/analytics/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(8_000);
  const body = await bodyText(page);
  return { body, mentionsStream: body.includes(stream) };
}

async function readInfraTab(page, projectId) {
  await page.goto(`${BASE_URL}/infra/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(8_000);
  const rows = page.locator('[data-testid="infra-deployment"]');
  const count = await rows.count();
  const loads = await page.locator('[data-testid="infra-deployment-load"]').allInnerTexts();
  const events = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-events")),
  );
  return { count, loads, events, body: await bodyText(page) };
}

// ── one artifact, start to finish ───────────────────────────────────────────

async function runArtifact(browser, artifact, index) {
  const dir = path.join(ROOT_DIR, `t3-cd-${artifact.kind}-${RUN_ID}`);
  const port = 19700 + index * 7 + (Number(RUN_ID) % 40);
  const owner = await openIsolatedSession(browser, `${artifact.kind}-owner`);
  const mate = await openIsolatedSession(browser, `${artifact.kind}-mate`);
  const ownerEmail = `cd.${artifact.kind}.owner.${RUN_ID}@example.test`;
  const mateEmail = `cd.${artifact.kind}.mate.${RUN_ID}@example.test`;
  const tunnels = [];
  let address = `http://127.0.0.1:${port}`;

  try {
    phase(`${artifact.label} — the project and the two people`);
    mkdirSync(dir, { recursive: true });
    artifact.build(dir);
    check(`${artifact.kind}: the source is written`, existsSync(path.join(dir, "app.py")), dir);

    check(`${artifact.kind}: the owner signs up`, await signUp(owner, ownerEmail), ownerEmail);
    await addProject(owner.page, dir);
    const projectId = projectIdFor(dir);
    check(`${artifact.kind}: the project is registered`, Boolean(projectId), projectId ?? "none");
    if (!projectId) throw new Error("no project");

    check(`${artifact.kind}: the collaborator signs up`, await signUp(mate, mateEmail), mateEmail);
    const invite = await inviteWhenReady(owner.page, mateEmail);
    check(`${artifact.kind}: the owner invites them`, Boolean(invite), invite ?? "no invite link");
    if (invite) {
      const accepted = await acceptInvite(mate, invite);
      check(
        `${artifact.kind}: the collaborator accepts`,
        accepted.accepted,
        accepted.seen.slice(0, 90),
      );
    }

    // ── the owner puts it live ────────────────────────────────────────────
    phase(`${artifact.label} — the owner deploys it`);
    check(`${artifact.kind}: the owner opens the project`, await openProject(owner.page));
    const firstBuild = `${RUN_ID}-1`;
    const firstDeploy = await deployAndWait({
      page: owner.page,
      instruction: deployInstruction({ artifact, dir, port, buildId: firstBuild, projectId }),
      healthUrl: `http://127.0.0.1:${port}/healthz`,
      buildId: firstBuild,
    });
    check(`${artifact.kind}: the deploy prompt goes to the agent`, firstDeploy.sent);

    const first = firstDeploy.result;
    const trouble = await providerTrouble(owner.page);
    check(`${artifact.kind}: the turn reached a provider`, trouble === null, trouble ?? "");
    check(
      `${artifact.kind}: it serves the build it was told to stamp`,
      first.ok,
      describeDeploy(firstBuild, firstDeploy),
    );
    if (!first.ok) throw new Error("nothing was deployed to change");

    if (artifact.mode === "tunnel") {
      const said = await bodyText(owner.page);
      const printed = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(said)?.[0] ?? null;
      check(
        `${artifact.kind}: the agent reports a tunnel address`,
        Boolean(printed),
        printed ?? "no trycloudflare address in the thread",
      );
      if (printed) {
        address = printed;
        // A quick tunnel takes a moment to route after it prints.
        let reachable = "000";
        for (let attempt = 0; attempt < 6 && reachable !== "200"; attempt += 1) {
          await sleep(10_000);
          reachable = tryStatus(`${printed}/healthz`);
        }
        check(`${artifact.kind}: the tunnel actually serves it`, reachable === "200", reachable);
      }
    }

    if (artifact.mode === "ssh") {
      const remote = tryBody(`http://127.0.0.1:${port}/healthz`);
      check(
        `${artifact.kind}: the node is serving it back through the local port`,
        remote.includes(firstBuild),
        remote.slice(0, 120),
      );
    }

    // ── the collaborator changes it and deploys again ─────────────────────
    phase(`${artifact.label} — the collaborator changes it and redeploys`);
    const target = path.join(dir, artifact.edit.file);
    const before = readFileSync(target, "utf8");
    check(
      `${artifact.kind}: the collaborator's edit target exists`,
      before.includes(artifact.edit.find),
      artifact.edit.file,
    );
    writeFile(dir, artifact.edit.file, before.replace(artifact.edit.find, artifact.edit.replace));

    check(`${artifact.kind}: the collaborator opens the project`, await openProject(mate.page));
    const secondBuild = `${RUN_ID}-2`;
    const secondDeploy = await deployAndWait({
      page: mate.page,
      instruction: deployInstruction({ artifact, dir, port, buildId: secondBuild, projectId }),
      healthUrl: `http://127.0.0.1:${port}/healthz`,
      buildId: secondBuild,
    });
    check(`${artifact.kind}: the collaborator asks for a deploy`, secondDeploy.sent);
    const second = secondDeploy.result;
    const mateTrouble = await providerTrouble(mate.page);
    check(
      `${artifact.kind}: the collaborator's turn reached a provider`,
      mateTrouble === null,
      mateTrouble ?? "",
    );
    check(
      `${artifact.kind}: the redeploy is the build now serving`,
      second.ok,
      describeDeploy(secondBuild, secondDeploy),
    );
    const served = tryBody(`http://127.0.0.1:${port}${artifact.markerRoute}`);
    check(
      `${artifact.kind}: what it serves carries the collaborator's change`,
      served.includes(artifact.marker),
      served.includes(artifact.marker) ? "" : `no "${artifact.marker}" in ${artifact.markerRoute}`,
    );

    // ── the owner wires analytics and traffic arrives ─────────────────────
    phase(`${artifact.label} — the owner sets up analytics`);
    // Declare-or-reuse. The agent is told to wire analytics through the deploy,
    // and a deploy asked for a stream declares it if it is missing — so by the
    // time this runs the stream may already exist, and a second declare is an
    // error rather than a no-op. What matters is that it exists, not who made
    // it; the key is never read here because the deploy mints and injects its
    // own, which is the only place a key is allowed to live.
    try {
      t3([
        "analytics",
        "declare",
        "--project",
        projectId,
        "--name",
        artifact.stream,
        "--purpose",
        `What ${artifact.kind} readers do`,
        "--properties",
        "path:string:required,seconds:number",
      ]);
    } catch (error) {
      const already = /already declared/.test(
        String(error?.stdout ?? "") + String(error?.stderr ?? ""),
      );
      if (!already) throw error;
    }
    const streams = t3(["analytics", "list", "--project", projectId]);
    check(
      `${artifact.kind}: the stream exists to report to`,
      streams.includes(artifact.stream),
      streams.split("\n")[0]?.slice(0, 90) ?? "",
    );

    // A deployment on the node cannot reach a loopback address on this machine,
    // so the ingest route has to be published for it the same way the app is.
    let ingestUrl = ANALYTICS_URL;
    if (artifact.mode === "ssh") {
      const opened = await openQuickTunnel(13773);
      if (opened) {
        tunnels.push(opened.child);
        ingestUrl = `${opened.url}/api/analytics/events`;
      } else {
        skip(`${artifact.kind}: the node can report analytics`, "no tunnel for the ingest route");
      }
    }

    const thirdBuild = `${RUN_ID}-3`;
    const thirdDeploy = await deployAndWait({
      page: owner.page,
      instruction: deployInstruction({
        artifact,
        dir,
        port,
        buildId: thirdBuild,
        projectId,
        analytics: { url: ingestUrl, projectId, stream: artifact.stream },
      }),
      healthUrl: `http://127.0.0.1:${port}/healthz`,
      buildId: thirdBuild,
    });
    check(`${artifact.kind}: the owner asks for analytics to be wired`, thirdDeploy.sent);
    const third = thirdDeploy.result;
    check(
      `${artifact.kind}: the reporting build is the one serving`,
      third.ok,
      describeDeploy(thirdBuild, thirdDeploy),
    );

    phase(`${artifact.label} — mock traffic`);
    const visits = ["/pricing", "/about", "/about", "/about", "/contact"];
    let reported = 0;
    // What the deployment said when it was not 202. A count alone cannot tell
    // "no key reached the process" from "the key is for another stream".
    const refusals = new Map();
    for (const where of visits) {
      const answer = tryBody(`http://127.0.0.1:${port}/visit${where}`);
      if (/"reported":\s*202/.test(answer)) {
        reported += 1;
        continue;
      }
      const status = /"reported":\s*(-?\d+)/.exec(answer)?.[1] ?? "no answer";
      refusals.set(status, (refusals.get(status) ?? 0) + 1);
    }
    check(
      `${artifact.kind}: the deployment reported every visit`,
      reported === visits.length,
      [
        `${reported}/${visits.length} accepted`,
        ...[...refusals].map(([status, count]) => `${count}x ${explainReport(status)}`),
      ].join(", "),
    );
    await sleep(3_000);

    phase(`${artifact.label} — the two tabs`);
    const counted = t3([
      "analytics",
      "query",
      "--project",
      projectId,
      "--stream",
      artifact.stream,
      "--aggregate",
      "count",
      "--group-by",
      "path",
    ]);
    check(
      `${artifact.kind}: the workspace counted the traffic`,
      /\/about\s+3/.test(counted),
      counted.replace(/\n/g, " | ").slice(0, 120),
    );

    const analyticsTab = await readAnalyticsTab(owner.page, projectId, artifact.stream);
    check(
      `${artifact.kind}: the Analytics tab lists the stream`,
      analyticsTab.mentionsStream,
      analyticsTab.body.replace(/\s+/g, " ").slice(0, 120),
    );

    const infraTab = await readInfraTab(owner.page, projectId);
    check(
      `${artifact.kind}: the Infrastructure tab lists the deployment`,
      infraTab.count >= 1,
      `${infraTab.count} rows — ${infraTab.body.replace(/\s+/g, " ").slice(0, 100)}`,
    );
    const loaded = infraTab.events.some((value) => Number(value) >= visits.length);
    check(
      `${artifact.kind}: the Infrastructure tab shows the load`,
      loaded,
      infraTab.loads.join(" | ").slice(0, 140),
    );

    console.log(`  ${artifact.kind}: ${address}`);
  } finally {
    for (const child of tunnels) child.kill("SIGTERM");
    sh(
      `([ -f ${JSON.stringify(path.join(dir, "app.pid"))} ] && kill "$(cat ${JSON.stringify(path.join(dir, "app.pid"))})" 2>/dev/null) || true`,
    );
    sh(`pkill -f "b 127.0.0.1:${port}" 2>/dev/null || true`);
    await owner.context.close().catch(() => undefined);
    await mate.context.close().catch(() => undefined);
    if (!KEEP) {
      rmSync(dir, { recursive: true, force: true });
      unlistProject(dir);
    }
  }
}

/** A quick tunnel onto a local port, resolved from the address cloudflared prints. */
function openQuickTunnel(port) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const watch = (chunk) => {
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
      if (found) done({ url: found[0], child });
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("error", () => done(null));
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        done(null);
      }
    }, 60_000);
  });
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
try {
  const chosen = ONLY ? ARTIFACTS.filter((artifact) => artifact.kind === ONLY) : ARTIFACTS;
  if (chosen.length === 0) {
    console.error(
      `T3_E2E_ONLY=${ONLY} matches none of: ${ARTIFACTS.map((a) => a.kind).join(", ")}`,
    );
    process.exit(1);
  }
  for (const [index, artifact] of chosen.entries()) {
    // One artifact failing is a result about that artifact, not a reason to
    // stop finding out about the other two.
    try {
      await runArtifact(browser, artifact, index);
    } catch (error) {
      check(`${artifact.kind}: the run completed`, false, String(error).slice(0, 160));
    }
  }
} finally {
  await browser.close();
}

process.exit(finish());
