import { spawn } from "node:child_process";

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
  },
  claude: {
    label: "Claude",
    auth: ["claude", ["auth", "login"]],
    status: ["claude", ["auth", "status", "--json"]],
    logout: ["claude", ["auth", "logout"]],
    prompt: (text: string): readonly [string, ReadonlyArray<string>] => ["claude", ["-p", text]],
    /** Claude's browser hands back a code that has to be typed into it. */
    wantsCode: true,
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

function parse(run: LoginRun): void {
  const clean = stripAnsi(run.output);
  if (run.url === null) {
    // The last URL wins: Codex prints its device page after a preamble, and
    // Claude's authorize link is the only one it prints.
    const found = clean.match(URL_PATTERN);
    if (found && found.length > 0) {
      run.url = found[found.length - 1] ?? null;
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
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  const run: LoginRun = {
    provider,
    output: "",
    url: null,
    code: null,
    done: false,
    exitCode: null,
    write: (text) => {
      child.stdin.write(text);
    },
    stop: () => {
      child.kill("SIGTERM");
    },
  };

  const absorb = (chunk: Buffer | string): void => {
    run.output = `${run.output}${String(chunk)}`.slice(-20_000);
    parse(run);
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

  runs.set(provider, run);
  return run;
}

/** Runs a short command and returns what it said. */
function runOnce(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const absorb = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-40_000);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    child.once("close", () => {
      resolve(stripAnsi(output));
    });
    child.once("error", (error) => {
      resolve(`${output}\n${String(error)}`);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("close", () => clearTimeout(timer));
  });
}

/** Waits briefly for the command to print the thing the person needs. */
async function waitForPrompt(run: LoginRun): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (run.done) return;
    if (run.url !== null && (run.code !== null || !PROVIDERS[run.provider].wantsCode)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
      output: stripAnsi(run.output).slice(-4_000),
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
    // Written to the process's stdin, never to a shell.
    run.write(`${code.trim()}\n`);
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 4_000)));
    return HttpServerResponse.jsonUnsafe({
      done: run.done,
      output: stripAnsi(run.output).slice(-4_000),
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
      loginDone: run?.done ?? true,
      loginOutput: run ? stripAnsi(run.output).slice(-4_000) : "",
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
    const output = yield* Effect.promise(() => runOnce(command, args));
    return HttpServerResponse.jsonUnsafe({
      provider,
      prompt: text,
      output: output.trim().slice(0, 8_000),
    });
  }),
);
