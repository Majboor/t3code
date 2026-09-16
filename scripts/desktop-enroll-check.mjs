#!/usr/bin/env node
// Proves the no-typing connect flow headlessly (Linux, under Xvfb):
//
//   1. a fresh account signs up on the portal (cookie jar, no browser)
//   2. the desktop app starts with an empty state directory
//   3. the portal's "Open LogicPacks and connect this computer" link is handed
//      to the running app (`logicpacks://enroll?server=<portal>`), the way the
//      OS would hand it over; the app asks the portal for a code and opens the
//      approval page — captured here instead of a browser
//   4. the signed-in account approves the code over the portal's API
//   5. the app collects its credential and writes the environment down
//
//   T3_SMOKE_APP    the app launcher (default: apps/desktop/logicpacks-linux.sh)
//   T3_PORTAL_URL   the portal (default http://127.0.0.1:3773)
//   T3_SHOTS_DIR    screenshots (default /root/runs/desktop)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createReporter, sleep } from "./lib/e2e-harness.mjs";

const { _electron: electron } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const APP = process.env["T3_SMOKE_APP"] ?? path.join(REPO, "apps/desktop/logicpacks-linux.sh");
const PORTAL = (process.env["T3_PORTAL_URL"] ?? "http://127.0.0.1:3773").replace(/\/+$/, "");
const SHOTS = process.env["T3_SHOTS_DIR"] ?? "/root/runs/desktop";
const RUN = String(Date.now());
const SANDBOX = path.join(os.tmpdir(), `t3-enroll-${RUN}`);
const REGISTRY = path.join(SANDBOX, ".t3", "userdata", "saved-environments.json");
const { phase, check, finish } = createReporter();
mkdirSync(SHOTS, { recursive: true });
mkdirSync(SANDBOX, { recursive: true });

// ── a signed-in person, without a browser ───────────────────────────────────
let cookie = "";
async function portal(route, init = {}) {
  const response = await fetch(`${PORTAL}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

phase("A person signs in on the portal");
const email = `enroll.${RUN}@example.test`;
const signup = await portal("/api/auth/password", {
  method: "POST",
  body: JSON.stringify({ email, password: "Enroll!2026", mode: "signup", displayName: "Enroll Tester" }),
});
check("the account exists and is signed in", signup.status === 200 && Boolean(cookie), `${signup.status}`);

phase("The desktop app starts with no account");
let app = null;
const shoot = async (win, name) => win.screenshot({ path: path.join(SHOTS, `enroll-${name}.png`) }).catch(() => undefined);
try {
  const launchOptions = {
    executablePath: APP,
    // A headless Linux box has no keyring, so Electron's safeStorage reports no
    // encryption and the app refuses to keep the credential. Real desktops have
    // one; here the basic store stands in for it.
    args: ["--password-store=basic"],
    env: {
      ...process.env,
      HOME: SANDBOX,
      T3CODE_HOME: path.join(SANDBOX, ".t3"),
      T3CODE_DISABLE_AUTO_UPDATE: "1",
      // Deliberately NOT the portal: the deep link below must be what points
      // the app at it, which is the fallback the portal button relies on.
      T3CODE_CLOUD_URL: "http://127.0.0.1:1",
    },
    timeout: 90_000,
  };
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
  check("the app is running", true);

  // No keyring under Xvfb: stand in for the OS secret store, which is the one
  // thing a real desktop has and this box does not. Everything else is real.
  await app.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) {
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (value) => Buffer.from(String(value), "utf8");
      safeStorage.decryptString = (buffer) => Buffer.from(buffer).toString("utf8");
      globalThis.__secretStoreShimmed = true;
    }
  });
  // Where the app would have opened a browser, keep the URL instead.
  await app.evaluate(({ shell }) => {
    const opened = [];
    globalThis.__openedExternally = opened;
    const original = shell.openExternal.bind(shell);
    shell.openExternal = (url, options) => {
      opened.push(String(url));
      return original(url, options).catch(() => undefined);
    };
  });
  await sleep(8_000);

  phase("The portal hands the running app a link that names the portal");
  const deepLink = `logicpacks://enroll?server=${encodeURIComponent(PORTAL)}`;
  // Linux delivers a deep link to a running app as a second instance's argv.
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit("second-instance", { preventDefault() {} }, ["t3code", link], process.cwd());
  }, deepLink);

  let approveUrl = null;
  for (let i = 0; i < 40 && !approveUrl; i += 1) {
    const opened = await app.evaluate(() => globalThis.__openedExternally ?? []);
    approveUrl = opened.find((url) => url.includes("/connect?") && url.includes("code=")) ?? null;
    if (!approveUrl) await sleep(2_000);
  }
  check("the app asked the portal for a code and opened its approval page", approveUrl !== null, approveUrl ?? "nothing opened");
  const code = approveUrl ? new URL(approveUrl).searchParams.get("code") : null;
  check("the approval page belongs to this portal", approveUrl !== null && approveUrl.startsWith(PORTAL), approveUrl ?? "");
  for (const win of app.windows()) {
    if (win.url().startsWith("data:")) await shoot(win, "01-waiting-for-approval");
  }

  phase("The signed-in person approves it");
  const preview = code ? await portal(`/api/devices/enrollments/${encodeURIComponent(code)}`) : { status: 0, body: null };
  check(
    "the portal shows the request as pending, naming this machine",
    preview.status === 200 && /pending/i.test(JSON.stringify(preview.body)),
    `${preview.status} ${JSON.stringify(preview.body ?? {}).slice(0, 140)}`,
  );
  const approve = code
    ? await portal(`/api/devices/enrollments/${encodeURIComponent(code)}/approve`, { method: "POST", body: "{}" })
    : { status: 0, body: null };
  check("approval succeeds with the session, one click", approve.status === 200, `${approve.status} ${JSON.stringify(approve.body ?? {}).slice(0, 120)}`);

  phase("The app collects its credential and lists the account");
  let record = null;
  for (let i = 0; i < 45 && !record; i += 1) {
    if (existsSync(REGISTRY)) {
      try {
        const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
        const entries = Array.isArray(registry) ? registry : (registry.environments ?? registry.records ?? Object.values(registry));
        record = (Array.isArray(entries) ? entries : []).find((entry) => JSON.stringify(entry).includes(PORTAL)) ?? null;
      } catch {
        record = null;
      }
    }
    if (!record) await sleep(2_000);
  }
  check("the app wrote the portal down as a connected environment", record !== null, record ? JSON.stringify(record).slice(0, 160) : "no registry entry");
  let headline = "";
  for (const win of app.windows()) {
    if (win.url().startsWith("data:")) {
      headline = await win.locator("body").innerText().catch(() => "");
      await shoot(win, "02-after-approval");
    }
  }
  check("the app's connect window reports success", /connected|approved|ready/i.test(headline), headline.replace(/\s+/g, " ").slice(0, 120));

  phase("The app dials the portal, and the portal lists the machine as online");
  const linksFor = async () => {
    const { status, body } = await portal("/api/environments/relay/links");
    return status === 200 && body && Array.isArray(body.environments) ? body.environments : [];
  };
  let online = null;
  for (let i = 0; i < 60 && !online; i += 1) {
    online = (await linksFor()).find((link) => link.state === "connected") ?? null;
    if (!online) await sleep(3_000);
  }
  check(
    "the portal shows this machine connected through the relay",
    online !== null,
    online ? `${online.label} · ${online.state} · ${online.environmentId}` : JSON.stringify(await linksFor()).slice(0, 200),
  );

  // What the person sees: the Environments page, in a browser signed in as them.
  const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: PORTAL }]);
    const page = await context.newPage();
    await page.goto(`${PORTAL}/environments`, { waitUntil: "domcontentloaded" });
    await sleep(8_000);
    const rows = page.locator('[data-testid="account-machine-row"]');
    const states = await rows.evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute("data-environment-id")}:${node.getAttribute("data-state")}`));
    check("the Environments page lists the machine as online", states.some((entry) => entry.endsWith(":connected")), states.join(", ") || "no rows");
    const openEnabled = await page.locator('[data-testid="account-machine-open"]:not([disabled])').count();
    check("its Open button is enabled", openEnabled > 0, `${openEnabled} enabled`);
    await page.screenshot({ path: path.join(SHOTS, "enroll-03-environments-online.png"), fullPage: true });
    if (openEnabled > 0) {
      const consoleErrors = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200)); });
      page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 200)}`));
      const sockets = [];
      page.on("websocket", (socket) => sockets.push(socket.url().replace(/token=[^&]+/, "token=…").slice(0, 160)));
      await page.locator('[data-testid="account-machine-open"]:not([disabled])').first().click();
      // Open saves the machine, connects, and takes the person to their work;
      // the saved row lives back on the Environments page.
      await sleep(12_000);
      const landed = page.url();
      await page.goto(`${PORTAL}/environments`, { waitUntil: "domcontentloaded" });
      await sleep(8_000);
      let row = 0;
      for (let i = 0; i < 20 && row === 0; i += 1) {
        row = await page.locator('[data-testid="environment-row"]').count();
        if (row === 0) await sleep(2_000);
      }
      const toasts = await page.locator('[data-slot="toast"], [role="status"], [role="alert"], [data-sonner-toast]').allInnerTexts().catch(() => []);
      const transport = await page.locator('[data-testid="environment-transport"]').allInnerTexts().catch(() => []);
      const rowText = await page.locator('[data-testid="environment-row"]').allInnerTexts().catch(() => []);
      const registry = await page.evaluate(() => window.localStorage.getItem("t3code:saved-environment-registry:v1")).catch((error) => String(error));
      console.log(`  diag sockets=${JSON.stringify(sockets)}`);
      console.log(`  diag registry=${String(registry).replace(/"bearerToken":"[^"]+"/, '"bearerToken":"…"').slice(0, 600)}`);
      console.log(`  diag console=${consoleErrors.slice(0, 5).join(" | ")}`);
      // The authoritative sign of a relayed connection is the hub's own count of
      // open channels on the link: only a browser attached through it opens one.
      let channels = 0;
      for (let i = 0; i < 10 && channels === 0; i += 1) {
        const link = (await linksFor()).find((entry) => entry.environmentId === online?.environmentId);
        channels = link?.openChannels ?? 0;
        if (channels === 0) await sleep(2_000);
      }
      check(
        "Open saves the machine as a browser environment and connects through the relay",
        row > 0 && /Connected/.test(rowText.join(" ")) && (channels > 0 || transport.some((text) => /relay/i.test(text))),
        `landed=${landed.replace(PORTAL, "")} rows=${row} openChannels=${channels} transport=${JSON.stringify(transport)} row=${JSON.stringify(rowText).slice(0, 100)} toasts=${JSON.stringify(toasts).slice(0, 120)} console=${consoleErrors.slice(0, 3).join(" | ")}`,
      );
      await page.screenshot({ path: path.join(SHOTS, "enroll-04-opened-through-relay.png"), fullPage: false });
    }

    phase("The app quits, and the portal says offline");
    await app.close().catch(() => undefined);
    app = null;
    let offline = null;
    for (let i = 0; i < 40 && !offline; i += 1) {
      const links = await linksFor();
      offline = links.find((link) => link.environmentId === online?.environmentId && link.state !== "connected") ?? null;
      if (!offline) await sleep(3_000);
    }
    check("the portal reports the machine offline once its app is closed", offline !== null, offline ? offline.state : "still connected");
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(6_000);
    const statesAfter = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-state")));
    check("the Environments page shows it offline", statesAfter.length > 0 && !statesAfter.includes("connected"), statesAfter.join(", "));
    await page.screenshot({ path: path.join(SHOTS, "enroll-05-environments-offline.png"), fullPage: true });
  } finally {
    await browser.close().catch(() => undefined);
  }
} catch (error) {
  check("the run completed", false, String(error?.message ?? error).slice(0, 200));
} finally {
  await app?.close().catch(() => undefined);
  try {
    const logDir = path.join(SANDBOX, ".t3", "userdata", "logs");
    for (const name of existsSync(logDir) ? readdirSync(logDir) : []) {
      const text = readFileSync(path.join(logDir, name), "utf8");
      const lines = text.split("\n").filter((line) => /enrollment/i.test(line)).slice(-6);
      if (lines.length > 0) console.log(`  ${name}: ${lines.join(" | ").slice(0, 400)}`);
    }
  } catch {
    // nothing to show
  }
  rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(finish());
}
