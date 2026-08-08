// Browser helpers shared by the end-to-end suites in ../. Everything here
// drives the real UI: no suite asserts on a store or an API it did not reach
// through the same controls a person would use.
//
// The suites differ in timing and in which file they probe for, so this is a
// factory rather than a module of free functions.

export const PERMISSION_ERROR = /Forbidden|does not have (file|project|session|workspace)\./;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      console.log(`  ${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${step}${detail ? `  — ${detail}` : ""}`);
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
  return (await page.locator("body").innerText().catch(() => "")) ?? "";
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
    return page
      .locator("button")
      .evaluateAll((nodes) =>
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
   * Opens a file in the tree, replaces its contents in the editor and saves it
   * — the same three moves a person makes. `directory` is clicked first because
   * the tree only lists a folder's children once it is expanded.
   */
  async function editFileViaUi(page, { directory = null, file, contents }) {
    if (!(await ensureWorkspacePanelOpen(page))) return false;

    if (directory) {
      const folder = page.locator(`button:text-is("${directory}")`).first();
      if ((await folder.count()) === 0) return false;
      await folder.click().catch(() => undefined);
      await sleep(2_000);
    }

    const entry = page.locator(`button:text-is("${file}")`).first();
    if ((await entry.count()) === 0) return false;
    await entry.click().catch(() => undefined);
    await sleep(3_000);

    const editor = page.locator(".monaco-editor textarea").first();
    if ((await editor.count()) === 0) return false;
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    // Monaco auto-closes brackets and quotes, so typed markup would grow stray
    // characters. Paste through the clipboard instead of typing.
    await page.evaluate((text) => navigator.clipboard.writeText(text), contents).catch(() => undefined);
    await page.keyboard.press("ControlOrMeta+v");
    await sleep(1_500);

    const save = page.locator('button[aria-label="Save file"]').first();
    if ((await save.count()) === 0) return false;
    if (await save.isDisabled().catch(() => true)) return false;
    await save.click();
    await sleep(3_000);
    return true;
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
    await page.locator('button:has-text("Close")').first().click().catch(() => undefined);
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
