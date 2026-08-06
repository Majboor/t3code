#!/usr/bin/env node
// Drives two freshly created accounts through the collaboration flow against a
// running dev server, and checks that file changes made on disk, in the UI, and
// by the agent reach both accounts.
//
//   bun run dev                 # in another terminal
//   node scripts/collab-e2e.mjs
//
// Override the target with T3_E2E_BASE_URL. Every account, workspace folder and
// file name is generated per run, so repeated runs never collide.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Playwright is installed for the web app's browser tests; borrow that copy
// rather than adding a second one just for this script.
const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("playwright");

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const RUN_ID = String(Date.now());
const PROJECT_DIR = path.join(os.homedir(), "Desktop", `t3-collab-${RUN_ID}`);
const PASSWORD = "CollabE2E!2026";
const ACCOUNT_A = `collab.a.${RUN_ID}@example.test`;
const ACCOUNT_B = `collab.b.${RUN_ID}@example.test`;
const KEEP_WORKSPACE = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

// The agent needs far longer than the UI, and an unresponsive provider should
// fail the check rather than hang the run.
const UI_SETTLE_MS = 2_500;
const NAVIGATION_MS = 9_000;
const AGENT_TURN_MS = 90_000;
const FILE_APPEAR_TIMEOUT_MS = 20_000;

const results = [];
let currentPhase = "setup";

function phase(title) {
  currentPhase = title;
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

function check(step, ok, detail = "") {
  results.push({ phase: currentPhase, step, ok });
  const mark = ok ? "[32mPASS[0m" : "[31mFAIL[0m";
  console.log(`  ${mark}  ${step}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes a file through python3, so the change originates outside the app. */
function writeFileViaPython(relativePath, contents) {
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

function diskContains(name) {
  return existsSync(path.join(PROJECT_DIR, name));
}

// ── browser helpers ─────────────────────────────────────────────────────────

/** A context per account: separate cookies and storage, i.e. a private window. */
async function openIsolatedSession(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 200)}`));
  return { label, context, page, consoleErrors };
}

async function bodyText(page) {
  return (await page.locator("body").innerText().catch(() => "")) ?? "";
}

const PERMISSION_ERROR = /Forbidden|does not have (file|project|session|workspace)\./;

async function submitCredentials(page, email, mode) {
  await page.locator(`button:has-text("${mode === "signup" ? "Sign up" : "Log in"}")`).first()
    .click()
    .catch(() => undefined);
  await sleep(1_000);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await sleep(NAVIGATION_MS);
}

async function signUp(session, email) {
  await session.page.goto(`${BASE_URL}/pair`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await sleep(4_000);
  await submitCredentials(session.page, email, "signup");
  return !session.page.url().includes("/pair");
}

async function logIn(session, email) {
  await session.page.goto(`${BASE_URL}/pair`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await sleep(4_000);
  await submitCredentials(session.page, email, "login");
  return !session.page.url().includes("/pair");
}

async function addProject(page, workspaceRoot) {
  await page.locator('button:has-text("Add project")').first().click();
  await sleep(UI_SETTLE_MS);
  await page.locator("[data-base-ui-portal] input").first().fill(workspaceRoot);
  await sleep(3_000);
  await page.keyboard.press("Enter");
  await sleep(NAVIGATION_MS);
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(1_000);
}

/** Opens the project's thread view from the dashboard. */
async function openProject(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  const link = page.locator('[data-testid="dashboard-workspace-project-link"]').first();
  if ((await link.count()) === 0) return false;
  await link.click();
  await sleep(NAVIGATION_MS);
  return true;
}

/**
 * The file tree lives in a panel that starts collapsed, and the panel only
 * lists anything while a project or thread is selected — a bare reload leaves it
 * showing a placeholder, so recover by walking back in through the dashboard.
 */
async function ensureWorkspacePanelOpen(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const seedVisible = await page
      .locator('button:text-is("seed-one.txt")')
      .first()
      .isVisible()
      .catch(() => false);
    if (seedVisible) return true;

    const toggle = page.locator('button[aria-label="Toggle workspace panel"]').first();
    if ((await toggle.count()) > 0) {
      await toggle.click().catch(() => undefined);
      await sleep(3_000);
    }

    const unselected = (await bodyText(page)).includes("Select a project or thread");
    if (!unselected) return true;
    if (attempt === 0) await openProject(page);
  }
  return false;
}

/** The panel renders over the composer, so it has to be dismissed to type. */
async function closeWorkspacePanel(page) {
  const close = page.locator('button[aria-label="Close workspace panel"]').first();
  if ((await close.count()) > 0) {
    await close.click().catch(() => undefined);
  } else {
    await page.locator('button[aria-label="Toggle workspace panel"]').first().click().catch(() => undefined);
  }
  await sleep(2_000);
}

async function visibleFileNames(page) {
  await ensureWorkspacePanelOpen(page);
  return page
    .locator("button")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => /^[\w.-]+\.(txt|md|json|js|ts)$/.test(text)),
    );
}

/**
 * Waits for `name` in the file tree, first without touching navigation and then
 * after reopening the project. The two are reported separately so a tree that
 * only updates on refresh is not mistaken for one that updates live.
 */
async function waitForFileInTree(page, name) {
  const deadline = Date.now() + FILE_APPEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await visibleFileNames(page)).includes(name)) {
      return { found: true, neededReload: false };
    }
    await sleep(3_000);
  }
  await openProject(page);
  return { found: (await visibleFileNames(page)).includes(name), neededReload: true };
}

async function createFileViaUi(page, name) {
  if (!(await ensureWorkspacePanelOpen(page))) return false;
  const newFile = page.locator('button[aria-label="New file"]').first();
  if ((await newFile.count()) === 0) return false;
  await newFile.click();
  await sleep(1_500);
  await page.keyboard.type(name);
  await sleep(700);
  await page.keyboard.press("Enter");
  await sleep(5_000);
  return true;
}

async function sendAgentMessage(page, prompt) {
  await closeWorkspacePanel(page);
  const composer = page.locator('[data-testid="composer-editor"], textarea').first();
  if ((await composer.count()) === 0) return false;
  await composer.click();
  await composer.fill(prompt).catch(async () => {
    await page.keyboard.type(prompt);
  });
  await page.keyboard.press("Enter");
  return true;
}

async function waitForFileOnDisk(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (diskContains(name)) return true;
    await sleep(3_000);
  }
  return false;
}

// ── the run ─────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
const accountA = await openIsolatedSession(browser, "A");
const accountB = await openIsolatedSession(browser, "B");

try {
  phase("Setup: a real folder on the Desktop, seeded by python");
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileViaPython("seed-one.txt", "seed one\n");
  writeFileViaPython("seed-two.md", "# seed two\n");
  check("python seeded the folder", readdirSync(PROJECT_DIR).length === 2, PROJECT_DIR);

  phase("Account A: sign up and add the Desktop folder");
  check("A signs up", await signUp(accountA, ACCOUNT_A), ACCOUNT_A);
  await addProject(accountA.page, PROJECT_DIR);
  const aFiles = await visibleFileNames(accountA.page);
  check("A sees the project", (await bodyText(accountA.page)).includes(path.basename(PROJECT_DIR)));
  check("A sees the seeded files", aFiles.includes("seed-one.txt") && aFiles.includes("seed-two.md"),
    aFiles.join(", "));

  phase("Account A: invite a second person to the workspace");
  await accountA.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  await accountA.page.locator('button:has-text("Invite")').first().click();
  await sleep(2_000);
  await accountA.page.locator('[data-slot="dialog-panel"] input[type="email"]').first().fill(ACCOUNT_B);
  await accountA.page.locator('[data-slot="dialog-footer"] button:has-text("Create invite")').first().click();
  await sleep(5_000);
  const codes = await accountA.page.locator("code").allInnerTexts();
  const inviteUrl = codes.find((text) => text.includes("invite=")) ?? null;
  check("invite link created", Boolean(inviteUrl), inviteUrl ?? "none");
  await accountA.page.locator('button:has-text("Close")').first().click().catch(() => undefined);
  if (!inviteUrl) throw new Error("no invite link to follow");

  phase("Account B: open the invite in a clean session and sign up");
  await accountB.page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  const invitePrompt = await bodyText(accountB.page);
  check("clean session is asked to authenticate", /Sign up|Log in|Sign in/.test(invitePrompt));
  check("B signs up from the invite", await signUp(accountB, ACCOUNT_B), ACCOUNT_B);
  await accountB.page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(7_000);
  check("B accepts the invite", (await bodyText(accountB.page)).includes("Invite accepted"));
  await accountB.page.locator('button:has-text("Back to app")').first().click().catch(() => undefined);
  await sleep(6_000);

  phase("Account B: reach the shared folder");
  check("B opens the shared project", await openProject(accountB.page));
  const bDashboard = await bodyText(accountB.page);
  check("B hits no permission error", !PERMISSION_ERROR.test(bDashboard),
    bDashboard.match(PERMISSION_ERROR)?.[0] ?? "");
  const bFiles = await visibleFileNames(accountB.page);
  check("B sees the seeded files", bFiles.includes("seed-one.txt") && bFiles.includes("seed-two.md"),
    bFiles.join(", "));

  phase("A file written on disk by python");
  const pythonFile = `python-made-${RUN_ID}.txt`;
  writeFileViaPython(pythonFile, "written by python\n");
  const pythonInB = await waitForFileInTree(accountB.page, pythonFile);
  check("B sees the python-written file", pythonInB.found,
    pythonInB.found && pythonInB.neededReload ? "only after a reload" : "");

  phase("Account B creates a file in the app");
  const bFile = `from-b-${RUN_ID}.txt`;
  check("B uses New file", await createFileViaUi(accountB.page, bFile));
  check("B's file lands on disk", await waitForFileOnDisk(bFile, FILE_APPEAR_TIMEOUT_MS),
    path.join(PROJECT_DIR, bFile));

  phase("Account A signs back in and looks for B's work");
  const accountA2 = await openIsolatedSession(browser, "A2");
  check("A logs back in", await logIn(accountA2, ACCOUNT_A));
  check("A reopens the project", await openProject(accountA2.page));
  const aSeesB = await waitForFileInTree(accountA2.page, bFile);
  check("A sees the file B created", aSeesB.found,
    aSeesB.found && aSeesB.neededReload ? "only after a reload" : "");
  const aSeesPython = (await visibleFileNames(accountA2.page)).includes(pythonFile);
  check("A sees the python-written file", aSeesPython);

  phase("Account A creates a file in the app");
  const aFile = `from-a-${RUN_ID}.txt`;
  check("A uses New file", await createFileViaUi(accountA2.page, aFile));
  check("A's file lands on disk", await waitForFileOnDisk(aFile, FILE_APPEAR_TIMEOUT_MS));
  const bSeesA = await waitForFileInTree(accountB.page, aFile);
  check("B sees the file A created", bSeesA.found,
    bSeesA.found && bSeesA.neededReload ? "only after a reload" : "");

  phase("Both accounts drive the agent");
  const agentFileA = `agent-a-${RUN_ID}.txt`;
  check("A sends a message to the agent",
    await sendAgentMessage(accountA2.page, `Create a file named ${agentFileA} containing the word alpha. Do not ask questions.`));
  const agentAOnDisk = await waitForFileOnDisk(agentFileA, AGENT_TURN_MS);
  check("A's agent wrote the file", agentAOnDisk,
    agentAOnDisk ? readFileSync(path.join(PROJECT_DIR, agentFileA), "utf8").trim() : "not created");
  const aThread = await bodyText(accountA2.page);
  check("A's turn reports no provider error",
    !/Provider turn start failed|Timed out waiting for initialize/.test(aThread),
    aThread.match(/(Provider turn start failed|Timed out[^\n]*)/)?.[0] ?? "");
  if (agentAOnDisk) {
    const bSeesAgentA = await waitForFileInTree(accountB.page, agentFileA);
    check("B sees what A's agent wrote", bSeesAgentA.found,
      bSeesAgentA.found && bSeesAgentA.neededReload ? "only after a reload" : "");
  }

  const agentFileB = `agent-b-${RUN_ID}.txt`;
  check("B sends a message to the agent",
    await sendAgentMessage(accountB.page, `Create a file named ${agentFileB} containing the word beta. Do not ask questions.`));
  const agentBOnDisk = await waitForFileOnDisk(agentFileB, AGENT_TURN_MS);
  check("B's agent wrote the file", agentBOnDisk,
    agentBOnDisk ? readFileSync(path.join(PROJECT_DIR, agentFileB), "utf8").trim() : "not created");
  const bThread = await bodyText(accountB.page);
  check("B's turn reports no provider error",
    !/Provider turn start failed|Timed out waiting for initialize/.test(bThread),
    bThread.match(/(Provider turn start failed|Timed out[^\n]*)/)?.[0] ?? "");
  if (agentBOnDisk) {
    const aSeesAgentB = await waitForFileInTree(accountA2.page, agentFileB);
    check("A sees what B's agent wrote", aSeesAgentB.found,
      aSeesAgentB.found && aSeesAgentB.neededReload ? "only after a reload" : "");
  }

  phase("Result");
  console.log(`  workspace: ${PROJECT_DIR}`);
  console.log(`  on disk:   ${readdirSync(PROJECT_DIR).join(", ")}`);
  for (const [label, errors] of [
    ["A", accountA.consoleErrors],
    ["B", accountB.consoleErrors],
    ["A2", accountA2.consoleErrors],
  ]) {
    const meaningful = errors.filter((text) => !text.includes("401"));
    if (meaningful.length > 0) console.log(`  console (${label}): ${meaningful.slice(0, 3).join(" | ")}`);
  }
} finally {
  await browser.close();
  if (!KEEP_WORKSPACE) rmSync(PROJECT_DIR, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const result of failed) console.log(`  FAILED  [${result.phase}] ${result.step}`);
process.exit(failed.length === 0 ? 0 : 1);
