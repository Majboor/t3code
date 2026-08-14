#!/usr/bin/env node
// The pack suggestions above the prompt bar, driven the way somebody uses them.
//
//   bun run dev                      # in another terminal
//   bun run test:pack-suggestions
//
// Covers the four things the bar has to do: suggest as you type, open a pack
// without leaving the composer, turn one on for the project, and let somebody
// search or switch the whole thing off. No provider needed — nothing here
// sends a turn.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createHarness,
  createReporter,
  openIsolatedSession,
  sleep,
  unlistProject,
} from "/Users/hico/Desktop/waleed_codes/p36/t3code/scripts/lib/e2e-harness.mjs";
const { chromium } = createRequire(
  "/Users/hico/Desktop/waleed_codes/p36/t3code/apps/web/package.json",
)("playwright");

const BASE = "http://localhost:5733",
  RUN = String(Date.now());
const DIR = path.join(os.homedir(), "Desktop", `t3-bar-${RUN}`);
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, "todo.py"), "print('hi')\n");

const { check, finish, phase } = createReporter();
const { signUp, addProject, openProject } = createHarness({
  baseUrl: BASE,
  password: "Bar-passw0rd!",
  probeFile: "todo.py",
});
const browser = await chromium.launch();
const s = await openIsolatedSession(browser, "A");
const page = s.page;
try {
  check("signs up", await signUp(s, `bar.${RUN}@example.test`));
  await addProject(page, DIR);
  check("opens the project", await openProject(page));
  const composer = page.locator('[data-testid="composer-editor"], textarea').first();
  await composer.click();
  await page.keyboard.insertText("deploy this app to a server");
  await sleep(4000);
  check("the bar appears", (await page.locator('[data-testid="pack-suggestion-bar"]').count()) > 0);

  phase("Quick view instead of a new tab");
  const before = page.context().pages().length;
  await page.locator('[data-testid="pack-suggestion-open"]').first().click();
  await sleep(4000);
  const qv = page.locator('[data-testid="pack-quick-view"]');
  check("the pack opens inline", (await qv.count()) > 0);
  check("and no new tab was opened", page.context().pages().length === before);
  if (await qv.count()) {
    const text = (await qv.first().innerText()).replace(/\s+/g, " ");
    check(
      "it shows what has gone wrong before",
      /gone wrong before/i.test(text),
      text.slice(0, 110),
    );
    // Not /deploy/: that matches the pack's own name, so it passed while the
    // manifest had failed to load entirely.
    check(
      "with the pack's own failure wording",
      /reports success|serving the version before|nothing is listening|already in use/i.test(text),
      text.slice(0, 150),
    );
  }

  phase("Turning it on for this project");
  const en = page.locator('[data-testid="pack-quick-view-enable"]');
  check("there is a way to turn it on", (await en.count()) > 0);
  if (await en.count()) {
    await en.click();
    await sleep(4000);
    check("it reports being on", /on for this project/i.test(await qv.first().innerText()));

    // The other half of "on by default until you disable it": being able to.
    const off = page.locator('[data-testid="pack-quick-view-disable"]');
    check("and can be turned off again", (await off.count()) > 0);
    if ((await off.count()) > 0) {
      await off.click();
      await sleep(4000);
      const after = await qv.first().innerText();
      check("it goes back to off", /turn on/i.test(after), after.replace(/\s+/g, " ").slice(-90));
    }
  }

  phase("Searching packs by hand");
  await page.locator('[data-testid="pack-suggestion-search"]').first().click();
  await sleep(1200);
  const box = page.locator('[data-testid="pack-suggestion-search-input"]');
  check("a search box appears", (await box.count()) > 0);
  await box.fill("email");
  await sleep(2500);
  const names = await page.locator('[data-testid="pack-suggestion-use"]').allInnerTexts();
  check(
    "searching finds an unrelated pack",
    names.some((n) => /mail/i.test(n)),
    names.join(", "),
  );

  phase("The setting");
  await page.locator('[data-testid="pack-suggestion-settings"]').first().click();
  await sleep(1200);
  check(
    "settings open",
    (await page.locator('[data-testid="pack-suggestion-settings-panel"]').count()) > 0,
  );
  await page.locator('[data-testid="pack-suggestion-layout"]').click();
  await sleep(1200);
  check(
    "layout can be changed",
    (await page.locator('[data-testid="pack-suggestion-bar"]').count()) > 0,
  );
  await page.locator('[data-testid="pack-suggestion-toggle-off"]').click();
  await sleep(2000);
  check(
    "turning it off hides the bar",
    (await page.locator('[data-testid="pack-suggestion-bar"]').count()) === 0,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(9000);
  const composer2 = page.locator('[data-testid="composer-editor"], textarea').first();
  if (await composer2.count()) {
    await composer2.click();
    await page.keyboard.insertText("deploy this to a server");
    await sleep(3500);
  }
  check(
    "and it stays off after a reload",
    (await page.locator('[data-testid="pack-suggestion-bar"]').count()) === 0,
  );

  check("no page errors", s.consoleErrors.length === 0, s.consoleErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  unlistProject(DIR);
}
process.exit(finish());
