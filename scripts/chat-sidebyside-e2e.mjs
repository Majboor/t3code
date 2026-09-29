#!/usr/bin/env node
// Two people in one project, side by side: does every message wear its
// author's name and colour in *both* browsers, and does that survive sessions
// opened later — the case that used to come and go?
//
//   bun run dev                      # in another terminal
//   node scripts/chat-sidebyside-e2e.mjs
//
//   T3_E2E_BASE_URL        the web app     (default http://localhost:5733)
//   T3_E2E_SESSIONS        extra fresh sessions to open afterwards (default 3)
//   T3_E2E_KEEP_WORKSPACE  keep the folder
//
// Every account, folder and message is created fresh for the run. The agent
// is told to answer with one word and touch nothing, so a helpful model cannot
// turn an attribution check into a race over files.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const RUN_ID = String(Date.now());
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const PROJECT_DIR = path.join(
  existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(),
  `t3-chat-${RUN_ID}`,
);
const PASSWORD = "SideBySide!2026";
const ACCOUNT_A = `sbs.a.${RUN_ID}@example.test`;
const ACCOUNT_B = `sbs.b.${RUN_ID}@example.test`;
const EXTRA_SESSIONS = Math.max(0, Number(process.env["T3_E2E_SESSIONS"] ?? 3));
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";
const SETTLE_MS = 8_000;

const { phase, check, finish } = createReporter();
const harness = createHarness({ baseUrl: BASE_URL, password: PASSWORD });
const { signUp, logIn, addProject, sendAgentMessage, createInvite, dismissFirstRunOverlays } = harness;

function displayNameFor(email) {
  return email
    .split("@")[0]
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Chat E2E",
      GIT_AUTHOR_EMAIL: "chat@example.test",
      GIT_COMMITTER_NAME: "Chat E2E",
      GIT_COMMITTER_EMAIL: "chat@example.test",
    },
  }).trim();
}

const prompt = (who, n = 0) =>
  `hello from ${who}${n ? ` #${n}` : ""} ${RUN_ID}. Reply with one word. Do not create or change any files.`;

/** Walks in through the dashboard so the thread is the project's, not a draft. */
async function reachProject(page, timeoutMs = 120_000) {
  const link = page.locator('[data-testid="dashboard-workspace-project-link"]').first();
  const deadline = Date.now() + timeoutMs;
  let reloaded = false;
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Every fresh account meets the onboarding questionnaire and the product
  // tour, and both sit over the dashboard. An invited colleague is a fresh
  // account too — they never went through `addProject`, which is the only
  // other place these were cleared.
  await dismissFirstRunOverlays(page);
  while (Date.now() < deadline) {
    if ((await link.count().catch(() => 0)) > 0) {
      // Not `.catch(() => undefined)` followed by `return true`: a click that
      // an overlay swallowed used to report the project as reached, and the
      // failure surfaced much later as "no composer on the page".
      const clicked = await link
        .click({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        await sleep(SETTLE_MS);
        return true;
      }
      await dismissFirstRunOverlays(page);
    }
    await sleep(2_500);
    if (!reloaded && Date.now() > deadline - timeoutMs / 2) {
      reloaded = true;
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
  }
  return false;
}

/** Every human message on the page, with what the label and the bubble say about its author. */
async function userMessages(page) {
  return page
    .locator('[data-timeline-row-kind="message"][data-message-role="user"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const label = node.querySelector('[data-testid="message-author"]');
        const bubble = node.querySelector("[data-author-color]");
        const avatar = label?.querySelector("[style]");
        return {
          text: (node.textContent ?? "").trim(),
          authorName: label?.getAttribute("data-author-name") ?? null,
          known: label?.getAttribute("data-author-known") === "true",
          bubbleColor: bubble?.getAttribute("data-author-color") ?? null,
          avatarColor: avatar ? getComputedStyle(avatar).backgroundColor : null,
        };
      }),
    );
}

const findMessage = (messages, text) => messages.find((m) => m.text.includes(text)) ?? null;

function checkAttribution(reader, message, who, email) {
  const found = message !== null;
  check(`${reader} sees ${who}'s message`, found);
  if (!found) return null;
  check(
    `${reader} sees ${who}'s message under ${who}'s name`,
    message.authorName === displayNameFor(email) && message.known,
    `labelled ${message.authorName ?? "nothing"}${message.known ? "" : " (provisional)"}`,
  );
  check(
    `${reader} sees ${who}'s message coloured like ${who}'s avatar`,
    Boolean(message.bubbleColor) && Boolean(message.avatarColor),
    `bubble ${message.bubbleColor ?? "none"}, avatar ${message.avatarColor ?? "none"}`,
  );
  return message.bubbleColor;
}

/** Polls the page text until it matches, instead of guessing how long a busy host takes. */
async function waitForBody(page, pattern, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await bodyText(page);
    if (pattern.test(seen)) return seen;
    await sleep(2_000);
  }
  return seen;
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

const browser = await chromium.launch({ headless: true });
const accountA = await openIsolatedSession(browser, "A");
const accountB = await openIsolatedSession(browser, "B");
const extras = [];

try {
  phase("Two accounts and one shared folder, all made at run time");
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(path.join(PROJECT_DIR, "README.md"), `# chat ${RUN_ID}\n`);
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "seed");
  check("A signs up", await signUp(accountA, ACCOUNT_A), ACCOUNT_A);
  await addProject(accountA.page, PROJECT_DIR);
  const folderName = path.basename(PROJECT_DIR);
  const listing = await waitForBody(accountA.page, new RegExp(folderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  check(
    "A's workspace lists the folder",
    listing.includes(folderName),
    listing.includes(folderName) ? "" : `page says: ${listing.replace(/\s+/g, " ").slice(0, 140)}`,
  );
  const invite = await createInvite(accountA.page, ACCOUNT_B);
  check("A gets an invite link for B", invite !== null, invite ?? "");
  check("B signs up", await signUp(accountB, ACCOUNT_B), ACCOUNT_B);
  if (invite) {
    await accountB.page.goto(invite, { waitUntil: "domcontentloaded", timeout: 60_000 });
    check(
      "B joins from the link",
      (await waitForBody(accountB.page, /Invite accepted|Could not accept|failed/i, 120_000)).includes("Invite accepted"),
    );
    await accountB.page.locator('button:has-text("Back to app")').first().click().catch(() => undefined);
    await sleep(5_000);
  }

  phase("Side by side: each says hello");
  check("A opens the project", await reachProject(accountA.page));
  check("B opens the project", await reachProject(accountB.page));
  check("A sends hello", await sendAgentMessage(accountA.page, prompt("A")));
  await sleep(SETTLE_MS);
  check("B sends hello", await sendAgentMessage(accountB.page, prompt("B")));
  await sleep(SETTLE_MS);

  phase("What each of them sees, without opening any panel");
  const colours = {};
  for (const [reader, session] of [
    ["A", accountA],
    ["B", accountB],
  ]) {
    await reachProject(session.page);
    await sleep(6_000);
    const seen = await userMessages(session.page);
    colours[`${reader}:A`] = checkAttribution(reader, findMessage(seen, prompt("A")), "A", ACCOUNT_A);
    colours[`${reader}:B`] = checkAttribution(reader, findMessage(seen, prompt("B")), "B", ACCOUNT_B);
  }
  check(
    "both browsers agree on A's colour",
    colours["A:A"] !== null && colours["A:A"] === colours["B:A"],
    `${colours["A:A"]} vs ${colours["B:A"]}`,
  );
  check(
    "both browsers agree on B's colour",
    colours["A:B"] !== null && colours["A:B"] === colours["B:B"],
    `${colours["A:B"]} vs ${colours["B:B"]}`,
  );
  check(
    "A and B are drawn in different colours",
    colours["A:A"] !== null && colours["A:A"] !== colours["A:B"],
    `${colours["A:A"]} vs ${colours["A:B"]}`,
  );

  phase(`${EXTRA_SESSIONS} fresh sessions later, the names are still there`);
  for (let i = 1; i <= EXTRA_SESSIONS; i += 1) {
    const who = i % 2 === 1 ? "A" : "B";
    const email = who === "A" ? ACCOUNT_A : ACCOUNT_B;
    const session = await openIsolatedSession(browser, `${who}#${i}`);
    extras.push(session);
    check(`session ${i}: ${who} logs in again from a clean browser`, await logIn(session, email));
    check(`session ${i}: reaches the project`, await reachProject(session.page));
    await sleep(6_000);
    const seen = await userMessages(session.page);
    const a = findMessage(seen, prompt("A"));
    const b = findMessage(seen, prompt("B"));
    check(
      `session ${i}: every earlier message is named on first paint`,
      Boolean(a?.known && b?.known) &&
        a?.authorName === displayNameFor(ACCOUNT_A) &&
        b?.authorName === displayNameFor(ACCOUNT_B),
      `A→${a?.authorName ?? "nothing"} B→${b?.authorName ?? "nothing"}`,
    );
    check(`session ${i}: ${who} sends another hello`, await sendAgentMessage(session.page, prompt(who, i)));
    await sleep(SETTLE_MS);
    // The other original browser is still sitting on the thread: the new
    // message must arrive there wearing the right name, live.
    const other = who === "A" ? accountB : accountA;
    const otherName = who === "A" ? "B" : "A";
    await reachProject(other.page);
    let live = null;
    for (let attempt = 0; attempt < 15 && !live; attempt += 1) {
      live = findMessage(await userMessages(other.page), prompt(who, i));
      if (!live) await sleep(2_000);
    }
    check(
      `session ${i}: ${otherName}'s browser names the newcomer's message`,
      live?.known === true && live.authorName === displayNameFor(email),
      `labelled ${live?.authorName ?? "nothing"}`,
    );
  }
} finally {
  phase("Result");
  for (const session of [accountA, accountB, ...extras]) {
    if (session.consoleErrors.length > 0) {
      console.log(`  ${session.label} console errors: ${session.consoleErrors.slice(0, 3).join(" | ")}`);
    }
    await session.context.close().catch(() => undefined);
  }
  await browser.close().catch(() => undefined);
  if (!KEEP) {
    rmSync(PROJECT_DIR, { recursive: true, force: true });
    unlistProject(PROJECT_DIR);
  }
  process.exit(finish());
}
