/**
 * The whole page, inline, because it is a test surface and a self-contained
 * file is easier to read, change and delete than one wired into the app build.
 */
export const PROVIDER_TEST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>T3 provider login test</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d10; --fg:#e6e8eb; --muted:#9aa3ad; --line:#232830;
          --accent:#5b9dff; --ok:#3fb950; --bad:#f85149; --card:#12151a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 780px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 28px; }
  section { border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; background:var(--card); }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 14px; font-weight:600; }
  label { display:block; font-size:13px; color:var(--muted); margin:0 0 6px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line);
          background:#0e1116; color:var(--fg); font:inherit; margin-bottom:12px; }
  button { padding:10px 16px; border-radius:8px; border:1px solid var(--line); background:#1b2029;
           color:var(--fg); font:inherit; font-weight:500; cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:default; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#06121f; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:620px) { .grid { grid-template-columns:1fr; } }
  pre { background:#0e1116; border:1px solid var(--line); border-radius:8px; padding:12px;
        overflow:auto; max-height:260px; font-size:12.5px; white-space:pre-wrap; word-break:break-word; margin:12px 0 0; }
  .code { font:600 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em;
          background:#0e1116; border:1px dashed var(--accent); border-radius:8px; padding:14px; text-align:center; margin:12px 0; }
  a.open { display:inline-block; padding:10px 16px; border-radius:8px; background:var(--accent);
           color:#06121f; font-weight:600; text-decoration:none; }
  .muted { color:var(--muted); font-size:13px; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .hidden { display:none; }
  .who { font-size:13px; padding:8px 10px; border-radius:8px; background:#0e1116; border:1px solid var(--line); margin-top:10px; }
</style>
</head>
<body>
<main>
  <h1>Provider login test</h1>
  <p class="sub">Sign in, connect Claude or Codex, and see which account it ends up as.</p>

  <section id="loginCard">
    <h2>1 &middot; Sign in</h2>
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" placeholder="you@example.com" />
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="password" />
    <div class="row">
      <button class="primary" id="signup">Create account</button>
      <button id="login">Log in</button>
      <span id="loginMsg" class="muted"></span>
    </div>
  </section>

  <section id="connectCard">
    <h2>2 &middot; Connect a provider</h2>
    <div class="grid">
      <div>
        <button id="connectClaude" style="width:100%">Connect Claude</button>
        <div class="who" id="claudeWho">not checked</div>
      </div>
      <div>
        <button id="connectCodex" style="width:100%">Connect Codex</button>
        <div class="who" id="codexWho">not checked</div>
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <button id="refresh">Check status</button>
      <button id="logoutClaude">Log out Claude</button>
      <button id="logoutCodex">Log out Codex</button>
    </div>
  </section>

  <section id="stepCard" class="hidden">
    <h2>3 &middot; Finish in your browser</h2>
    <div id="stepBody"></div>
  </section>

  <section>
    <h2>4 &middot; Prompt it</h2>
    <label for="prompt">Prompt</label>
    <input id="prompt" value="Reply with exactly: OK" />
    <div class="row">
      <button id="promptClaude">Prompt Claude</button>
      <button id="promptCodex">Prompt Codex</button>
      <span id="promptMsg" class="muted"></span>
    </div>
    <pre id="promptOut" class="hidden"></pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
// Every call goes through here so a dropped request shows up as words on the
// page. Left to reject on its own it surfaced as "Unhandled Promise Rejection:
// TypeError: Load failed" in the console and nothing at all in the interface.
const post = async (path, body) => {
  try {
    const res = await fetch(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}), credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: "could not reach the server (" + error + ")" } };
  }
};
const getJson = async (path) => {
  try {
    const res = await fetch(path, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (error) {
    return { ok: false, data: { error: "could not reach the server (" + error + ")" } };
  }
};
window.addEventListener("unhandledrejection", (event) => {
  const box = $("promptMsg");
  if (box) box.textContent = "unexpected error: " + (event.reason && event.reason.message || event.reason);
});

async function auth(mode) {
  const email = $("email").value.trim(), password = $("password").value;
  if (!email || !password) { $("loginMsg").textContent = "email and password required"; return; }
  $("loginMsg").textContent = mode === "signup" ? "creating…" : "signing in…";
  const r = await post("/api/auth/password", { email, password, mode });
  $("loginMsg").innerHTML = r.ok
    ? '<span class="ok">signed in as ' + email + '</span>'
    : '<span class="bad">' + (r.data.message || r.data.error || ("failed (" + r.status + ")")) + "</span>";
}
$("signup").onclick = () => auth("signup");
$("login").onclick = () => auth("login");

function renderStep(d) {
  $("stepCard").classList.remove("hidden");
  const parts = [];
  if (d.url) {
    parts.push('<p>Open this and sign in to your ' + d.label + ' account:</p>');
    parts.push('<p><a class="open" href="' + d.url + '" target="_blank" rel="noreferrer">Open ' + d.label + ' sign-in</a></p>');
  }
  if (d.code) {
    parts.push("<p>Enter this one-time code there:</p>");
    parts.push('<div class="code">' + d.code + "</div>");
  }
  if (d.wantsCode) {
    parts.push('<p>Then paste the code it gives you back here:</p>');
    parts.push('<input id="pasteCode" placeholder="paste code from the browser" />');
    parts.push('<div class="row"><button class="primary" id="submitCode">Submit code</button><span id="codeMsg" class="muted"></span></div>');
  }
  if (!d.url && !d.code) {
    parts.push('<p class="bad">No sign-in link was printed. Raw output below.</p>');
  }
  parts.push('<pre id="stepOut">' + (d.output || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) + "</pre>");
  $("stepBody").innerHTML = parts.join("");
  const submit = $("submitCode");
  if (submit) {
    submit.onclick = async () => {
      const code = $("pasteCode").value.trim();
      if (!code) return;
      submit.disabled = true;
      $("codeMsg").textContent = "submitting — waiting for the provider…";
      const r = await post("/api/provider-test/code", { provider: d.provider, code });
      submit.disabled = false;
      // The interface answers after a round trip to the provider, so show what
      // it actually said. Leaving the original output on screen made a refusal
      // look identical to nothing happening at all.
      if (r.data && typeof r.data.output === "string") {
        const box = $("stepOut");
        if (box) box.textContent = r.data.output;
      }
      $("codeMsg").innerHTML = !r.ok
        ? '<span class="bad">' + (r.data.error || "failed") + "</span>"
        : r.data.accepted
          ? '<span class="ok">accepted</span>'
          : r.data.failed
            ? '<span class="bad">the provider refused that code — press Connect again for a fresh link</span>'
            : "submitted — no clear answer yet, check status";
      await status(d.provider);
    };
  }
}

async function connect(provider) {
  const btn = provider === "claude" ? $("connectClaude") : $("connectCodex");
  const label = btn.textContent; btn.disabled = true; btn.textContent = "starting…";
  const r = await post("/api/provider-test/start", { provider });
  btn.disabled = false; btn.textContent = label;
  if (r.ok) renderStep(r.data);
  else { $("stepCard").classList.remove("hidden"); $("stepBody").innerHTML = '<p class="bad">' + (r.data.error || "failed") + "</p>"; }
}
$("connectClaude").onclick = () => connect("claude");
$("connectCodex").onclick = () => connect("codex");

async function status(provider) {
  const cell = provider === "claude" ? $("claudeWho") : $("codexWho");
  cell.textContent = "checking…";
  const r = await getJson("/api/provider-test/status?provider=" + provider);
  const d = r.data || {};
  // "claude auth status" reads a shared credential file that setup-token never
  // writes, so it says "not logged in" about a login that worked. Lead with
  // whether this flow holds a token, and keep the CLI's own words underneath.
  // (No backticks in here: this whole page is one template literal.)
  const held = d.tokenCaptured
    ? '<span class="ok">connected — token held for this session</span><br>'
    : "";
  cell.innerHTML = held + '<span class="muted">' +
    ((d.status || d.error || "no answer") + "").slice(0, 400).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) +
    "</span>";
}
$("refresh").onclick = () => { status("claude"); status("codex"); };
$("logoutClaude").onclick = async () => { await post("/api/provider-test/logout", { provider: "claude" }); status("claude"); };
$("logoutCodex").onclick = async () => { await post("/api/provider-test/logout", { provider: "codex" }); status("codex"); };

async function prompt(provider) {
  $("promptMsg").textContent = "running… (up to 45s)";
  $("promptOut").classList.remove("hidden");
  $("promptOut").textContent = "";
  const r = await post("/api/provider-test/prompt", { provider, text: $("prompt").value });
  $("promptMsg").textContent = r.ok ? "done" : "failed";
  $("promptOut").textContent = r.data.output || r.data.error || "(no output)";
}
$("promptClaude").onclick = () => prompt("claude");
$("promptCodex").onclick = () => prompt("codex");

status("claude"); status("codex");
</script>
</body>
</html>
`;
