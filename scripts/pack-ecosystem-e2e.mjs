#!/usr/bin/env node
// The pack ecosystem, through the UI: publish a project as a pack, read it on
// its own page, turn it on for a project, and see what it still owes.
//
//   bun run dev                 # in another terminal
//   bun run test:pack-ecosystem
//
// No agent and no remote host, so it needs no credentials.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const PROJECT_DIR = path.join(
  existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(),
  `t3-eco-${RUN_ID}`,
);
const PASSWORD = "Ecosystem!2026";
const ACCOUNT = `eco.${RUN_ID}@example.test`;
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";

const { phase, check, finish } = createReporter();
const { signUp, addProject } = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  probeFile: "seed.txt",
});

async function goHome(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(7_000);
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
  phase("A project to publish");
  mkdirSync(PROJECT_DIR, { recursive: true });
  execFileSync("python3", [
    "-c",
    "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('hello')",
    path.join(PROJECT_DIR, "seed.txt"),
  ]);
  check("the account signs up", await signUp(account, ACCOUNT), ACCOUNT);
  await addProject(account.page, PROJECT_DIR);
  await goHome(account.page);

  phase("A fresh account can make a workspace");
  // Nothing else here creates one — every suite uses the workspace signup
  // already made — which is how "does not have workspace.edit" reached a user.
  // The bootstrap tenant does not exist until it is asked for, so nobody can
  // hold a membership in it, and a check that demanded one refused everybody.
  const createWorkspace = account.page.locator('button:has-text("Create Workspace")').first();
  check("the dashboard offers to create one", (await createWorkspace.count()) > 0);
  await createWorkspace.click();
  await sleep(2_500);
  const workspaceName = `eco-ws-${RUN_ID}`;
  await account.page.locator("[data-base-ui-portal] input").first().fill(workspaceName);
  await sleep(500);
  await account.page
    .locator('[data-slot="dialog-footer"] button:has-text("Create")')
    .first()
    .click();
  await sleep(7_000);
  const afterCreate = await bodyText(account.page);
  check(
    "it is not refused for a permission nobody could hold",
    !/does not have workspace\.edit/.test(afterCreate),
    /Forbidden[^]{0,80}/.exec(afterCreate)?.[0]?.replace(/\s+/g, " ") ?? "",
  );
  check("the workspace appears on the dashboard", afterCreate.includes(workspaceName));

  phase("Before anything is turned on");
  check(
    "the dashboard links to infrastructure",
    (await account.page.locator('[data-testid="dashboard-workspace-infra-link"]').count()) === 1,
  );
  await account.page.locator('[data-testid="dashboard-workspace-infra-link"]').first().click();
  await sleep(8_000);
  check(
    "infrastructure says nothing is on",
    (await account.page.locator('[data-testid="infra-empty"]').count()) === 1,
  );
  check(
    "and says what turning one on would and would not do",
    (await bodyText(account.page)).includes("does not install anything"),
  );

  phase("Publishing refuses a pack with nothing behind it");
  await goHome(account.page);
  await account.page.locator('[data-testid="dashboard-workspace-publish-pack"]').first().click();
  await sleep(2_500);
  check(
    "the publish dialog opens",
    (await account.page.locator('[data-testid="publish-pack-dialog"]').count()) === 1,
  );
  await account.page
    .locator('[data-testid="publish-pack-summary"]')
    .fill("Ships a service to a host over ssh");
  await account.page.locator('[data-testid="publish-pack-handover"]').fill("TODO");
  await account.page.locator('[data-testid="publish-pack-confirm"]').click();
  await sleep(1_500);
  // The one thing nobody else can supply, so it is the one thing not generated.
  check(
    "a placeholder handover is refused",
    (await account.page.locator('[data-testid="publish-pack-problem"]').count()) > 0,
  );
  check("and nothing was published", !/\/pack\//.test(account.page.url()), account.page.url());

  phase("Publishing a pack that declares what it needs");
  await account.page
    .locator('[data-testid="publish-pack-handover"]')
    .fill(
      "Built the ship-and-start path and the health check. Tried pkill and it killed the deploy session. Rollback is not done.",
    );
  await account.page
    .locator('[data-testid="publish-pack-requirements"]')
    .fill("DEPLOY_HOST\nDEPLOY_TOKEN!");
  await account.page.locator('[data-testid="publish-pack-confirm"]').click();
  await sleep(10_000);
  check("it lands on the pack's own page", /\/pack\//.test(account.page.url()), account.page.url());

  phase("The pack page reads a real pack");
  const signature = account.page.locator('[data-testid="pack-detail-signature"]').first();
  check("the page shows a signature verdict", (await signature.count()) === 1);
  // A pack published this way has not been signed, and the page must say so
  // rather than showing a tick.
  check(
    "and says it is unsigned, because it is",
    (await signature.getAttribute("data-state")) === "unsigned",
    (await signature.getAttribute("data-state")) ?? "none",
  );
  check(
    "it offers a link to share",
    (await account.page.locator('[data-testid="pack-detail-share"]').count()) === 1,
  );
  check(
    "it says what deploying it would take",
    (await account.page.locator('[data-testid="pack-detail-deploy"]').count()) === 1,
  );

  phase("Turning it on for a project");
  check(
    "the page offers to use it in a project",
    (await account.page.locator('[data-testid="pack-detail-enable"]').count()) === 1,
  );
  const project = account.page.locator('[data-testid="pack-enable-project"]').first();
  check("a project can be chosen", (await project.count()) > 0);
  await project.click();
  await sleep(800);
  await account.page.locator('[data-testid="pack-enable-confirm"]').click();
  await sleep(9_000);
  check(
    "it lands on that project's infrastructure",
    /\/infra\//.test(account.page.url()),
    account.page.url(),
  );

  phase("What the project still owes");
  const enablements = account.page.locator('[data-testid="infra-enablement"]');
  check(
    "the pack is listed",
    (await enablements.count()) === 1,
    `${await enablements.count()} listed`,
  );
  check(
    "it is not reported as ready",
    (await enablements.first().getAttribute("data-ready")) === "false",
    (await enablements.first().getAttribute("data-ready")) ?? "none",
  );
  const readiness = await account.page
    .locator('[data-testid="infra-readiness"]')
    .first()
    .innerText();
  check("it counts what the project must supply", readiness.includes("Needs 2 things"), readiness);
  const missing = await account.page.locator('[data-testid="infra-missing"]').first().innerText();
  check(
    "and names both, including the secret",
    missing.includes("DEPLOY_HOST") && missing.includes("DEPLOY_TOKEN"),
    missing.replace(/\s+/g, " ").slice(0, 90),
  );

  phase("Turning it off again");
  await account.page.locator('[data-testid="infra-disable"]').first().click();
  await sleep(6_000);
  check(
    "the project has nothing on again",
    (await account.page.locator('[data-testid="infra-enablement"]').count()) === 0,
  );

  phase("Result");
  console.log(`  workspace: ${PROJECT_DIR}`);
} finally {
  await browser.close();
  if (!KEEP) rmSync(PROJECT_DIR, { recursive: true, force: true });
}

process.exit(finish());
