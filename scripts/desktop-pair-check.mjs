#!/usr/bin/env node
// Launches the desktop app headlessly (Linux, under Xvfb) and pairs it with a
// remote LogicPacks server: Settings → Connections → Add environment → paste
// the pairing link → Connect. Then asks whether the remote's project shows up.
//
//   T3_SMOKE_APP      the app launcher (default: apps/desktop/logicpacks-linux.sh)
//   T3_REMOTE_URL     the remote server (default http://127.0.0.1:3773)
//   T3_REMOTE_HOME    the remote server's base dir, for minting a token + adding a project
//   T3_SHOTS_DIR      screenshots (default /root/runs/desktop)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createReporter, sleep } from "./lib/e2e-harness.mjs";

const { _electron: electron } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const APP = process.env["T3_SMOKE_APP"] ?? path.join(REPO, "apps/desktop/logicpacks-linux.sh");
const REMOTE_URL = process.env["T3_REMOTE_URL"] ?? "http://127.0.0.1:3773";
const REMOTE_HOME = process.env["T3_REMOTE_HOME"] ?? "/srv/t3/data";
const SHOTS = process.env["T3_SHOTS_DIR"] ?? "/root/runs/desktop";
const RUN_ID = String(Date.now());
const SANDBOX = path.join(os.tmpdir(), "t3-pair-check", `home-${RUN_ID}`);
const REMOTE_PROJECT = path.join(os.tmpdir(), `t3-remote-project-${RUN_ID}`);
const { phase, check, finish } = createReporter();

mkdirSync(SHOTS, { recursive: true });
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
for (const entry of [".gitconfig", ".nvm", ".bun", "bin"]) {
  const source = path.join(os.homedir(), entry);
  if (existsSync(source) && !existsSync(path.join(SANDBOX, entry))) {
    try {
      symlinkSync(source, path.join(SANDBOX, entry));
    } catch {}
  }
}
const shoot = (page, name) =>
  page.screenshot({ path: path.join(SHOTS, `pair-${name}.png`) }).catch(() => undefined);

function remoteCli(args) {
  return execFileSync(
    "node",
    [path.join(REPO, "apps/server/dist/bin.mjs"), ...args, "--base-dir", REMOTE_HOME],
    { cwd: path.join(REPO, "apps/server"), encoding: "utf8", env: { ...process.env, T3CODE_HOME: REMOTE_HOME }, timeout: 120_000 },
  );
}

phase("A project on the remote server, and a pairing link for it");
mkdirSync(REMOTE_PROJECT, { recursive: true });
writeFileSync(path.join(REMOTE_PROJECT, "README.md"), `# remote ${RUN_ID}\n`);
execFileSync("git", ["init", "--initial-branch=main"], { cwd: REMOTE_PROJECT });
let addedProject = "";
try {
  addedProject = remoteCli(["project", "add", REMOTE_PROJECT]);
} catch (error) {
  addedProject = String(error?.stdout ?? "") + String(error?.stderr ?? "");
}
check("the remote server lists a project for the run", /added|Added|project/i.test(addedProject), addedProject.replace(/\s+/g, " ").slice(0, 120));
const minted = remoteCli(["auth", "pairing", "create"]);
const token = /Token:\s*(\S+)/.exec(minted)?.[1] ?? null;
check("a pairing token is minted", token !== null, token ?? minted.slice(0, 120));
const pairingUrl = `${REMOTE_URL}/pair#token=${token}`;

phase("The desktop app starts under Xvfb");
let app = null;
let page = null;
try {
  const launchOptions = {
    executablePath: APP,
    args: [],
    env: { ...process.env, HOME: SANDBOX, T3CODE_HOME: path.join(SANDBOX, ".t3"), T3CODE_DISABLE_AUTO_UPDATE: "1" },
    timeout: 60_000,
  };
  // Startup can hang reading a login shell, so launch is retried the way
  // app-smoke does it; a launch that needed a retry is written down.
  let launchError = null;
  for (let attempt = 1; attempt <= 4 && !app; attempt += 1) {
    try {
      app = await electron.launch(launchOptions);
      if (attempt > 1) console.log(`  note: the app only started on attempt ${attempt}`);
    } catch (error) {
      launchError = error;
    }
  }
  if (!app) throw launchError;
  // Two windows race: a data: document (notch overlay, or the "Connect this
  // machine" enrollment prompt) and the app itself. Pick the window by what it
  // loaded, and wave the enrollment prompt away when it shows.
  const errors = [];
  const deadlineWindows = Date.now() + 120_000;
  while (Date.now() < deadlineWindows && !page) {
    for (const candidate of app.windows()) {
      const u = candidate.url();
      if (/^https?:/.test(u)) {
        page = candidate;
      } else if (u.startsWith("data:")) {
        const notNow = candidate.locator('button:has-text("Not now")').first();
        if ((await notNow.count().catch(() => 0)) > 0) {
          await notNow.click().catch(() => undefined);
          console.log("  note: dismissed the enrollment prompt");
        }
      }
    }
    if (!page) await sleep(1_000);
  }
  if (!page) throw new Error("no window ever loaded the app over http");
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await sleep(10_000);
  const url = page.url();
  check("the app window is up", url.length > 0, url.slice(0, 80));
  await shoot(page, "01-start");
  const origin = url.startsWith("http") ? new URL(url).origin : null;
  check("the app serves its own local backend", origin !== null, origin ?? url);

  phase("Settings → Connections → Add environment");
  await page.goto(`${origin}/settings/connections`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(5_000);
  await shoot(page, "02-connections");
  const addButton = page.locator('button:has-text("Add environment")').first();
  check("there is an Add environment control", (await addButton.count()) > 0);
  await addButton.click().catch(() => undefined);
  await sleep(2_000);
  const linkInput = page.locator('input[placeholder^="https://my-laptop"]').first();
  if ((await linkInput.count()) === 0) {
    // Switch the segmented control to the pairing-link mode.
    const modes = page.locator('[aria-label="How you are connecting"] button');
    const n = await modes.count();
    for (let i = 0; i < n; i += 1) {
      await modes.nth(i).click().catch(() => undefined);
      await sleep(500);
      if ((await linkInput.count()) > 0) break;
    }
  }
  check("the pairing-link field is offered", (await linkInput.count()) > 0);
  await linkInput.fill(pairingUrl).catch(() => undefined);
  await page.locator("#add-environment-label").fill(`Remote ${RUN_ID}`).catch(() => undefined);
  await shoot(page, "03-form");
  await page.locator('button[type="submit"]').last().click().catch(() => undefined);
  const deadline = Date.now() + 60_000;
  let outcome = "";
  while (Date.now() < deadline) {
    const ok = page.locator('[data-testid="add-environment-success"]');
    const bad = page.locator('[data-testid="add-environment-failure"]');
    if ((await ok.count()) > 0) { outcome = `success: ${await ok.innerText().catch(() => "")}`; break; }
    if ((await bad.count()) > 0) { outcome = `failure: ${await bad.innerText().catch(() => "")}`; break; }
    await sleep(1_500);
  }
  await shoot(page, "04-after-connect");
  check("the remote environment connects", outcome.startsWith("success"), outcome.replace(/\s+/g, " ").slice(0, 160) || "no outcome within 60s");

  phase("What the app shows from the remote");
  await page.goto(`${origin}/environments`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(5_000);
  const rows = await page.locator('[data-testid="environment-row"]').allInnerTexts().catch(() => []);
  check("the environments page lists the remote", rows.some((r) => r.includes(`Remote ${RUN_ID}`)), rows.map((r) => r.replace(/\s+/g, " ").slice(0, 60)).join(" | "));
  await shoot(page, "05-environments");
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(8_000);
  const body = await page.locator("body").innerText().catch(() => "");
  check("the remote's project is on the dashboard", body.includes(path.basename(REMOTE_PROJECT)), body.replace(/\s+/g, " ").slice(0, 200));
  await shoot(page, "06-dashboard");
  const link = page.locator(`[data-testid="dashboard-workspace-project-link"]:has-text("${path.basename(REMOTE_PROJECT)}")`).first();
  if ((await link.count()) > 0) {
    await link.click().catch(() => undefined);
    await sleep(6_000);
    const composer = page.locator('[data-testid="composer-editor"], textarea').first();
    check("the remote project opens with a chat composer", (await composer.count()) > 0);
    await shoot(page, "07-remote-project");
  } else {
    check("the remote project opens with a chat composer", false, "no project link to click");
  }
  if (errors.length > 0) console.log(`  renderer errors: ${errors.slice(0, 4).join(" | ")}`);
} catch (error) {
  check("the desktop app run completed", false, String(error?.message ?? error).slice(0, 200));
} finally {
  await app?.close().catch(() => undefined);
  process.exit(finish());
}
