#!/usr/bin/env node
// Deploys a service that builds a PDF and reports how it is read, then asks the
// workspace which page held a reader longest.
//
//   bun run dev                 # in another terminal
//   bun run test:pdf-pack
//
// Everything runs locally, because the point is the whole chain: the deployment
// posts its own analytics, so it has to be able to reach the analytics endpoint.
// A deployment on a remote host cannot reach a loopback address on this machine.
//
//   T3_E2E_BASE_URL       the web app        (default http://localhost:5733)
//   T3_ANALYTICS_URL      the ingest route   (default http://127.0.0.1:13773/api/analytics/events)
//   T3_PDF_PORT           port to serve on   (default derived from the run id)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createReporter } from "./lib/e2e-harness.mjs";

const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const APP_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-pdf-${RUN_ID}`);
const PROJECT_ID = `pdf-demo-${RUN_ID}`;
const STREAM = "pdf.page_read";
const PORT = process.env["T3_PDF_PORT"] ?? String(19500 + (Number(RUN_ID) % 300));
const ANALYTICS_URL =
  process.env["T3_ANALYTICS_URL"] ?? "http://127.0.0.1:13773/api/analytics/events";
const BASE_DIR = path.join(os.homedir(), ".t3");
const DEV_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

// The document the service renders, so "which page held them longest" has a
// known right answer.
const PAGES = ["Cover", "Why it broke", "What we changed", "What is left"];

const { phase, check, finish } = createReporter();

const CLI_ENTRY = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "apps",
  "server",
  "src",
  "bin.ts",
);

/** The CLI, always pointed at the store the running dev server uses. */
function t3(args, options = {}) {
  return execFileSync("node", [CLI_ENTRY, ...args, "--base-dir", BASE_DIR, "--dev-url", DEV_URL], {
    cwd: options.cwd ?? APP_DIR,
    encoding: "utf8",
    timeout: 180_000,
  }).trim();
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

function buildPdfService(ingestKey) {
  writeFile(
    "build_pdf.py",
    [
      '"""Renders the document. Kept separate so the deploy can build before it serves."""',
      "import pathlib",
      "",
      "from reportlab.lib.pagesizes import A4",
      "from reportlab.pdfgen import canvas",
      "",
      `PAGES = ${JSON.stringify(PAGES)}`,
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
    "app.py",
    [
      "import json",
      "import pathlib",
      "import urllib.request",
      "",
      "from flask import Flask, Response, send_file",
      "",
      "import build_pdf",
      "",
      "app = Flask(__name__)",
      "HERE = pathlib.Path(__file__).parent",
      "DOC = HERE / 'doc.pdf'",
      "",
      `ANALYTICS_URL = ${JSON.stringify(ANALYTICS_URL)}`,
      `PROJECT_ID = ${JSON.stringify(PROJECT_ID)}`,
      `STREAM = ${JSON.stringify(STREAM)}`,
      `INGEST_KEY = ${JSON.stringify(ingestKey)}`,
      "",
      "",
      "def report(page: int, seconds: float) -> int:",
      '    """A deployment reports its own events, with the key and no session."""',
      "    body = json.dumps({",
      "        'projectId': PROJECT_ID,",
      "        'stream': STREAM,",
      "        'ingestKey': INGEST_KEY,",
      "        'properties': {'page': page, 'title': build_pdf.PAGES[page - 1], 'seconds': seconds},",
      "    }).encode()",
      "    request = urllib.request.Request(",
      "        ANALYTICS_URL, data=body, headers={'content-type': 'application/json'}",
      "    )",
      "    try:",
      "        with urllib.request.urlopen(request, timeout=10) as response:",
      "            return response.status",
      "    except urllib.error.HTTPError as error:",
      "        # 422 is this service's own bug and worth seeing in the log.",
      "        return error.code",
      "",
      "",
      "@app.route('/doc.pdf')",
      "def document():",
      "    return send_file(DOC, mimetype='application/pdf')",
      "",
      "",
      "@app.route('/read/<int:page>/<int:seconds>')",
      "def read(page: int, seconds: int):",
      "    if page < 1 or page > len(build_pdf.PAGES):",
      "        return {'error': 'no such page'}, 404",
      "    return {'reported': report(page, float(seconds))}, 200",
      "",
      "",
      "@app.route('/healthz')",
      "def healthz():",
      "    build = (HERE / 'BUILD').read_text().strip()",
      "    return {'status': 'ok', 'build': build, 'pages': len(build_pdf.PAGES)}, 200",
      "",
    ].join("\n"),
  );
}

/**
 * The interpreter this script can see, not whichever one a login shell finds.
 * `deploy run` executes through `/bin/sh -lc`, whose PATH is not the one the
 * caller had: on this machine that resolved to a system python with neither
 * reportlab nor gunicorn installed.
 */
const PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
  encoding: "utf8",
}).trim();

/** Ship nothing anywhere: a local deploy builds the PDF and starts the server. */
function buildDeployCommand() {
  return [
    `${JSON.stringify(PYTHON)} build_pdf.py`,
    `([ -f app.pid ] && kill "$(cat app.pid)" 2>/dev/null || true)`,
    "sleep 1",
    `(nohup ${JSON.stringify(PYTHON)} -m gunicorn -w 2 -b 127.0.0.1:${PORT} app:app > deploy.log 2>&1 & echo $! > app.pid)`,
    "sleep 4",
    `curl -fsS http://127.0.0.1:${PORT}/healthz | grep -q "$(cat BUILD)"`,
  ].join(" && ");
}

function get(route) {
  return execFileSync("curl", ["-fsS", `http://127.0.0.1:${PORT}${route}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function getBytes(route) {
  return execFileSync("curl", ["-fsS", `http://127.0.0.1:${PORT}${route}`], {
    encoding: "buffer",
    timeout: 30_000,
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

const reachable = await fetch(DEV_URL, { redirect: "manual" }).then(
  () => true,
  () => false,
);
if (!reachable) {
  console.error(`Nothing is answering at ${DEV_URL}. Start one with \`bun run dev\`.`);
  process.exit(1);
}

let started = false;
try {
  phase("Declare what the document will report");
  mkdirSync(APP_DIR, { recursive: true });
  const declared = t3([
    "analytics",
    "declare",
    "--project",
    PROJECT_ID,
    "--name",
    STREAM,
    "--purpose",
    "How far into the document a reader got",
    "--properties",
    "page:number:required,title:string,seconds:number",
  ]);
  const ingestKey = /Ingest key \(shown once\): (\S+)/.exec(declared)?.[1] ?? null;
  check("the stream is declared", Boolean(ingestKey), ingestKey ? "key captured" : declared);
  if (!ingestKey) throw new Error("no ingest key to give the deployment");

  const listed = t3(["analytics", "list", "--project", PROJECT_ID]);
  check(
    "the declaration names its properties",
    listed.includes("page:number"),
    listed.split("\n")[0],
  );

  phase("A service that builds the PDF and reports how it is read");
  buildPdfService(ingestKey);
  writeFile("BUILD", `${RUN_ID}-1\n`);
  check(
    "the renderer and the service are written",
    existsSync(path.join(APP_DIR, "app.py")),
    APP_DIR,
  );
  check(
    "the ingest key is in the deployment, not the repository",
    readFileSync(path.join(APP_DIR, "app.py"), "utf8").includes(ingestKey),
  );

  phase("Deploy it");
  const added = t3([
    "deploy",
    "add",
    "--project",
    PROJECT_ID,
    "--name",
    `PDF ${RUN_ID}`,
    "--command",
    buildDeployCommand(),
  ]);
  const targetId = /target (\S+)/.exec(added)?.[1] ?? null;
  check("a deploy target is registered", Boolean(targetId), targetId ?? added);
  if (!targetId) throw new Error("no deploy target to run");

  let deployFailure = null;
  try {
    t3(["deploy", "run", targetId]);
    started = true;
  } catch (error) {
    deployFailure = `${error?.stdout ?? ""}${error?.stderr ?? ""}`
      .replace(/\s+/g, " ")
      .slice(0, 250);
  }
  check("the deploy succeeds", deployFailure === null, deployFailure ?? "");
  if (deployFailure !== null) throw new Error("nothing to read");

  phase("The document itself");
  const health = JSON.parse(get("/healthz"));
  check(
    "the service reports the build it is serving",
    health.build === `${RUN_ID}-1`,
    String(health.build),
  );
  const pdf = getBytes("/doc.pdf");
  check(
    "what it serves is a real PDF",
    pdf.subarray(0, 5).toString() === "%PDF-",
    pdf.subarray(0, 8).toString(),
  );
  const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check(`the PDF has all ${PAGES.length} pages`, pageCount === PAGES.length, `${pageCount} pages`);

  phase("A reader works through it");
  // Page 3 is where the reader lingers, so the answer is known before asking.
  const reading = [
    [1, 4],
    [2, 12],
    [3, 40],
    [3, 25],
    [4, 6],
  ];
  let reported = 0;
  for (const [page, seconds] of reading) {
    const answer = JSON.parse(get(`/read/${page}/${seconds}`));
    if (answer.reported === 202) reported += 1;
  }
  check(
    "the deployment reported every read",
    reported === reading.length,
    `${reported}/${reading.length} accepted`,
  );

  phase("Ask the workspace what happened");
  const byPage = t3([
    "analytics",
    "query",
    "--project",
    PROJECT_ID,
    "--stream",
    STREAM,
    "--aggregate",
    "sum",
    "--value",
    "seconds",
    "--group-by",
    "title",
  ]);
  const longest = byPage.split("\n")[0] ?? "";
  check(
    "the most-read page is the one they lingered on",
    longest.startsWith("What we changed"),
    longest,
  );
  check("its total is both visits added up", longest.includes("65"), longest);

  const reads = t3([
    "analytics",
    "query",
    "--project",
    PROJECT_ID,
    "--stream",
    STREAM,
    "--aggregate",
    "count",
    "--group-by",
    "title",
  ]);
  check(
    "every page that was opened is counted",
    reads.split("\n").length === 4,
    reads.replace(/\n/g, " | "),
  );

  const furthest = t3([
    "analytics",
    "query",
    "--project",
    PROJECT_ID,
    "--stream",
    STREAM,
    "--aggregate",
    "max",
    "--value",
    "page",
  ]);
  check("it knows how far they got", furthest.includes(String(PAGES.length)), furthest);

  phase("Result");
  console.log(`  workspace: ${APP_DIR}`);
  console.log(`  serving:   http://127.0.0.1:${PORT}/doc.pdf`);
} finally {
  if (started) {
    const pidFile = path.join(APP_DIR, "app.pid");
    if (existsSync(pidFile)) {
      execFileSync("bash", ["-c", `kill "$(cat ${JSON.stringify(pidFile)})" 2>/dev/null || true`]);
    }
  }
  if (!KEEP) rmSync(APP_DIR, { recursive: true, force: true });
}

process.exit(finish());
