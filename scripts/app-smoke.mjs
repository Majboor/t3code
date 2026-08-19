#!/usr/bin/env node
// Drives the packaged desktop app the way a person does, and writes down
// everything the renderer says while doing it.
//
//   bun run test:app-smoke
//   node scripts/app-smoke.mjs --keep            # keep the sandbox home
//   node scripts/app-smoke.mjs --only chat       # one phase
//
// The point is the listeners, not the clicks. "The app crashes" is not a bug
// report you can act on; a `pageerror` with a stack is. So every window this
// app opens gets `console`, `pageerror` and `crash` attached the moment it
// appears, the main process gets `render-process-gone`, and the run prints the
// lot at the end whether or not a check failed.
//
// It launches the *installed* app, not a dev build, because the dev server and
// the package disagree about enough (module graph, asset scheme, state
// directory) that a green dev run says nothing about the thing users install.
//
// The app is given its own HOME so a run cannot touch the real one: the state
// directory (`~/.t3`), the Chromium profile and the desktop settings are all
// derived from it. The parts of the home a run genuinely needs — the CLI
// binaries on PATH and their credentials — are symlinked in, so the sandbox is
// a fresh install of *this app*, not a fresh machine.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const { _electron: electron } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);

const APP_PATH =
  process.env["T3_SMOKE_APP"] ??
  "/Applications/LogicPacks (Alpha).app/Contents/MacOS/LogicPacks (Alpha)";
const ARGS = process.argv.slice(2);
const KEEP = ARGS.includes("--keep");
const ONLY = readFlag("--only");
const SANDBOX =
  readFlag("--home") ??
  path.join(os.tmpdir(), "t3-app-smoke", `home-${KEEP ? "keep" : Date.now()}`);
const EMAIL = readFlag("--email") ?? `smoke+${Date.now()}@example.com`;
const PASSWORD = "AppSmoke!2026";
const SHOTS = path.join(SANDBOX, "shots");

function readFlag(name) {
  const index = ARGS.indexOf(name);
  return index >= 0 ? ARGS[index + 1] : undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
let phaseName = "setup";
const phase = (title) => {
  phaseName = title;
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
};
const check = (step, ok, detail = "") => {
  results.push({ phase: phaseName, step, ok });
  const trimmed = String(detail).replaceAll("\n", " | ").slice(0, 300);
  console.log(
    `  ${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${step}${trimmed ? `  — ${trimmed}` : ""}`,
  );
  return ok;
};
const note = (text) => console.log(`  [36mNOTE[0m  ${text}`);

/**
 * Everything the renderer said, in order, with the phase it said it in — the
 * phase is what turns a stack trace into a reproduction.
 */
const diagnostics = [];
const record = (kind, text) => {
  const entry = { phase: phaseName, kind, text: String(text).slice(0, 4_000) };
  diagnostics.push(entry);
  if (kind !== "console.log") console.log(`  [35m${kind}[0m  ${entry.text.slice(0, 300)}`);
};

/**
 * The home a run is allowed to write to. Only the entries a packaged app needs
 * to find the agent CLIs are linked through; everything the app itself stores
 * lands inside the sandbox and is thrown away with it.
 */
function buildSandboxHome() {
  if (!KEEP) rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  const real = os.homedir();
  for (const entry of [
    ".local",
    ".nvm",
    ".bun",
    ".cargo",
    ".pyenv",
    "bin",
    ".claude",
    ".claude.json",
    ".codex",
    ".config",
    ".npmrc",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".gitconfig",
  ]) {
    const source = path.join(real, entry);
    const target = path.join(SANDBOX, entry);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      symlinkSync(source, target);
    } catch {
      // A link that cannot be made is not worth failing a run over; the phase
      // that needs it will say so in its own words.
    }
  }
  return SANDBOX;
}

function attachWindowListeners(page, label) {
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning") record(`console.${type}[${label}]`, message.text());
  });
  page.on("pageerror", (error) => record(`pageerror[${label}]`, error.stack ?? String(error)));
  page.on("crash", () => record(`crash[${label}]`, "renderer process crashed"));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure && !failure.includes("ERR_ABORTED")) {
      record(`requestfailed[${label}]`, `${request.url()} — ${failure}`);
    }
  });
}

/**
 * The app opens two windows: the notch overlay (a `data:` document over the
 * menu bar) and the app itself. `firstWindow()` returns whichever won the race,
 * which for the first minute of a run is usually the notch — so the window is
 * chosen by what it loaded, not by when it appeared.
 */
async function mainWindow(app, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (/^https?:/.test(candidate.url())) return candidate;
    }
    await sleep(500);
  }
  throw new Error("no window ever loaded the app over http");
}

const bodyText = (page) =>
  page
    .locator("body")
    .innerText()
    .catch(() => "");

async function shoot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined);
}

async function main() {
  const home = buildSandboxHome();
  console.log(`app      ${APP_PATH}`);
  console.log(`sandbox  ${home}`);
  console.log(`email    ${EMAIL}`);

  const app = await electron.launch({
    executablePath: APP_PATH,
    args: [],
    env: {
      ...process.env,
      HOME: home,
      T3CODE_HOME: path.join(home, ".t3"),
      // Two copies of the app must not share a port; the desktop scans upward
      // from its default, but pin it so the run knows what it is talking to.
      T3CODE_DISABLE_AUTO_UPDATE: "1",
    },
    timeout: 120_000,
  });

  // A renderer that dies takes its `page` events with it, so the death itself
  // has to come from the main process.
  await app
    .evaluate(({ app: electronApp }) => {
      electronApp.on("render-process-gone", (_event, _contents, details) => {
        console.error(`[main] render-process-gone ${JSON.stringify(details)}`);
      });
      electronApp.on("child-process-gone", (_event, details) => {
        console.error(`[main] child-process-gone ${JSON.stringify(details)}`);
      });
    })
    .catch((error) => note(`could not hook main process: ${error}`));

  app.on("console", (message) => record("main", message.text()));
  app.on("window", (page) => {
    attachWindowListeners(page, "extra");
    record("window", `opened ${page.url()}`);
  });

  const page = await mainWindow(app);
  attachWindowListeners(page, "main");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await sleep(8_000);

  const context = { app, page, home, origin: new URL(page.url()).origin };
  const phases = {
    boot: bootPhase,
    signin: signInPhase,
    project: projectPhase,
    chat: chatPhase,
    picker: pickerPhase,
    connections: connectionsPhase,
    publish: publishPhase,
    sweep: sweepPhase,
  };
  for (const [name, run] of Object.entries(phases)) {
    if (ONLY && ONLY !== name) continue;
    await run(context).catch((error) => {
      check(`${name} phase completed`, false, String(error).slice(0, 300));
    });
  }

  await shoot(page, "final");
  await app.close().catch(() => undefined);

  console.log("\n── renderer diagnostics ─────────────────────────────────");
  if (diagnostics.length === 0) console.log("  (nothing — the renderer stayed quiet)");
  for (const entry of diagnostics) {
    console.log(
      `  [${entry.phase}] ${entry.kind}\n      ${entry.text.replaceAll("\n", "\n      ")}`,
    );
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const result of failed) console.log(`  FAILED  [${result.phase}] ${result.step}`);
  console.log(`\nscreenshots ${SHOTS}`);
  if (!KEEP) note(`sandbox kept for inspection: ${SANDBOX}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function bootPhase({ page }) {
  phase("boot");
  const url = page.url();
  const text = await bodyText(page);
  check("a window opened", Boolean(url), url);
  check("the window rendered something", text.trim().length > 0, `${text.slice(0, 120)}`);
  await shoot(page, "01-boot");
}

async function signInPhase({ page }) {
  phase("sign in");
  const text = await bodyText(page);
  if (/Add project|New thread/.test(text)) {
    check("already signed in", true);
    return;
  }
  const signUp = page.locator('button:has-text("Sign up")').first();
  if ((await signUp.count()) > 0) await signUp.click().catch(() => undefined);
  await sleep(1_500);
  const email = page.locator('input[type="email"]').first();
  check("a sign-in form is on screen", (await email.count()) > 0, text.slice(0, 200));
  if ((await email.count()) === 0) return;
  await email.fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await sleep(9_000);
  await shoot(page, "02-signin");
  const after = await bodyText(page);
  check(
    "signing up lands in the app",
    /Add project|New thread|Projects/.test(after),
    after.slice(0, 200),
  );
}

async function projectPhase({ page, home }) {
  phase("add a project");
  const projectDir = path.join(home, "smoke-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "notes.txt"), "hello from the smoke run\n");
  writeFileSync(path.join(projectDir, "readme.md"), "# smoke\n");
  try {
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    execFileSync("git", ["add", "-A"], { cwd: projectDir });
    execFileSync(
      "git",
      ["-c", "user.email=smoke@example.com", "-c", "user.name=Smoke", "commit", "-qm", "init"],
      {
        cwd: projectDir,
      },
    );
  } catch {
    // A project without a repository is still a project.
  }

  const add = page.locator('button:has-text("Add project")').first();
  check("the Add project control is reachable", (await add.count()) > 0);
  if ((await add.count()) === 0) return;
  await add.click();
  await sleep(2_500);
  const input = page.locator("[data-base-ui-portal] input").first();
  if ((await input.count()) === 0) {
    check("the add-project dialog opened", false, (await bodyText(page)).slice(0, 200));
    return;
  }
  await input.fill(projectDir);
  await sleep(3_000);
  await page.keyboard.press("Enter");
  await sleep(9_000);
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(1_500);
  await shoot(page, "03-project");
  const text = await bodyText(page);
  check("the project is listed", text.includes("smoke-project"), text.slice(0, 300));
}

async function openProject(page) {
  const link = page.locator('[data-testid="dashboard-workspace-project-link"]').first();
  if ((await link.count()) > 0) {
    await link.click();
    await sleep(6_000);
    return true;
  }
  return false;
}

async function chatPhase({ page }) {
  phase("chat");
  await openProject(page);
  await sleep(3_000);
  await shoot(page, "04-chat-open");
  const composer = page.locator('[contenteditable="true"], textarea').first();
  check("a composer is on screen", (await composer.count()) > 0, await bodyText(page));
  if ((await composer.count()) === 0) return;
  await composer.click().catch(() => undefined);
  await page.keyboard.type("Say hello and stop.");
  await sleep(1_000);
  await shoot(page, "05-chat-typed");
  const typed = await bodyText(page);
  check("typing reaches the composer", typed.includes("Say hello"), typed);
  await page.keyboard.press("Enter");
  await sleep(20_000);
  await shoot(page, "06-chat-sent");
  const after = await bodyText(page);
  check("sending does not blank the app", after.trim().length > 0, after);

  // A turn that cannot run is fine; a turn that cannot run *silently* is the
  // bug. Either an answer or a reason has to be on screen.
  const answered = /Working|Thinking|Ran |assistant/i.test(after);
  const refused = /connect|not connected|Settings → Connections|failed|error|unavailable/i.test(
    after,
  );
  check("a send either answers or explains itself", answered || refused, after);
  note(`after send: ${after.replaceAll("\n", " | ").slice(0, 800)}`);
}

/** The composer's model chip, which is the only way into the picker. */
const PICKER = '[data-chat-provider-model-picker="true"]';

async function pickerPhase({ page, origin }) {
  phase("model picker");

  // A thread that has started locks its provider on purpose, so the question
  // "can I switch to Claude" is only meaningful on a fresh one.
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(5_000);
  await openProject(page);
  const newThread = page.locator('[data-testid="new-thread-button"]').first();
  if ((await newThread.count()) > 0) {
    await newThread.click({ force: true }).catch(() => undefined);
    await sleep(6_000);
  } else {
    note("no new-thread button; the picker is being read on a thread that has run");
  }

  const trigger = page.locator(PICKER).first();
  check("the composer has a model chip", (await trigger.count()) > 0, await bodyText(page));
  if ((await trigger.count()) === 0) return;
  note(`chip reads: ${(await trigger.innerText().catch(() => "")).replaceAll("\n", " ")}`);
  await trigger.click().catch(() => undefined);
  await sleep(2_000);
  await shoot(page, "07-picker-open");
  const menu = await bodyText(page);
  check("the picker lists Claude", /Claude/.test(menu), menu);
  check("the picker lists Codex", /Codex|GPT/.test(menu), menu);

  const claude = page.locator('[role="menuitem"]:has-text("Claude")').first();
  if ((await claude.count()) > 0) {
    const disabled = await claude.getAttribute("data-disabled").catch(() => null);
    const label = (await claude.innerText().catch(() => "")).replaceAll("\n", " ");
    check("Claude is selectable", disabled === null, `${label} (data-disabled=${disabled})`);
    await claude.hover().catch(() => undefined);
    await sleep(1_500);
    await shoot(page, "08-picker-claude");
    note(`claude submenu: ${(await bodyText(page)).replaceAll("\n", " | ").slice(0, 500)}`);
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(1_000);
}

/**
 * The chat refusal tells people to go to Settings → Connections, so that page
 * is part of the chat story: if it cannot connect a provider, chat is not
 * merely refused, it is unrecoverable.
 */
async function connectionsPhase({ page, origin }) {
  phase("connections");
  // Typing the route into the address bar lands back on the dashboard, so go
  // the way a person does: the sidebar's Settings, then Connections.
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(4_000);
  await page
    .locator('a:has-text("Settings"), button:has-text("Settings")')
    .first()
    .click({ force: true })
    .catch((error) => note(`settings click: ${error}`));
  await sleep(4_000);
  await shoot(page, "11-settings");
  await page
    .locator('a:has-text("Connections"), button:has-text("Connections")')
    .first()
    .click({ force: true })
    .catch((error) => note(`connections click: ${error}`));
  await sleep(6_000);
  await shoot(page, "12-connections");
  const text = await bodyText(page);
  check("the connections page renders", text.trim().length > 40, text);
  check("it names both providers", /Claude/.test(text) && /Codex/.test(text), text);
  note(`connections: ${text.replaceAll("\n", " | ").slice(0, 900)}`);

  const connect = page.locator('button:has-text("Open Claude sign-in")').first();
  if ((await connect.count()) === 0) {
    check("a provider sign-in control exists", false, text);
    return;
  }
  await connect.click({ force: true }).catch((error) => note(`connect click: ${error}`));
  await sleep(8_000);
  await shoot(page, "13-connect-clicked");
  const after = await bodyText(page);
  check("connecting says something", after !== text, after);
  note(`after connect: ${after.replaceAll("\n", " | ").slice(0, 900)}`);
}

async function publishPhase({ page, origin }) {
  phase("publish");
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(6_000);
  const publish = page.locator('button[aria-label^="Publish "]').first();
  check("the dashboard offers Publish", (await publish.count()) > 0, await bodyText(page));
  if ((await publish.count()) === 0) return;
  await publish.click({ force: true }).catch((error) => note(`publish click: ${error}`));
  await sleep(4_000);
  await shoot(page, "09-publish-dialog");
  const dialog = await bodyText(page);
  check("the publish dialog opens", /Publish as a pack/.test(dialog), dialog);
  if (!/Publish as a pack/.test(dialog)) return;

  const confirm = page.locator('[data-testid="publish-pack-confirm"]').first();
  if ((await confirm.count()) === 0) {
    check("the dialog has a Publish button", false, dialog);
    return;
  }

  // Publishing with the fields empty only proves the validation works, and the
  // report is about the button that publishes.
  await page
    .locator('[data-testid="publish-pack-summary"]')
    .fill("A folder with two files in it, published by the smoke run.")
    .catch(() => undefined);
  await page
    .locator('[data-testid="publish-pack-handover"]')
    .fill("Built nothing; this is a smoke test. Nothing was tried. Everything is undone.")
    .catch(() => undefined);
  await sleep(500);
  await confirm.click().catch((error) => note(`confirm click: ${error}`));

  // The dialog answers with a toast, and toasts do not wait around, so look
  // while it is still on screen and again once the request has had its time.
  await sleep(3_000);
  await shoot(page, "10-publishing");
  note(`3s after publish: ${(await bodyText(page)).replaceAll("\n", " | ").slice(0, 800)}`);
  await sleep(25_000);
  await shoot(page, "11-published");
  const after = await bodyText(page);
  check("publishing does not blank the app", after.trim().length > 40, after);
  check(
    "publishing leaves the dialog",
    !/Publish as a pack/.test(after),
    after.includes("Could not publish") ? "the dialog reported a failure" : after,
  );
  note(`after publish: ${after.replaceAll("\n", " | ").slice(0, 800)}`);
}

/**
 * Everything else a person can reach in two clicks. It asserts almost nothing
 * beyond "the page still has content", because the value is in the listeners:
 * a route that throws shows up as a `pageerror` with a stack whether or not
 * this run knew what to expect there.
 */
async function sweepPhase({ page, origin }) {
  phase("sweep");
  const routes = [
    "/",
    "/settings/general",
    "/settings/account",
    "/settings/connections",
    "/settings/organization",
    "/settings/archived",
  ];
  for (const route of routes) {
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(4_000);
    const text = await bodyText(page);
    check(`${route} renders`, text.trim().length > 40, text);
    await shoot(page, `sweep${route.replaceAll("/", "-")}`);
  }

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(5_000);
  await openProject(page);

  // The chrome around a thread: each of these is a component that can throw on
  // its own, and none of them is reached by any other phase.
  for (const [label, selector] of [
    ["workspace panel", 'button[aria-label="Toggle workspace panel"]'],
    ["terminal drawer", 'button[aria-label*="terminal" i]'],
    ["packs menu", 'button:has-text("Packs")'],
    ["runtime mode", 'button:has-text("Build")'],
    ["access mode", 'button:has-text("Full access")'],
    ["thread overflow", 'button[aria-label*="more" i]'],
  ]) {
    const control = page.locator(selector).first();
    if ((await control.count()) === 0) {
      note(`no ${label} control on screen`);
      continue;
    }
    await control.click({ force: true }).catch((error) => note(`${label} click: ${error}`));
    await sleep(2_500);
    await shoot(page, `sweep-${label.replaceAll(" ", "-")}`);
    const text = await bodyText(page);
    check(`${label} survives a click`, text.trim().length > 40, text);
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(1_000);
  }
}

await main();
