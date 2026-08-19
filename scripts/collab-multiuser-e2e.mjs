#!/usr/bin/env node
// Three people sharing one folder: who joined, who can see what, who may write,
// and who is drawn in which colour.
//
//   bun run dev                      # in another terminal
//   bun run test:collab-multiuser
//
// The sibling suite `test:collab` walks the same cast through the same doors.
// This one exists for the questions that suite answers loosely, because every
// one of them is somewhere a bug can hide behind a passing assertion:
//
//   - the file tree marks an author; this asks whether it names the *right*
//     person, read from the *other* person's browser
//   - read-only is refused; this asks whether the refusal comes from the server
//     by looking for a sentence that exists nowhere in apps/web
//   - read-only stops prompts; this asks what else it stops, because "read-only"
//     is what the button says
//   - a recolour "sticks"; this asks whether the new colour reaches the other
//     places the same person is drawn, and the other people looking at them
//
// A run creates every account, the folder and every file name fresh, so runs
// never collide and nothing has to be cleaned up between them.
//
//   T3_E2E_BASE_URL        the web app     (default http://localhost:5733)
//   T3_E2E_SKIP_AGENT=1    no agent turns  (branch/conflict phases skip)
//   T3_E2E_KEEP_WORKSPACE  keep the folder
//
// The agent phases need per-user provider credentials. Without them the turns
// are refused and the suite says so rather than blaming the feature under test.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const PROJECT_DIR = path.join(
  existsSync(DESKTOP_DIR) ? DESKTOP_DIR : os.tmpdir(),
  `t3-multiuser-${RUN_ID}`,
);
const PASSWORD = "MultiUser!2026";
const ACCOUNT_A = `mu.a.${RUN_ID}@example.test`;
const ACCOUNT_B = `mu.b.${RUN_ID}@example.test`;
const ACCOUNT_C = `mu.c.${RUN_ID}@example.test`;
const KEEP_WORKSPACE = process.env["T3_E2E_KEEP_WORKSPACE"] === "1";
const SKIP_AGENT = process.env["T3_E2E_SKIP_AGENT"] === "1";

const UI_SETTLE_MS = 2_500;
const NAVIGATION_MS = 9_000;
const FILE_APPEAR_TIMEOUT_MS = 25_000;
const AGENT_TURN_MS = 180_000;

/**
 * The sentence ws.ts sends when it refuses a turn from a viewer. Nothing in
 * apps/web contains it, which is the whole point: seeing it in the browser is
 * proof the refusal was decided on the server and not by a disabled button.
 *
 * Keep this in step with `ensureTurnStartWritable` in apps/server/src/ws.ts.
 */
const SERVER_READ_ONLY_SENTENCE = "This workspace is read-only for you.";

const { phase, check, skip, finish } = createReporter();
const harness = createHarness({
  baseUrl: BASE_URL,
  password: PASSWORD,
  uiSettleMs: UI_SETTLE_MS,
  navigationMs: NAVIGATION_MS,
  fileAppearTimeoutMs: FILE_APPEAR_TIMEOUT_MS,
  probeFile: "seed.txt",
});
const {
  waitForText,
  signUp,
  addProject,
  openProject,
  visibleFileNames,
  waitForFileInTree,
  createFileViaUi,
  editFileViaUi,
  openCollabPanel,
  closeCollabPanel,
  setApprovalMode,
  waitForCollabElement,
  sendAgentMessage,
  createInvite,
  ensureWorkspacePanelOpen,
} = harness;

// ── the folder on disk ──────────────────────────────────────────────────────

/** Writes through python3, so the change originates outside the app entirely. */
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

function git(...args) {
  return execFileSync("git", args, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Multiuser E2E",
      GIT_AUTHOR_EMAIL: "multiuser@example.test",
      GIT_COMMITTER_NAME: "Multiuser E2E",
      GIT_COMMITTER_EMAIL: "multiuser@example.test",
    },
  }).trim();
}

async function waitForFileOnDisk(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path.join(PROJECT_DIR, name))) return true;
    await sleep(2_000);
  }
  return false;
}

/**
 * The display name the product builds from an address: mu.b.178@example.test
 * becomes "Mu B 178". Addresses are hidden from the roster unless somebody
 * shares their profile, so this is how a person is found on screen.
 */
function displayNameFor(email) {
  return email
    .split("@")[0]
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function checkLiveTreeUpdate(step, result) {
  check(
    step,
    result.found && !result.neededReload,
    !result.found
      ? "never appeared"
      : result.neededReload
        ? "only after a reload — the tree did not update live"
        : "",
  );
}

// ── reading the collaboration surfaces ──────────────────────────────────────

/**
 * The author mark on one named row, rather than every mark in the tree.
 *
 * Asking for the whole list and checking it is non-empty passes whenever
 * *anybody* has touched *anything*, which is exactly the assertion that cannot
 * catch a tree attributing a file to the wrong person.
 */
async function fileAuthorFor(page, fileName) {
  await ensureWorkspacePanelOpen(page);
  return page
    .locator("button")
    .evaluateAll((nodes, target) => {
      const row = nodes.find((node) =>
        (node.textContent ?? "").trim().replace(/\s+/g, " ").startsWith(target),
      );
      if (!row) return null;
      const mark = row.querySelector('[data-testid="workspace-entry-author"]');
      if (!mark) return null;
      return {
        author: mark.getAttribute("data-author") ?? "",
        title: mark.getAttribute("title") ?? "",
        color: getComputedStyle(mark).backgroundColor,
      };
    }, fileName);
}

/** Waits for an author mark to reach a row, because the touch arrives on a stream. */
async function waitForFileAuthor(page, fileName, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fileAuthorFor(page, fileName);
    if (last?.author) return last;
    await sleep(3_000);
  }
  return last;
}

async function memberRows(page) {
  if (!(await openCollabPanel(page))) return [];
  const rows = await page
    .locator('[data-testid="collaboration-member-row"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const avatar = node.querySelector('[data-testid="collaboration-avatar"]');
        return {
          text: (node.textContent ?? "").trim().replace(/\s+/g, " "),
          color: avatar ? getComputedStyle(avatar).backgroundColor : "",
        };
      }),
    );
  await closeCollabPanel(page);
  return rows;
}

async function memberColorFor(page, email) {
  const name = displayNameFor(email);
  const row = (await memberRows(page)).find(
    (entry) => entry.text.includes(email) || entry.text.includes(name),
  );
  return row?.color ?? "";
}

async function expandMemberRow(page, email) {
  if (!(await openCollabPanel(page))) return null;
  const rows = page.locator('[data-testid="collaboration-member-row"]');
  const name = displayNameFor(email);
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    const text = (await row.innerText().catch(() => "")) ?? "";
    if (text.includes(email) || text.includes(name)) {
      await row
        .locator("button")
        .first()
        .click()
        .catch(() => undefined);
      await sleep(1_500);
      return row;
    }
  }
  return null;
}

/** Flips one member between watching and prompting, from the lead's browser. */
async function setMemberReadOnly(page, email, readOnly) {
  const row = await expandMemberRow(page, email);
  if (!row) return false;
  const toggle = row.locator('[data-testid="collaboration-read-only-toggle"]').first();
  if ((await toggle.count()) === 0) return false;
  const label = (await toggle.innerText().catch(() => "")) ?? "";
  const alreadyThere = readOnly ? label.includes("Restore") : label.includes("Make read-only");
  if (!alreadyThere) {
    await toggle.click().catch(() => undefined);
    await sleep(4_000);
  }
  await closeCollabPanel(page);
  return true;
}

/** Every human message in the open thread, with the author the UI puts on it. */
async function userMessages(page) {
  return page
    .locator('[data-timeline-row-kind="message"][data-message-role="user"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const label = node.querySelector('[data-testid="message-author"]');
        return {
          text: (node.textContent ?? "").trim(),
          // From the attribute, not the text: the label draws initials beside
          // the name, so textContent reads "MBMu B 178".
          authorName: label?.getAttribute("data-author-name") ?? null,
        };
      }),
    );
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
const accountA = await openIsolatedSession(browser, "A");
const accountB = await openIsolatedSession(browser, "B");
const accountC = await openIsolatedSession(browser, "C");

try {
  phase("A folder made at run time, and an account made at run time");
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileViaPython("seed.txt", "seed\n");
  check("the folder exists on the Desktop", existsSync(PROJECT_DIR), PROJECT_DIR);
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "seed");
  check("the folder is a git repository", git("rev-parse", "--abbrev-ref", "HEAD") === "main");

  check("A signs up with a fresh login", await signUp(accountA, ACCOUNT_A), ACCOUNT_A);
  await addProject(accountA.page, PROJECT_DIR);
  check(
    "A's workspace lists the folder",
    (await bodyText(accountA.page)).includes(path.basename(PROJECT_DIR)),
  );

  phase("A file written into the folder from outside, by python");
  const pythonFile = `python-${RUN_ID}.txt`;
  writeFileViaPython(pythonFile, "written by python, not by the app\n");
  checkLiveTreeUpdate(
    "the workspace picks up a file it did not create",
    await waitForFileInTree(accountA.page, pythonFile),
  );

  phase("A shares the workspace by link");
  const inviteForB = await createInvite(accountA.page, ACCOUNT_B);
  check("A gets an add-to-workspace link", Boolean(inviteForB), inviteForB ?? "none");
  if (!inviteForB) throw new Error("no link to hand to B");

  phase("B opens the link in a session that has never seen this app");
  await accountB.page.goto(inviteForB, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  check(
    "a cookieless session is asked to authenticate first",
    /Sign up|Log in|Sign in/.test(await bodyText(accountB.page)),
  );
  check("B signs up with a fresh login", await signUp(accountB, ACCOUNT_B), ACCOUNT_B);
  await accountB.page.goto(inviteForB, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(7_000);
  check("B joins the workspace from the link", (await bodyText(accountB.page)).includes("Invite accepted"));
  await accountB.page
    .locator('button:has-text("Back to app")')
    .first()
    .click()
    .catch(() => undefined);
  await sleep(6_000);
  check("the shared workspace opens for B", await openProject(accountB.page));
  check("B hits no permission error", !PERMISSION_ERROR.test(await bodyText(accountB.page)));
  check(
    "B sees the file python wrote before they joined",
    (await visibleFileNames(accountB.page)).includes(pythonFile),
  );

  phase("A creates a file, and B is told who created it");
  const aFile = `from-a-${RUN_ID}.txt`;
  check("A uses New file", await createFileViaUi(accountA.page, aFile));
  check("A's file lands on disk", await waitForFileOnDisk(aFile, FILE_APPEAR_TIMEOUT_MS));
  checkLiveTreeUpdate("B sees A's new file", await waitForFileInTree(accountB.page, aFile));

  const markInB = await waitForFileAuthor(accountB.page, aFile);
  check("B's tree marks the file with an author", Boolean(markInB?.author), markInB?.author ?? "no mark");
  // The assertion worth having: not "somebody" but "A", read from B's browser.
  check(
    "the mark names A rather than whoever is looking",
    markInB?.author === displayNameFor(ACCOUNT_A),
    `mark says "${markInB?.author ?? ""}", A is "${displayNameFor(ACCOUNT_A)}"`,
  );
  check(
    "the mark says what it means by an author",
    (markInB?.title ?? "").startsWith("Last changed by"),
    markInB?.title ?? "",
  );

  // Asked, not assumed. The touch record carries a user and a time and nothing
  // else, so if this ever finds a session or an agent the product grew one.
  const agentMarkers = await accountB.page
    .locator(
      '[data-testid="workspace-entry-agent"], [data-workspace-entry-agent], [data-testid="workspace-entry-session"]',
    )
    .count();
  if (agentMarkers === 0) {
    skip(
      "the tree says whether a person or an agent is working on a file",
      "no such marker exists — a file touch records a user, a path and a time, and nothing about a session or an agent",
    );
  } else {
    check("the tree says whether a person or an agent is working on a file", true);
  }

  // How far the attribution reaches, asked cheaply. Only the workspace panel's
  // own save and create call `collaboration.files.touch`, so a change arriving
  // any other way is authorless — the python file from the setup phase is on
  // disk, in the tree, and belongs to nobody. Same mechanism as an agent write.
  const pythonMark = await fileAuthorFor(accountB.page, pythonFile);
  if (!pythonMark?.author) {
    skip(
      "a file written outside the app carries an author",
      "authorship is claimed by the browser that saved the file, so anything written by python, by git or by an agent stays unattributed",
    );
  } else {
    check("a file written outside the app carries an author", true, pythonMark.author);
  }

  phase("C joins from a session that already has an account");
  check("C signs up on their own first", await signUp(accountC, ACCOUNT_C), ACCOUNT_C);
  const inviteForC = await createInvite(accountA.page, ACCOUNT_C);
  check("A gets a link for C", Boolean(inviteForC), inviteForC ?? "none");
  if (inviteForC) {
    await accountC.page.goto(inviteForC, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(7_000);
    const cSaw = await bodyText(accountC.page);
    check("C is not sent back through sign-up", !/Sign up now|Create your account/i.test(cSaw));
    check("C joins the workspace from the link", cSaw.includes("Invite accepted"));
    await accountC.page
      .locator('button:has-text("Back to app")')
      .first()
      .click()
      .catch(() => undefined);
    await sleep(6_000);
    check("the shared workspace appears for C's existing account", await openProject(accountC.page));
    check(
      "C sees the shared files",
      (await visibleFileNames(accountC.page)).includes(pythonFile),
      (await visibleFileNames(accountC.page)).join(", "),
    );
  }

  phase("Three people in one thread");
  check("A is back in the project", await openProject(accountA.page));
  const said = {
    A: `A checking in ${RUN_ID}`,
    B: `B checking in ${RUN_ID}`,
    C: `C checking in ${RUN_ID}`,
  };
  // Messages, not turns: what is being checked is attribution and colour, and
  // making all three depend on a provider would lose that to a missing key.
  for (const [label, session] of [
    ["A", accountA],
    ["B", accountB],
    ["C", accountC],
  ]) {
    check(`${label} sends a message`, await sendAgentMessage(session.page, said[label]));
    await sleep(4_000);
  }
  await sleep(8_000);

  const seenByA = await userMessages(accountA.page);
  const authored = new Set(seenByA.map((message) => message.authorName).filter(Boolean));
  check(
    "A's transcript attributes other people's messages",
    authored.size > 0,
    [...authored].join(", ") || "no message carried an author",
  );

  phase("Colours, and an admin changing one");
  const rosterBefore = await memberRows(accountA.page);
  check("the roster shows all three people", rosterBefore.length >= 3, `${rosterBefore.length} rows`);
  const coloursBefore = rosterBefore.map((row) => row.color).filter(Boolean);
  check(
    "everyone is drawn in their own colour",
    coloursBefore.length >= 3 && new Set(coloursBefore).size === coloursBefore.length,
    coloursBefore.join(" "),
  );

  const cColourBefore = await memberColorFor(accountA.page, ACCOUNT_C);
  const cRow = await expandMemberRow(accountA.page, ACCOUNT_C);
  const swatches = cRow?.locator('[data-testid="collaboration-color-picker"] button');
  const canRecolour = swatches !== undefined && (await swatches.count()) > 0;
  check("the admin is offered a colour picker for someone else", canRecolour);
  if (canRecolour) {
    await swatches
      .last()
      .click()
      .catch(() => undefined);
    await sleep(4_000);
  }
  await closeCollabPanel(accountA.page);

  const cColourAfter = await memberColorFor(accountA.page, ACCOUNT_C);
  check(
    "the colour the admin picked actually replaces the old one",
    Boolean(cColourAfter) && cColourAfter !== cColourBefore,
    `${cColourBefore || "none"} -> ${cColourAfter || "none"}`,
  );
  // A colour only one browser agrees with is not a colour for a person.
  const cColourForB = await memberColorFor(accountB.page, ACCOUNT_C);
  check(
    "everyone else sees the new colour too",
    cColourForB === cColourAfter,
    `A sees ${cColourAfter || "none"}, B sees ${cColourForB || "none"}`,
  );

  // The same person is drawn twice: on the roster and against the files they
  // touched. A recolour that only reaches one of them leaves one person wearing
  // two colours, which is the opposite of what a colour is for.
  const cFile = `from-c-${RUN_ID}.txt`;
  if (inviteForC) {
    check("C creates a file", await createFileViaUi(accountC.page, cFile));
    await waitForFileOnDisk(cFile, FILE_APPEAR_TIMEOUT_MS);
    const cMark = await waitForFileAuthor(accountA.page, cFile);
    check("the tree marks C's file with C", cMark?.author === displayNameFor(ACCOUNT_C), cMark?.author ?? "no mark");
    check(
      "the file mark uses the colour the admin chose",
      Boolean(cMark?.color) && cMark?.color === cColourAfter,
      `roster ${cColourAfter || "none"}, file mark ${cMark?.color || "none"}`,
    );
  }

  phase("Two people in one file, and the offer of a branch");
  const contested = "seed.txt";
  // Contention is computed from file touches by distinct users inside a 15
  // minute window, and a touch is only claimed by the workspace panel's own
  // save. So two saves through the editor is what the detector is actually
  // watching for — driving it with two agent turns would test nothing, because
  // an agent's write never registers a touch at all.
  const aSave = await editFileViaUi(accountA.page, {
    file: contested,
    contents: `A owns this line ${RUN_ID}\n`,
  });
  check("A edits the shared file in the editor", aSave.ok, aSave.why);
  const bSave = await editFileViaUi(accountB.page, {
    file: contested,
    contents: `B owns this line ${RUN_ID}\n`,
  });
  check("B edits the same file", bSave.ok, bSave.why);

  const contention = await waitForCollabElement(accountA.page, "collaboration-contention", 30_000);
  check("the workspace notices two people are in one file", contention);
  const contendedText = await accountA.page
    .locator('[data-testid="collaboration-contended-file"]')
    .first()
    .innerText()
    .catch(() => "");
  check(
    "it names the file they are both in",
    contendedText.includes(contested),
    contendedText.replace(/\s+/g, " ").slice(0, 90),
  );
  check(
    "it suggests keeping the edits on separate branches",
    /own branch/i.test(await bodyText(accountA.page)),
    "looked for the 'own branch' suggestion beside the warning",
  );
  await closeCollabPanel(accountA.page);

  // The same detector, asked about the case the flow really names. An agent
  // write goes through the server and never calls collaboration.files.touch,
  // so two agents in one file are invisible to every surface above.
  if (SKIP_AGENT) {
    skip("two agents in one file are noticed the same way", "T3_E2E_SKIP_AGENT=1");
  } else {
    const agentFile = `agent-${RUN_ID}.txt`;
    const sent = await sendAgentMessage(
      accountA.page,
      `Create a file named ${agentFile} containing the word ready. Do not ask questions.`,
    );
    check("A can start an agent turn", sent);
    const wrote = sent && (await waitForFileOnDisk(agentFile, AGENT_TURN_MS));
    const thread = await bodyText(accountA.page);
    const providerMissing = /Provider turn start failed|no provider|credentials|not connected/i.test(
      thread,
    );
    if (!wrote && providerMissing) {
      skip(
        "an agent's file write is attributed to somebody",
        `the turn was refused before it ran — ${thread.match(/(Provider turn start failed[^\n]*|[^\n]*credentials[^\n]*)/)?.[0]?.slice(0, 110) ?? "no provider"}`,
      );
      skip("two agents in one file are noticed the same way", "no agent turn ran");
    } else {
      check("A's agent wrote the file", wrote, wrote ? "" : "never landed on disk");
      const agentMark = await fileAuthorFor(accountA.page, agentFile);
      check(
        "an agent's file write is attributed to somebody",
        Boolean(agentMark?.author),
        agentMark?.author
          ? agentMark.author
          : "the agent wrote the file and the tree shows no author — only browser saves claim authorship, so nothing an agent does is attributed or contended",
      );
    }
  }

  phase("The lead moves the workspace onto personal branches");
  {
    check(
      "A switches the workspace to 'Own branch'",
      await setApprovalMode(accountA.page, "Own branch"),
    );
    const offered = await waitForCollabElement(accountB.page, "collaboration-branch-offer");
    check("B is offered a branch of their own", offered);
    const createBranch = accountB.page
      .locator('[data-testid="collaboration-branch-create"]')
      .first();
    if (offered && (await createBranch.count()) > 0) {
      await createBranch.click();
      await sleep(8_000);
    }
    const branches = git("branch", "--list");
    check("B's branch exists in git", /collab\//.test(branches), branches.replace(/\s+/g, " "));

    // Make the two branches genuinely disagree about one file, so the merge has
    // a real conflict to report rather than a fast-forward to celebrate.
    const bBranch = (branches.match(/collab\/\S+/) ?? [null])[0];
    const worktree = bBranch
      ? (git("worktree", "list")
          .split("\n")
          .find((line) => line.includes(bBranch.replace("collab/", "")))
          ?.split(/\s+/)[0] ?? null)
      : null;
    if (worktree) {
      writeFileViaPython(contested, `A owns this line ${RUN_ID}\n`);
      git("commit", "-am", "A edits the shared file");
      execFileSync("python3", [
        "-c",
        "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])",
        path.join(worktree, contested),
        `B owns this line ${RUN_ID}\n`,
      ]);
      execFileSync("git", ["commit", "-am", "B edits the shared file"], {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Multiuser E2E",
          GIT_AUTHOR_EMAIL: "multiuser@example.test",
          GIT_COMMITTER_NAME: "Multiuser E2E",
          GIT_COMMITTER_EMAIL: "multiuser@example.test",
        },
      });
    }
    check("both branches changed the same file", worktree !== null, worktree ?? "no worktree");

    check(
      "B is warned the file is contested",
      await waitForCollabElement(accountB.page, "collaboration-conflict-warning", 30_000),
    );
    const warning = await accountB.page
      .locator('[data-testid="collaboration-conflict-warning"]')
      .first()
      .innerText()
      .catch(() => "");
    check("the warning names the file", warning.includes(contested), warning.replace(/\s+/g, " ").slice(0, 90));
    await closeCollabPanel(accountB.page);

    phase("The admin merges, and the conflict surfaces to them");
    const opened = await openCollabPanel(accountA.page);
    const claims = accountA.page.locator('[data-testid="collaboration-branch-claim"]');
    check(
      "the admin can see which branches people are on",
      opened && (await claims.count()) > 0,
      `${await claims.count()} listed`,
    );
    const mergeButton = accountA.page.locator('[data-testid="collaboration-merge-claim"]').first();
    const canMerge = (await mergeButton.count()) > 0;
    check("the admin can merge someone's branch from the panel", canMerge);
    if (canMerge) {
      await mergeButton.click();
      await sleep(10_000);
      const conflict = accountA.page.locator('[data-testid="collaboration-merge-conflict"]').first();
      const reported = (await conflict.count()) > 0;
      const text = reported
        ? await conflict.innerText().catch(() => "")
        : await bodyText(accountA.page);
      check(
        "the merge reports the conflict rather than pretending",
        reported && text.includes(contested),
        text.replace(/\s+/g, " ").slice(0, 110),
      );
      // Reported honestly rather than asserted: nothing in the panel offers a
      // place to resolve a conflicted merge, so this is a statement about the
      // product, not a failure of the merge.
      const resolver = await accountA.page
        .locator(
          '[data-testid="collaboration-merge-resolve"], [data-testid="collaboration-conflict-resolve"]',
        )
        .count();
      if (resolver === 0) {
        skip(
          "the admin can resolve the conflict from the panel",
          "the merge names the conflicted file and stops there — there is no resolve control",
        );
      } else {
        check("the admin can resolve the conflict from the panel", true);
      }
    }
    await closeCollabPanel(accountA.page);
  }

  phase("A demotes B to read-only");
  check("A can mark B read-only", await setMemberReadOnly(accountA.page, ACCOUNT_B, true));
  check("A reopens the project", await openProject(accountA.page));

  const deniedFile = `denied-${RUN_ID}.txt`;
  const sentWhileMuted = await sendAgentMessage(
    accountB.page,
    `Create a file named ${deniedFile}. Do not ask questions.`,
  );
  // A refusal proves nothing unless the prompt was really submitted: a composer
  // that quietly dropped it would look identical from here.
  check("B's composer still accepts the prompt", sentWhileMuted);
  const refusal = await waitForText(accountB.page, /read-only|was not sent/i, 45_000);
  check("B is told the workspace is read-only for them", refusal.found, refusal.found ? "" : refusal.seen.replace(/\s+/g, " ").slice(0, 180));
  // The sentence exists in apps/server/src/ws.ts and nowhere in apps/web, so
  // reading it in the browser is proof the server decided this.
  check(
    "the refusal came from the server, not a hidden button",
    refusal.seen.includes(SERVER_READ_ONLY_SENTENCE),
    refusal.seen.includes(SERVER_READ_ONLY_SENTENCE)
      ? ""
      : `never saw "${SERVER_READ_ONLY_SENTENCE}"`,
  );
  check("B's prompt never reached the agent", !(await waitForFileOnDisk(deniedFile, 10_000)));

  // Read-only is what the button says, so this asks what else it holds back.
  // The turn check guards `thread.turn.start` alone; the file routes take
  // anyone who can reach the project.
  const smuggledFile = `smuggled-${RUN_ID}.txt`;
  const createdWhileMuted = await createFileViaUi(accountB.page, smuggledFile);
  const landed = createdWhileMuted && (await waitForFileOnDisk(smuggledFile, 15_000));
  check(
    "a read-only member cannot create files in the workspace either",
    !landed,
    landed
      ? `read-only B created ${smuggledFile} through the workspace panel — the viewer role only guards agent turns, not projects.writeFile / projects.createEntry`
      : "",
  );
  const overwrite = await editFileViaUi(accountB.page, {
    file: "seed.txt",
    contents: `overwritten by a read-only member ${RUN_ID}\n`,
  });
  const overwritten =
    overwrite.ok &&
    readFileSync(path.join(PROJECT_DIR, "seed.txt"), "utf8").includes("read-only member");
  check(
    "a read-only member cannot overwrite a shared file either",
    !overwritten,
    overwritten
      ? "read-only B saved over seed.txt from the editor — projects.writeFile has no viewer check"
      : overwrite.why,
  );

  phase("A gives write access back");
  check("A can restore B's write access", await setMemberReadOnly(accountA.page, ACCOUNT_B, false));
  const restored = await expandMemberRow(accountA.page, ACCOUNT_B);
  check(
    "B is no longer listed as read-only",
    !((await restored?.innerText().catch(() => "")) ?? "").includes("Read-only"),
  );
  await closeCollabPanel(accountA.page);

  phase("Result");
  console.log(`  workspace: ${PROJECT_DIR}`);
  console.log(`  on disk:   ${readdirSync(PROJECT_DIR).join(", ")}`);
  for (const [label, session] of [
    ["A", accountA],
    ["B", accountB],
    ["C", accountC],
  ]) {
    if (session.consoleErrors.length > 0) {
      console.log(`  ${label} console: ${session.consoleErrors.slice(0, 3).join(" | ")}`);
    }
  }
} catch (error) {
  check("the run completed", false, String(error).slice(0, 200));
} finally {
  await browser.close().catch(() => undefined);
  if (!KEEP_WORKSPACE) {
    // Worktrees hold the branch directories open, so drop them before the tree.
    try {
      for (const line of git("worktree", "list").split("\n").slice(1)) {
        const dir = line.split(/\s+/)[0];
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // A folder that was never a repository has no worktrees to clear.
    }
    rmSync(PROJECT_DIR, { recursive: true, force: true });
    unlistProject(PROJECT_DIR);
  }
}

process.exit(finish());
