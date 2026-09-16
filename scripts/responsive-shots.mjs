#!/usr/bin/env node
// Screenshots of the main surfaces at phone, tablet and desktop widths, plus an
// overflow probe: anything wider than the viewport, or pinned to a fixed width
// larger than a phone, is listed so a layout defect is a line of text rather
// than something to squint at.
//
//   T3_E2E_BASE_URL   the web app (default http://127.0.0.1:3773)
//   T3_SHOTS_DIR      where screenshots go (default /root/runs/responsive)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { bodyText, createHarness, openIsolatedSession, sleep } from "./lib/e2e-harness.mjs";

const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);
const BASE_URL = process.env["T3_E2E_BASE_URL"] ?? "http://127.0.0.1:3773";
const OUT = process.env["T3_SHOTS_DIR"] ?? "/root/runs/responsive";
const RUN_ID = String(Date.now());
const PROJECT_DIR = path.join(os.tmpdir(), `t3-shots-${RUN_ID}`);
const EMAIL = `shots.${RUN_ID}@example.test`;
const VIEWPORTS = [
  ["phone", 390, 844],
  ["tablet", 768, 1024],
  ["desktop", 1440, 900],
];
const harness = createHarness({ baseUrl: BASE_URL, password: "Shots!2026" });
const { signUp, logIn, addProject, openProject, sendAgentMessage, ensureWorkspacePanelOpen, openCollabPanel } =
  harness;

mkdirSync(OUT, { recursive: true });
mkdirSync(PROJECT_DIR, { recursive: true });
writeFileSync(path.join(PROJECT_DIR, "README.md"), `# shots ${RUN_ID}\n`);
for (const args of [["init", "--initial-branch=main"], ["add", "."], ["commit", "-m", "seed"]]) {
  execFileSync("git", args, { cwd: PROJECT_DIR, encoding: "utf8" });
}

const probe = (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" && (el.tagName === "SCRIPT" || cs.visibility === "hidden")) continue;
      const over = r.right > vw + 1 || r.left < -1;
      const fixedWide = /px$/.test(cs.width) && parseFloat(cs.width) > vw && cs.overflowX !== "auto";
      if (over || fixedWide) {
        const key = `${el.tagName}.${(el.className && String(el.className).slice(0, 60)) || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute("data-testid"),
          cls: String(el.className).slice(0, 80),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          reason: over ? "outside viewport" : `fixed width ${cs.width}`,
        });
      }
    }
    return {
      vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: out.slice(0, 12),
    };
  });

const report = [];
async function shot(page, name, label) {
  await sleep(1500);
  const file = path.join(OUT, `${label}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  const p = await probe(page).catch((e) => ({ error: String(e) }));
  report.push({ viewport: label, page: name, url: page.url(), ...p });
  const flag = p.scrollWidth > p.vw + 1 ? "  <-- horizontal scroll" : "";
  console.log(`${label}/${name}: vw=${p.vw} scrollWidth=${p.scrollWidth}${flag} offenders=${p.offenders?.length ?? "?"}`);
}

const browser = await chromium.launch({ headless: true });
let projectId = null;
let environmentId = null;
let threadUrl = null;
for (const [label, width, height] of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  const page = await context.newPage();
  const session = { label, context, page, consoleErrors: [] };
  page.on("pageerror", (e) => session.consoleErrors.push(String(e).slice(0, 200)));
  const first = label === "phone";
  if (first) {
    console.log("signup", await signUp(session, EMAIL));
    await addProject(page, PROJECT_DIR);
  } else {
    console.log("login", await logIn(session, EMAIL));
  }
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await sleep(5000);
  await shot(page, "dashboard", label);
  if (!projectId) {
    const href = await page.locator('[data-testid="dashboard-workspace-project-link"]').first().getAttribute("href").catch(() => null);
    const m = href && /project\/([^/]+)\/([^/?#]+)/.exec(href);
    if (m) { environmentId = m[1]; projectId = m[2]; }
    if (!projectId) {
      const infra = await page.locator('[data-testid="dashboard-workspace-infra-link"]').first().getAttribute("href").catch(() => null);
      const mi = infra && /infra\/([^/?#]+)/.exec(infra);
      if (mi) projectId = mi[1];
    }
    console.log("project link", href);
  }
  const opened = await openProject(page);
  console.log("openProject", opened);
  await shot(page, "project", label);
  if (first) {
    await sendAgentMessage(page, `Screenshot run ${RUN_ID}. Reply with one word. Do not create or change any files.`);
    await sleep(12000);
    threadUrl = page.url();
  } else if (threadUrl) {
    await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
    await sleep(6000);
  }
  await shot(page, "thread", label);
  await ensureWorkspacePanelOpen(page);
  await shot(page, "workspace-panel", label);
  const collab = await openCollabPanel(page);
  console.log("collab panel", collab);
  await shot(page, "collab-panel", label);
  for (const [name, route] of [
    ["settings-connections", "/settings/connections"],
    ["settings-general", "/settings/general"],
    ["analytics", projectId ? `/analytics/${projectId}` : null],
    ["infra", projectId ? `/infra/${projectId}` : null],
    ["environments", "/environments"],
  ]) {
    if (!route) continue;
    await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(5000);
    await shot(page, name, label);
  }
  if (session.consoleErrors.length) console.log(`${label} pageerrors:`, session.consoleErrors.slice(0, 3));
  await context.close();
}
await browser.close();
writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("\n=== offenders (only pages with horizontal scroll or offenders) ===");
for (const r of report) {
  if ((r.offenders?.length ?? 0) === 0 && (r.scrollWidth ?? 0) <= (r.vw ?? 0) + 1) continue;
  console.log(`\n[${r.viewport}] ${r.page} vw=${r.vw} scroll=${r.scrollWidth}`);
  for (const o of r.offenders ?? []) console.log(`   ${o.reason}: <${o.tag}${o.testid ? ` data-testid=${o.testid}` : ""}> ${o.cls} [${o.left}..${o.right}] w=${o.width}`);
}
