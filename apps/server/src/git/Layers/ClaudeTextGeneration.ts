/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGenerationShape contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ClaudeModelSelection } from "@t3tools/contracts";
import { resolveApiModelId } from "@t3tools/shared/model";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "@t3tools/contracts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import { normalizeClaudeModelOptionsWithCapabilities } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";
import { getClaudeModelCapabilities } from "../../provider/Layers/ClaudeProvider.ts";

const CLAUDE_TIMEOUT_MS = 180_000;

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * We only care about `structured_output`.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});

const makeClaudeTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  /**
   * Whether the Claude login this process can reach belongs to the only person
   * who could be asking for a thread title.
   *
   * This spawn passed no `env` at all, which is worse than it looks: the child
   * inherits the whole server process environment, so `HOME` points at the
   * operator's home and `claude -p` signs in as them — with
   * `--dangerously-skip-permissions` on, in the caller's working directory. On
   * a desktop install that is the person typing, on their own subscription. On
   * a host with other accounts on it, every first turn and every pull request
   * body is generated on the operator's Claude subscription, from a prompt
   * somebody else wrote.
   *
   * `TextGenerationShape` carries no identity, so there is no acting user to
   * resolve here and the only honest alternative to the operator's login is
   * none at all. A missing thread title is a nicety the caller already handles;
   * spending an unrelated person's Claude quota to supply it is not.
   */
  const machineLoginIsTheOnlyUsers =
    isLoopbackHost(serverConfig.host) &&
    !isWildcardHost(serverConfig.host) &&
    !serverConfig.publishedBeyondLoopback;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ClaudeModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    // Before anything is built or spawned: on a shared host there is no Claude
    // account here that may be spent. See `machineLoginIsTheOnlyUsers`.
    if (!machineLoginIsTheOnlyUsers) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Refusing to run Claude text generation on this server's own Claude login: this host has other accounts on it, and T3 cannot tell whose Claude account asked for it. Connect a Claude account and start the turn again.",
      });
    }
    const jsonSchemaStr = JSON.stringify(toJsonSchemaObject(outputSchemaJson));
    const normalizedOptions = normalizeClaudeModelOptionsWithCapabilities(
      getClaudeModelCapabilities(modelSelection.model),
      modelSelection.options,
    );
    const settings = {
      ...(typeof normalizedOptions?.thinking === "boolean"
        ? { alwaysThinkingEnabled: normalizedOptions.thinking }
        : {}),
      ...(normalizedOptions?.fastMode ? { fastMode: true } : {}),
    };

    const claudeSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.claudeAgent,
    ).pipe(Effect.catch(() => Effect.undefined));

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      const command = ChildProcess.make(
        claudeSettings?.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveApiModelId(modelSelection),
          ...(normalizedOptions?.effort ? ["--effort", normalizedOptions.effort] : []),
          ...(Object.keys(settings).length > 0 ? ["--settings", JSON.stringify(settings)] : []),
          "--dangerously-skip-permissions",
        ],
        {
          /**
           * Stated rather than inherited.
           *
           * This spawn used to pass no `env` at all, which handed the child the
           * whole server process environment — the operator's `HOME`, their
           * `CLAUDE_CODE_OAUTH_TOKEN`, their `ANTHROPIC_API_KEY` — and so ran
           * `claude -p --dangerously-skip-permissions` as them for whoever had
           * typed the prompt. It is the server's own environment again here,
           * but only because the guard at the top of `runClaudeJson` has
           * already established that the machine's login is the asking
           * person's login. Anything that lets a second person reach this
           * function has to replace this expression with an environment built
           * from *their* resolved account —
           * `filterProviderLaunchBaseEnv(process.env)` plus
           * `providerCredentialEnvForAccount`, the way
           * `ProviderCommandReactor.resolveConnectedLaunchEnvironment` does —
           * and this line is written out so that there is somewhere obvious to
           * do it.
           */
          env: { ...process.env },
          cwd,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope))(
      rawStdout,
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned unexpected output format.",
            cause,
          }),
        ),
      ),
    );

    return yield* Schema.decodeEffect(outputSchemaJson)(envelope.structured_output).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGenerationShape methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ClaudeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ClaudeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const ClaudeTextGenerationLive = Layer.effect(TextGeneration, makeClaudeTextGeneration);
