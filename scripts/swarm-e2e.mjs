#!/usr/bin/env node
// A swarm: many people doing the ordinary things at once — sign up, add a
// folder, share it, have somebody join, make a file, say something — and a
// tally of what held up and what did not.
//
//   node scripts/swarm-e2e.mjs
//
//   T3_E2E_BASE_URL        the web app          (default http://localhost:5733)
//   T3_SWARM_PAIRS         owner+guest pairs     (default 10; 50 pairs = 100 people)
//   T3_SWARM_CONCURRENCY   pairs running at once (default 5)
//   T3_SWARM_NO_AGENT=1    skip the chat message (no provider needed)
//   T3_E2E_KEEP_WORKSPACE  keep the folders
//
// Every pair is independent: its own accounts, its own folder, its own invite.
// Steps are timed, so a slow server shows up as numbers rather than as a
// timeout somebody has to interpret. Nothing here asserts on the server's
// internals — each check is what a person would have noticed.
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
  PERMISSION_ERROR,
  sleep,
  unlistProject,
} from "./lib/e2e-harness.mjs";

const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);

const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://localhost:5733";
const RUN_ID = String(Date.now());
const PAIRS = Math.max(1, Number(process.env["T3_SWARM_PAIRS"] ?? 10));
const CONCURRENCY = Math.max(1, Number(process.env["T3_SWARM_CONCURRENCY"] ?? 5));
const NO_AGENT = process.env["T3_SWARM_NO_AGENT"] === "1";
const KEEP = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const ROOT = existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir();
const PASSWORD = "Swarm!2026";

const { phase, check, finish } = createReporter();
const harness = createHarness({ baseUrl: BASE_URL, password: PASSWORD });
const { signUp, addProject, openProject, createFileViaUi, waitForFileInTree, sendAgentMessage, createInvite, acceptInvite } =
  harness;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Swarm E2E",
      GIT_AUTHOR_EMAIL: "swarm@example.test",
      GIT_COMMITTER_NAME: "Swarm E2E",
      GIT_COMMITTER_EMAIL: "swarm@example.test",
    },
  }).trim();
}

/** Per-step outcomes and timings across every pair. */
const steps = new Map();
function record(step, ok, ms, detail = "") {
  const entry = steps.get(step) ?? { ok: 0, failed: 0, durations: [], details: [] };
  if (ok) entry.ok += 1;
  else {
    entry.failed += 1;
    if (detail && entry.details.length < 3) entry.details.push(detail);
  }
  entry.durations.push(ms);
  steps.set(step, entry);
}
async function timed(step, run) {
  const started = Date.now();
  let ok = false;
  let detail = "";
  try {
    const result = await run();
    ok = result === true || (typeof result === "object" && result !== null && result.ok === true);
    if (!ok && typeof result === "object" && result !== null) detail = result.detail ?? "";
    else if (!ok && typeof result === "string") detail = result;
  } catch (error) {
    detail = String(error?.message ?? error).slice(0, 160);
  }
  record(step, ok, Date.now() - started, detail);
  return ok;
}
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function runPair(browser, index) {
  const tag = `${RUN_ID}-${index}`;
  const dir = path.join(ROOT, `t3-swarm-${tag}`);
  const owner = await openIsolatedSession(browser, `owner-${index}`);
  const guest = await openIsolatedSession(browser, `guest-${index}`);
  const ownerEmail = `swarm.o${index}.${RUN_ID}@example.test`;
  const guestEmail = `swarm.g${index}.${RUN_ID}@example.test`;
  const fileName = `note-${tag}.txt`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "README.md"), `# swarm ${tag}\n`);
    git(dir, "init", "--initial-branch=main");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "seed");

    if (!(await timed("owner signs up", () => signUp(owner, ownerEmail)))) return;
    if (
      !(await timed("owner adds the folder", async () => {
        await addProject(owner.page, dir);
        return (await bodyText(owner.page)).includes(path.basename(dir));
      }))
    )
      return;
    let invite = null;
    await timed("owner makes an invite link", async () => {
      invite = await createInvite(owner.page, guestEmail);
      return invite !== null;
    });
    if (!(await timed("guest signs up", () => signUp(guest, guestEmail)))) return;
    if (invite) {
      await timed("guest joins from the link", async () => {
        const { accepted, seen } = await acceptInvite(guest, invite);
        return accepted ? true : { ok: false, detail: seen.replace(/\s+/g, " ").slice(0, 120) };
      });
    }
    await timed("guest opens the shared project", async () => {
      const opened = await openProject(guest.page);
      const text = await bodyText(guest.page);
      return opened && !PERMISSION_ERROR.test(text)
        ? true
        : { ok: false, detail: PERMISSION_ERROR.exec(text)?.[0] ?? "did not open" };
    });
    await timed("owner opens the project", () => openProject(owner.page));
    await timed("owner creates a file in the tree", () => createFileViaUi(owner.page, fileName));
    await timed("guest sees the owner's file", async () => {
      const result = await waitForFileInTree(guest.page, fileName);
      return result.found ? true : { ok: false, detail: "never appeared" };
    });
    if (!NO_AGENT) {
      await timed("guest sends a message", () =>
        sendAgentMessage(
          guest.page,
          `swarm ${tag}: reply with one word. Do not create or change any files.`,
        ),
      );
      await sleep(4_000);
      await timed("the message is on the page with a name on it", async () => {
        const labels = await guest.page
          .locator('[data-message-role="user"] [data-testid="message-author"]')
          .count();
        return labels > 0 ? true : { ok: false, detail: "no author label" };
      });
    }
  } finally {
    record("console errors (owner+guest)", owner.consoleErrors.length + guest.consoleErrors.length === 0, 0,
      [...owner.consoleErrors, ...guest.consoleErrors].slice(0, 2).join(" | "));
    await owner.context.close().catch(() => undefined);
    await guest.context.close().catch(() => undefined);
    if (!KEEP) {
      rmSync(dir, { recursive: true, force: true });
      unlistProject(dir);
    }
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

const reachable = await fetch(BASE_URL, { redirect: "manual" }).then(
  () => true,
  () => false,
);
if (!reachable) {
  console.error(`Nothing is answering at ${BASE_URL}.`);
  process.exit(1);
}

phase(`${PAIRS} pairs (${PAIRS * 2} people), ${CONCURRENCY} at a time${NO_AGENT ? ", no agent" : ""}`);
const browser = await chromium.launch({ headless: true });
const startedAt = Date.now();
let next = 0;
const workers = Array.from({ length: Math.min(CONCURRENCY, PAIRS) }, async () => {
  while (next < PAIRS) {
    const index = next++;
    const t0 = Date.now();
    await runPair(browser, index).catch((error) =>
      record("pair crashed", false, 0, String(error?.message ?? error).slice(0, 160)),
    );
    console.log(`  pair ${index + 1}/${PAIRS} done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
});
await Promise.all(workers);
await browser.close().catch(() => undefined);

phase("Tally");
for (const [step, entry] of steps) {
  const total = entry.ok + entry.failed;
  check(
    `${step}: ${entry.ok}/${total}`,
    entry.failed === 0,
    `p50 ${Math.round(percentile(entry.durations, 50) / 1000)}s · p95 ${Math.round(percentile(entry.durations, 95) / 1000)}s${
      entry.details.length > 0 ? ` · e.g. ${entry.details[0]}` : ""
    }`,
  );
}
console.log(`\n  whole swarm: ${Math.round((Date.now() - startedAt) / 1000)}s`);
process.exit(finish());
