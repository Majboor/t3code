// Browser helpers shared by the end-to-end suites in ../. Everything here
// drives the real UI: no suite asserts on a store or an API it did not reach
// through the same controls a person would use.
//
// The suites differ in timing and in which file they probe for, so this is a
// factory rather than a module of free functions.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PERMISSION_ERROR = /Forbidden|does not have (file|project|session|workspace)\./;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the project this run created back out of the sidebar.
 *
 * Every suite already deletes its folder, which is why the Desktop stayed
 * tidy — but the project row pointing at that folder survived, so a few dozen
 * runs buried the real projects under `t3-collab-1786...` entries whose
 * folders were long gone. Marked deleted rather than dropped, which is what
 * the app itself does; a hard delete would strand threads that reference it.
 *
 * Matched on the exact path this run created, never a prefix, so a suite
 * running alongside this one keeps its own project.
 *
 * Best effort on purpose: tidying up must never change what a run reported.
 */
export function unlistProject(projectDir) {
  const db = join(homedir(), ".t3", "dev", "state.sqlite");
  if (!existsSync(db)) return;
  try {
    execFileSync("sqlite3", [
      db,
      `update projection_projects set deleted_at = datetime('now'), updated_at = datetime('now')
       where deleted_at is null and workspace_root = '${projectDir.replaceAll("'", "''")}';`,
    ]);
  } catch {
    // A missing sqlite3, a locked database — none of it is worth a failed run.
  }
}

/**
 * Prints checks as they happen and remembers them for the tally. A skip stays
 * on screen and out of the tally, so a green run never implies coverage it did
 * not have.
 */
export function createReporter() {
  const results = [];
  let currentPhase = "setup";

  return {
    results,
    phase(title) {
      currentPhase = title;
      console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
    },
    check(step, ok, detail = "") {
      results.push({ phase: currentPhase, step, ok });
      console.log(
        `  ${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${step}${detail ? `  — ${detail}` : ""}`,
      );
      return ok;
    },
    skip(step, reason) {
      console.log(`  [33mSKIP[0m  ${step}  — ${reason}`);
    },
    /** Exit code 0 only when nothing failed. */
    finish() {
      const failed = results.filter((result) => !result.ok);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      for (const result of failed) console.log(`  FAILED  [${result.phase}] ${result.step}`);
      return failed.length === 0 ? 0 : 1;
    },
  };
}

/** A context per account: separate cookies and storage, i.e. a private window. */
export async function openIsolatedSession(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 200)}`));
  return { label, context, page, consoleErrors };
}

export async function bodyText(page) {
  return (
    (await page
      .locator("body")
      .innerText()
      .catch(() => "")) ?? ""
  );
}

export function createHarness({
  baseUrl,
  password,
  uiSettleMs = 2_500,
  navigationMs = 9_000,
  fileAppearTimeoutMs = 20_000,
  /** A file known to be in the tree, used to tell "open" from "empty". */
  probeFile = null,
}) {
  /** Waits for text to show up, and hands back what was on screen either way. */
  async function waitForText(page, pattern, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let seen = "";
    while (Date.now() < deadline) {
      seen = await bodyText(page);
      if (pattern.test(seen)) return { found: true, seen };
      await sleep(2_000);
    }
    return { found: false, seen };
  }

  async function submitCredentials(page, email, mode) {
    await page
      .locator(`button:has-text("${mode === "signup" ? "Sign up" : "Log in"}")`)
      .first()
      .click()
      .catch(() => undefined);
    await sleep(1_000);
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.locator('button[type="submit"]').first().click();
    await sleep(navigationMs);
  }

  async function authenticate(session, email, mode) {
    await session.page.goto(`${baseUrl}/pair`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await sleep(4_000);
    await submitCredentials(session.page, email, mode);
    return !session.page.url().includes("/pair");
  }

  const signUp = (session, email) => authenticate(session, email, "signup");
  const logIn = (session, email) => authenticate(session, email, "login");

  async function addProject(page, workspaceRoot) {
    await page.locator('button:has-text("Add project")').first().click();
    await sleep(uiSettleMs);
    await page.locator("[data-base-ui-portal] input").first().fill(workspaceRoot);
    await sleep(3_000);
    await page.keyboard.press("Enter");
    await sleep(navigationMs);
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(1_000);
  }

  /** Opens the project's thread view from the dashboard. */
  async function openProject(page) {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(6_000);
    const link = page.locator('[data-testid="dashboard-workspace-project-link"]').first();
    if ((await link.count()) === 0) return false;
    await link.click();
    await sleep(navigationMs);
    return true;
  }

  /**
   * The file tree lives in a panel that starts collapsed, and only lists
   * anything while a project or thread is selected — a bare reload leaves it
   * showing a placeholder, so recover by walking back in through the dashboard.
   */
  async function ensureWorkspacePanelOpen(page) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (probeFile) {
        const visible = await page
          .locator(`button:text-is("${probeFile}")`)
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) return true;
      }

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
      await page
        .locator('button[aria-label="Toggle workspace panel"]')
        .first()
        .click()
        .catch(() => undefined);
    }
    await sleep(2_000);
  }

  async function visibleFileNames(page) {
    await ensureWorkspacePanelOpen(page);
    return page.locator("button").evaluateAll((nodes) =>
      nodes
        .map((node) => (node.textContent ?? "").trim())
        // A row in a git repository carries a status badge and diff counts
        // after the name ("notes.txtU"), so match the name as a prefix rather
        // than expecting the whole label to be a file name.
        .map((text) => /^[\w.-]+\.(?:txt|md|json|js|ts|py|html)/.exec(text)?.[0] ?? "")
        .filter(Boolean),
    );
  }

  /**
   * Waits for `name` in the file tree, first without touching navigation and
   * then after reopening the project. The two are reported separately so a tree
   * that only updates on refresh is not mistaken for one that updates live.
   */
  async function waitForFileInTree(page, name) {
    const deadline = Date.now() + fileAppearTimeoutMs;
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

  /**
   * Clicks a row in the file tree by name. Rows wrap an icon beside the label,
   * so Playwright's text matching does not see the same string `textContent`
   * does; find the index in the DOM instead. A row in a git repository also
   * carries a status badge after the name, hence the prefix match.
   */
  async function clickTreeEntry(page, name) {
    const buttons = page.locator("button");
    const index = await buttons.evaluateAll(
      (nodes, target) =>
        nodes.findIndex((node) =>
          (node.textContent ?? "").trim().replace(/\s+/g, " ").startsWith(target),
        ),
      name,
    );
    if (index < 0) return false;
    await buttons
      .nth(index)
      .click()
      .catch(() => undefined);
    await sleep(2_500);
    return true;
  }

  /**
   * Opens a file in the tree, replaces its contents in the editor and saves it
   * — the same three moves a person makes. `directory` is opened first because
   * the tree only lists a folder's children once it is expanded.
   */
  async function editFileViaUi(page, { directory = null, file, contents }) {
    if (!(await ensureWorkspacePanelOpen(page)))
      return { ok: false, why: "workspace panel never opened" };
    if (directory && !(await clickTreeEntry(page, directory))) {
      return { ok: false, why: `no tree row named ${directory}` };
    }
    if (!(await clickTreeEntry(page, file))) return { ok: false, why: `no tree row named ${file}` };

    // Monaco is fetched at runtime rather than bundled, so the editor arrives a
    // beat after the file is chosen — and its text surface later still. Focus
    // has to land on the rendered lines; the hidden textarea does not take it.
    const lines = page.locator(".monaco-editor .view-lines").first();
    await lines.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    if (!(await lines.isVisible().catch(() => false))) {
      return { ok: false, why: "the editor never rendered the file" };
    }
    await lines.click();
    await sleep(500);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    // insertText rather than type(): Monaco auto-closes brackets and quotes, so
    // typed markup grows stray characters. The clipboard is not an option
    // either — writeText resolves in headless Chromium but the paste does
    // nothing, which looks exactly like an editor that ignored the edit.
    await page.keyboard.insertText(contents);
    await sleep(1_500);

    const save = page.locator('button[aria-label="Save file"]').first();
    if ((await save.count()) === 0) return { ok: false, why: "no save control" };
    if (await save.isDisabled().catch(() => true)) {
      return { ok: false, why: "save stayed disabled, so the editor never saw the change" };
    }
    await save.click();
    await sleep(3_000);
    return { ok: true, why: "" };
  }

  // ── collaboration panel ───────────────────────────────────────────────────

  /** The governance controls live behind the "Collab" popover in the header. */
  async function openCollabPanel(page) {
    await closeWorkspacePanel(page);
    const trigger = page.locator('button[aria-label="Open collaboration panel"]').first();
    if ((await trigger.count()) === 0) return false;
    await trigger.click().catch(() => undefined);
    await sleep(uiSettleMs);
    return (
      (await page.locator('[data-testid="collaboration-approval-modes"]').count()) > 0 ||
      (await page.locator('[data-testid="collaboration-view-toggle"]').count()) > 0
    );
  }

  async function closeCollabPanel(page) {
    const trigger = page.locator('button[aria-label="Close collaboration panel"]').first();
    if ((await trigger.count()) > 0) {
      await trigger.click().catch(() => undefined);
      await sleep(1_000);
    }
  }

  /** Only the lead sees the mode buttons, so this is the lead's lever. */
  async function setApprovalMode(page, label) {
    if (!(await openCollabPanel(page))) return false;
    const button = page
      .locator('[data-testid="collaboration-approval-modes"] button', { hasText: label })
      .first();
    if ((await button.count()) === 0) return false;
    await button.click();
    await sleep(uiSettleMs);
    const pressed = await button.getAttribute("aria-pressed");
    await closeCollabPanel(page);
    return pressed === "true";
  }

  /** Waits for a testid to show up in the collaboration popover. */
  async function waitForCollabElement(page, testId, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await openCollabPanel(page))) return false;
      if ((await page.locator(`[data-testid="${testId}"]`).count()) > 0) {
        return true;
      }
      await closeCollabPanel(page);
      await sleep(3_000);
    }
    return false;
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

  /** Invites an email to the workspace and returns the link, or null. */
  async function createInvite(page, email) {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(6_000);
    await page.locator('button:has-text("Invite")').first().click();
    await sleep(2_000);
    await page.locator('[data-slot="dialog-panel"] input[type="email"]').first().fill(email);
    await page
      .locator('[data-slot="dialog-footer"] button:has-text("Create invite")')
      .first()
      .click();
    await sleep(5_000);
    const codes = await page.locator("code").allInnerTexts();
    const url = codes.find((text) => text.includes("invite=")) ?? null;
    await page
      .locator('button:has-text("Close")')
      .first()
      .click()
      .catch(() => undefined);
    return url;
  }

  /** Follows an invite in a session that is already signed in. */
  async function acceptInvite(session, inviteUrl) {
    await session.page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(7_000);
    const seen = await bodyText(session.page);
    await session.page
      .locator('button:has-text("Back to app")')
      .first()
      .click()
      .catch(() => undefined);
    await sleep(6_000);
    return { accepted: seen.includes("Invite accepted"), seen };
  }

  return {
    waitForText,
    signUp,
    logIn,
    addProject,
    openProject,
    ensureWorkspacePanelOpen,
    closeWorkspacePanel,
    visibleFileNames,
    waitForFileInTree,
    createFileViaUi,
    clickTreeEntry,
    editFileViaUi,
    openCollabPanel,
    closeCollabPanel,
    setApprovalMode,
    waitForCollabElement,
    sendAgentMessage,
    createInvite,
    acceptInvite,
  };
}
