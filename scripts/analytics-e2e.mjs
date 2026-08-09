#!/usr/bin/env node
// Takes analytics the whole way: a project, a declared stream, events posted by
// something outside the app, and the page a person actually looks at.
//
//   bun run dev                 # in another terminal
//   bun run test:analytics
//
// No agent and no remote host, so this one is quick and needs no credentials.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { bodyText, createHarness, createReporter, openIsolatedSession, sleep } from "./lib/e2e-harness.mjs";

const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("playwright");

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const ANALYTICS_URL =
  process.env["T3_ANALYTICS_URL"] ?? "http://127.0.0.1:13773/api/analytics/events";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const PROJECT_DIR = path.join(existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(), `t3-an-${RUN_ID}`);
const PASSWORD = "Analytics!2026";
const ACCOUNT = `analytics.${RUN_ID}@example.test`;
const BASE_DIR = path.join(os.homedir(), ".t3");
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

const { phase, check, finish } = createReporter();
const { signUp, addProject } = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  probeFile: "readme.txt",
});

const CLI_ENTRY = path.join(
  path.dirname(new URL(import.meta.url).pathname), "..", "apps", "server", "src", "bin.ts",
);

/** Pointed at the store the running dev server uses, not the CLI's own. */
function t3(args) {
  return execFileSync("node", [CLI_ENTRY, ...args, "--base-dir", BASE_DIR, "--dev-url", BASE_URL], {
    encoding: "utf8",
    timeout: 180_000,
  }).trim();
}

/** Posts like a deployment does: the key, and no session at all. */
function postEvent(projectId, ingestKey, properties) {
  const body = JSON.stringify({ projectId, stream: "page.view", ingestKey, properties });
  const status = execFileSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", ANALYTICS_URL,
     "-H", "content-type: application/json", "-d", body],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  return status;
}

/**
 * Follows the dashboard's own link to analytics and takes the project id from
 * where it lands. Reading it out of the database instead would need sqlite on
 * the machine running this, and would not prove the link works.
 */
async function openAnalyticsFromDashboard(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(7_000);
  const link = page.locator('[data-testid="dashboard-workspace-analytics-link"]').first();
  if ((await link.count()) === 0) return null;
  await link.click();
  await sleep(8_000);
  return /\/analytics\/([^/?#]+)/.exec(page.url())?.[1] ?? null;
}

async function barLabels(page) {
  return page
    .locator('[data-testid="analytics-bar"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute("data-label")}=${(node.textContent ?? "").trim()}`),
    );
}

// ── the run ─────────────────────────────────────────────────────────────────

const reachable = await fetch(BASE_URL, { redirect: "manual" }).then(() => true, () => false);
if (!reachable) {
  console.error(`Nothing is answering at ${BASE_URL}. Start one with \`bun run dev\`.`);
  process.exit(1);
}

const browser = await chromium.launch();
const account = await openIsolatedSession(browser, "A");

try {
  phase("A project to report about");
  mkdirSync(PROJECT_DIR, { recursive: true });
  execFileSync("python3", [
    "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('hello')",
    path.join(PROJECT_DIR, "readme.txt"),
  ]);
  check("the account signs up", await signUp(account, ACCOUNT), ACCOUNT);
  await addProject(account.page, PROJECT_DIR);

  phase("Before anything reports");
  // The dashboard's own link is how a person gets here, so use it.
  const projectId = await openAnalyticsFromDashboard(account.page);
  check("the dashboard links through to analytics", Boolean(projectId), projectId ?? "no link");
  if (!projectId) throw new Error("no project to attach a stream to");
  const empty = await account.page.locator('[data-testid="analytics-empty"]').count();
  check("the page says nothing is reporting yet", empty === 1, `${empty} empty states`);
  check("and tells you how to start", (await bodyText(account.page)).includes("t3 analytics declare"));

  phase("Declare a stream");
  const declared = t3([
    "analytics", "declare", "--project", projectId, "--name", "page.view",
    "--purpose", "Which pages get read",
    "--properties", "path:string:required,seconds:number",
  ]);
  const ingestKey = /Ingest key \(shown once\): (\S+)/.exec(declared)?.[1] ?? null;
  check("the stream is declared and hands back a key", Boolean(ingestKey));
  if (!ingestKey) throw new Error("no ingest key");

  phase("Something outside the app reports");
  const accepted = [
    postEvent(projectId, ingestKey, { path: "/about", seconds: 12 }),
    postEvent(projectId, ingestKey, { path: "/about", seconds: 30 }),
    postEvent(projectId, ingestKey, { path: "/pricing", seconds: 5 }),
  ];
  check("every event is accepted", accepted.every((status) => status === "202"), accepted.join(","));
  check("a wrong key is refused", postEvent(projectId, "not-the-key", { path: "/x" }) === "403");
  check("an undeclared property is refused",
    postEvent(projectId, ingestKey, { path: "/x", referrer: "g" }) === "422");

  phase("The page a person looks at");
  await account.page.goto(`${BASE_URL}/analytics/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(8_000);
  check("the stream is listed",
    (await account.page.locator('[data-testid="analytics-stream-choice"]').count()) === 1);
  // Only because the stream declared something numeric.
  const aggregates = await account.page.locator('[data-testid="analytics-aggregate"]').count();
  check("all five aggregates are offered", aggregates === 5, `${aggregates} offered`);
  const groups = await account.page.locator('[data-testid="analytics-group"]').count();
  check("grouping is offered by the text property only", groups === 2, `${groups} choices`);

  phase("Ask it a question");
  const groupByPath = account.page.locator('[data-testid="analytics-group"]', { hasText: "path" }).first();
  check("the page offers to group by path", (await groupByPath.count()) === 1);
  await groupByPath.click();
  await sleep(5_000);
  const counted = await barLabels(account.page);
  check("it draws a bar per page, most read first",
    counted[0]?.startsWith("/about") === true && counted.length === 2, counted.join(" | "));

  const sum = account.page.locator('[data-testid="analytics-aggregate"]', { hasText: "sum" }).first();
  await sum.click();
  await sleep(5_000);
  const summed = await barLabels(account.page);
  // 12 + 30 against a single 5, so the order holds and the number is the total.
  check("summing the seconds adds both visits up", summed[0]?.includes("42") === true, summed.join(" | "));
  check("the refused events left nothing behind",
    !summed.some((bar) => bar.startsWith("/x")), summed.join(" | "));

  phase("Result");
  console.log(`  project:   ${projectId}`);
  console.log(`  workspace: ${PROJECT_DIR}`);
} finally {
  await browser.close();
  if (!KEEP) rmSync(PROJECT_DIR, { recursive: true, force: true });
}

process.exit(finish());
