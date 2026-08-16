import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Effect } from "effect";

import { PROVIDER_TEST_PAGE } from "./page.ts";

/**
 * A page for watching a provider login happen, end to end, without a thread.
 *
 * The real connect flow runs its login in a terminal the person is expected to
 * read: `codex login --device-auth` prints a URL and a one-time code, and
 * `claude auth login` prints a URL and then waits on stdin for the code the
 * browser hands back. That is fine for someone at a terminal and no use at all
 * to someone looking at a web app, so this drives both commands and hands back
 * only the two things a person actually needs — where to go, and what to type.
 *
 * It exists to answer one question before the product does: does a second
 * account get its own credentials, or inherit the first one's? Sign in, connect,
 * look at the reported account, log out, connect as somebody else, look again.
 */

const requirePty = (): typeof import("node-pty") =>
  createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

/** Only these run. Nothing here takes a command from the request. */
const PROVIDERS = {
  codex: {
    label: "Codex",
    auth: ["codex", ["login", "--device-auth"]],
    status: ["codex", ["login", "status"]],
    logout: ["codex", ["logout"]],
    prompt: (text: string): readonly [string, ReadonlyArray<string>] => ["codex", ["exec", text]],
    /** Codex shows the code itself; nothing is typed back to it. */
    wantsCode: false,
    needsTerminal: false,
  },
  claude: {
    label: "Claude",
    auth: ["claude", ["setup-token"]],
    status: ["claude", ["auth", "status", "--json"]],
    logout: ["claude", ["auth", "logout"]],
    prompt: (text: string): readonly [string, ReadonlyArray<string>] => ["claude", ["-p", text]],
    /** Claude's browser hands back a code that has to be typed into it. */
    wantsCode: true,
    /**
     * `claude auth login` prints a link and offers nowhere to put the code —
     * pasting into it does nothing, which is where this got stuck. The prompt
     * lives in `setup-token`, and only renders on a real terminal, so this one
     * is driven through a pty.
     */
    needsTerminal: true,
  },
} as const;

type ProviderName = keyof typeof PROVIDERS;

function isProvider(value: unknown): value is ProviderName {
  return value === "codex" || value === "claude";
}

/** Terminal colour and cursor noise, so the page can show plain words. */
function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/g;
/** Codex prints `U8X6-IJJIR`; the shape is stable enough to find it. */
const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

interface LoginRun {
  readonly provider: ProviderName;
  output: string;
  url: string | null;
  code: string | null;
  done: boolean;
  exitCode: number | null;
  write: (text: string) => void;
  stop: () => void;
}

/** One login at a time per provider: a second would race the first for the file. */
const runs = new Map<ProviderName, LoginRun>();

/**
 * Rejoins a link the terminal broke across lines.
 *
 * A full-screen interface wraps at the terminal width, so a long URL arrives
 * split, and each piece on its own is a URL that does not work. Wrapping puts
 * the break at a column rather than at anything meaningful, so a continuation
 * is simply the next line with no space before it.
 */
function unwrapUrls(text: string): string {
  return text.replace(/(https:\/\/[^\s"'<>]*)\r?\n(?=[^\s"'<>]+)/g, "$1");
}

function parse(run: LoginRun): void {
  const clean = unwrapUrls(stripAnsi(run.output));
  if (run.url === null) {
    // The last URL wins: Codex prints its device page after a preamble, and
    // Claude's authorize link is the only one it prints.
    const found = clean.match(URL_PATTERN);
    if (found && found.length > 0) {
      // Longest wins rather than last: if a fragment does slip through, the
      // whole link is always the longer of the two.
      run.url = found.toSorted((left, right) => right.length - left.length)[0] ?? null;
    }
  }
  if (run.code === null) {
    run.code = CODE_PATTERN.exec(clean)?.[0] ?? null;
  }
}

function startLogin(provider: ProviderName): LoginRun {
  const existing = runs.get(provider);
  if (existing && !existing.done) {
    existing.stop();
  }

  const [command, args] = PROVIDERS[provider].auth;
  const run: LoginRun = {
    provider,
    output: "",
    url: null,
    code: null,
    done: false,
    exitCode: null,
    write: () => {},
    stop: () => {},
  };
  const absorb = (chunk: Buffer | string): void => {
    run.output = `${run.output}${String(chunk)}`.slice(-20_000);
    parse(run);
  };

  if (PROVIDERS[provider].needsTerminal) {
    // A terminal, not a pipe: the prompt is drawn by a full-screen interface
    // that renders nothing without TERM and a window size, and reads keys
    // rather than lines. Written to a pipe the code simply vanished.
    const pty = requirePty();
    const session = pty.spawn(command, [...args], {
      name: "xterm-256color",
      // Wide on purpose: the interface hard-wraps at the terminal width, and
      // a wrapped link is a broken link — the first attempt handed out a URL cut
      // off before redirect_uri, which OAuth rejected outright.
      cols: 1000,
      rows: 50,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    run.write = (text) => session.write(text);
    run.stop = () => session.kill();
    session.onData(absorb);
    session.onExit(({ exitCode }) => {
      run.done = true;
      run.exitCode = exitCode;
    });
  } else {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    run.write = (text) => {
      child.stdin.write(text);
    };
    run.stop = () => {
      child.kill("SIGTERM");
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    child.once("close", (code) => {
      run.done = true;
      run.exitCode = code;
    });
    child.once("error", (error) => {
      run.output = `${run.output}\n${String(error)}`;
      run.done = true;
      run.exitCode = -1;
    });
  }

  runs.set(provider, run);
  return run;
}

/** Runs a short command and returns what it said. */
/**
 * Bounded well under the ~100s a proxied request gets: a CLI waiting on
 * credentials it does not have would otherwise hang until the tunnel gave up,
 * which reaches the browser as a failed fetch rather than an answer.
 */
function runOnce(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = 45_000,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let output = "";
    let timedOut = false;
    const absorb = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-40_000);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    child.once("close", () => {
      resolve(
        timedOut
          ? `${stripAnsi(output)}\n[gave up after ${Math.round(timeoutMs / 1000)}s — the command was still waiting]`
          : stripAnsi(output),
      );
    });
    child.once("error", (error) => {
      resolve(`${output}\n${String(error)}`);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", () => clearTimeout(timer));
  });
}

/** Waits briefly for the command to print the thing the person needs. */
async function waitForPrompt(run: LoginRun): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (run.done) return;
    // A URL is all Claude ever prints before it blocks on stdin, so waiting
    // for a code it does not emit only cost twenty seconds every time.
    if (run.url !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Types a code in, the way a keyboard would.
 *
 * The interface reads keys and redraws on each one, so a hundred characters
 * and a carriage return delivered as a single write outrun it: the characters
 * arrive, the return is swallowed while it is still catching up, and the code
 * sits in the box unsubmitted looking exactly like a hang. Sent in small
 * pieces, with the return on its own once the interface has settled, it takes.
 */
async function type(run: LoginRun, text: string): Promise<void> {
  const size = 24;
  for (let at = 0; at < text.length; at += size) {
    run.write(text.slice(at, at + size));
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  run.write("\r");
}

/**
 * Anything that looks like a credential, hidden before it can be shown.
 *
 * `claude setup-token` does not sign the machine in — it prints a token and
 * expects it to be kept. Echoing the terminal verbatim therefore published a
 * year-long credential onto a public page, which is how the first successful
 * login leaked one. Nothing that comes back from a command is shown raw again.
 */
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_\-]+/g, /sk-[A-Za-z0-9_\-]{20,}/g];

function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (carried, pattern) => carried.replace(pattern, "«token hidden»"),
    text,
  );
}

/** The token the interface printed, kept out of every reply. */
const capturedTokens = new Map<ProviderName, string>();

const CLAUDE_TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_\-]+/;

function captureToken(run: LoginRun): void {
  const found = CLAUDE_TOKEN_PATTERN.exec(stripAnsi(run.output).replace(/\s+/g, ""));
  if (found) {
    capturedTokens.set(run.provider, found[0]);
  }
}

/** The words the interface uses when it has finished with the code. */
const FAILURE_PATTERN = /(error|invalid|failed|expired|try again|retry)/i;
const SUCCESS_PATTERN = /(success|logged in|signed in|token (created|saved)|you can now)/i;

/**
 * Collapses a redrawn terminal into something a person can read.
 *
 * The interface paints with cursor moves and pads every line to the terminal
 * width, so the raw stream is mostly spaces and escape codes.
 */
function readable(raw: string): string {
  return redactSecrets(stripAnsi(raw))
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/** Waits for the interface to answer the code, rather than for a fixed delay. */
async function waitForAnswer(
  run: LoginRun,
  before: string,
): Promise<"accepted" | "failed" | "unknown"> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const fresh = readable(run.output.slice(before.length));
    if (SUCCESS_PATTERN.test(fresh)) return "accepted";
    if (FAILURE_PATTERN.test(fresh)) return "failed";
    if (run.done) return "unknown";
  }
  return "unknown";
}

/** An unreadable body is the same as an empty one here: the handlers validate. */
const jsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));

function providerOf(body: unknown): ProviderName | null {
  const value = (body as { provider?: unknown } | null)?.provider;
  return isProvider(value) ? value : null;
}

export const providerTestPageRouteLayer = HttpRouter.add(
  "GET",
  "/provider-test",
  Effect.succeed(
    HttpServerResponse.text(PROVIDER_TEST_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  ),
);

export const providerTestStartRouteLayer = HttpRouter.add(
  "POST",
  "/api/provider-test/start",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const provider = providerOf(yield* jsonBody(request));
    if (provider === null) {
      return HttpServerResponse.jsonUnsafe({ error: "unknown provider" }, { status: 400 });
    }
    const run = startLogin(provider);
    yield* Effect.promise(() => waitForPrompt(run));
    return HttpServerResponse.jsonUnsafe({
      provider,
      label: PROVIDERS[provider].label,
      url: run.url,
      code: run.code,
      wantsCode: PROVIDERS[provider].wantsCode,
      done: run.done,
      output: readable(run.output).slice(-4_000),
    });
  }),
);

export const providerTestCodeRouteLayer = HttpRouter.add(
  "POST",
  "/api/provider-test/code",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* jsonBody(request);
    const provider = providerOf(body);
    const code = (body as { code?: unknown } | null)?.code;
    if (provider === null || typeof code !== "string" || code.trim().length === 0) {
      return HttpServerResponse.jsonUnsafe(
        { error: "provider and code required" },
        { status: 400 },
      );
    }
    const run = runs.get(provider);
    if (!run || run.done) {
      return HttpServerResponse.jsonUnsafe({ error: "no login in progress" }, { status: 409 });
    }
    // Sent as keystrokes to the terminal, never to a shell.
    const before = run.output;
    yield* Effect.promise(() => type(run, code.trim()));
    // The exchange is a round trip to the provider, so wait for the interface
    // to actually say something rather than guessing at a delay — a fixed
    // pause reported "submitted" while the answer arrived seconds later and
    // was never shown.
    const settled = yield* Effect.promise(() => waitForAnswer(run, before));
    captureToken(run);
    return HttpServerResponse.jsonUnsafe({
      done: run.done,
      accepted: settled === "accepted",
      failed: settled === "failed",
      // Whether a credential was obtained, never the credential.
      tokenCaptured: capturedTokens.has(provider),
      output: readable(run.output).slice(-4_000),
    });
  }),
);

export const providerTestStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/provider-test/status",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = Array.isArray(request.url) ? request.url[0] : request.url;
    const provider = new URL(requestUrl ?? "/", "http://localhost").searchParams.get("provider");
    if (!isProvider(provider)) {
      return HttpServerResponse.jsonUnsafe({ error: "unknown provider" }, { status: 400 });
    }
    const [command, args] = PROVIDERS[provider].status;
    const output = yield* Effect.promise(() => runOnce(command, args));
    const run = runs.get(provider);
    return HttpServerResponse.jsonUnsafe({
      provider,
      label: PROVIDERS[provider].label,
      // The words the CLI used, so the page never claims more than it was told.
      status: output.trim().slice(0, 4_000),
      // `claude auth status` reports the shared credential file, which
      // setup-token never writes — so say separately whether this flow got one.
      tokenCaptured: capturedTokens.has(provider),
      loginDone: run?.done ?? true,
      loginOutput: run ? readable(run.output).slice(-4_000) : "",
    });
  }),
);

export const providerTestLogoutRouteLayer = HttpRouter.add(
  "POST",
  "/api/provider-test/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const provider = providerOf(yield* jsonBody(request));
    if (provider === null) {
      return HttpServerResponse.jsonUnsafe({ error: "unknown provider" }, { status: 400 });
    }
    runs.get(provider)?.stop();
    runs.delete(provider);
    const [command, args] = PROVIDERS[provider].logout;
    const output = yield* Effect.promise(() => runOnce(command, args));
    return HttpServerResponse.jsonUnsafe({ provider, output: output.trim().slice(0, 2_000) });
  }),
);

export const providerTestPromptRouteLayer = HttpRouter.add(
  "POST",
  "/api/provider-test/prompt",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* jsonBody(request);
    const provider = providerOf(body);
    const rawText = (body as { text?: unknown } | null)?.text;
    const text =
      typeof rawText === "string" && rawText.trim().length > 0 ? rawText.trim() : "Say OK";
    if (provider === null) {
      return HttpServerResponse.jsonUnsafe({ error: "unknown provider" }, { status: 400 });
    }
    // Passed as one argument, not through a shell, so its content stays content.
    const [command, args] = PROVIDERS[provider].prompt(text.slice(0, 2_000));
    // `setup-token` hands back a token rather than signing the machine in, so
    // the credential has to be given to the command that uses it. This is the
    // shape per-user access wants anyway: a token belonging to one person,
    // handed to one process, rather than a file every user of the box shares.
    const token = capturedTokens.get(provider);
    const extraEnv =
      provider === "claude" && token !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
    const output = yield* Effect.promise(() => runOnce(command, args, 45_000, extraEnv));
    return HttpServerResponse.jsonUnsafe({
      provider,
      prompt: text,
      output: output.trim().slice(0, 8_000),
    });
  }),
);
