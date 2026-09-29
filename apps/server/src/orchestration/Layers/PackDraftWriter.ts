/**
 * Labels a completed turn via the typed-decision model (`TurnLabeling.ts`)
 * and, if it's worth keeping, appends it to the workspace's pack draft file
 * (`PackDraft.ts`) at `<workspace>/.t3pack/draft.pack.json`.
 *
 * Deliberately fire-and-forget from the caller's point of view: every
 * failure here (network, malformed response, disk) is caught and logged,
 * never propagated — this is a courtesy feature layered on top of a real
 * turn completing, the same posture the promptbar's own retrieval legs and
 * stage-3 decision step already take. A person's turn finishing correctly
 * must never depend on this succeeding.
 *
 * Shares the same decision-model config (`T3CODE_OPENROUTER_API_KEY`/
 * `T3CODE_DECISION_API_URL`/`T3CODE_DECISION_MODEL`) as the promptbar's own
 * Jev usage, but is intentionally self-contained rather than importing from
 * `promptbar/Layers/PromptbarClient.ts` — that module's internals aren't
 * exported, and this is new, not-yet-load-bearing functionality that
 * shouldn't risk destabilizing an already-verified, deployed one.
 *
 * @module PackDraftWriter
 */
import { Config, Effect, FileSystem, Option, Path } from "effect";

import {
  appendPackDraftEntry,
  createEmptyPackDraft,
  shouldKeepLabeledTurn,
  type PackDraft,
  type PackDraftEntry,
} from "../../promptbar/PackDraft.ts";
import {
  buildTurnLabelQuestions,
  buildTurnLabelState,
  parseTurnLabelAnswers,
  type TurnLabelingInput,
} from "../../promptbar/TurnLabeling.ts";

const PackDraftEnvConfig = Config.all({
  apiKey: Config.string("T3CODE_OPENROUTER_API_KEY").pipe(Config.option),
  decisionApiUrl: Config.string("T3CODE_DECISION_API_URL").pipe(
    Config.withDefault("https://openrouter.ai/api/alpha/decisions"),
  ),
  decisionModel: Config.string("T3CODE_DECISION_MODEL").pipe(Config.withDefault("typesafe/jev-1.13")),
});

const PACK_DRAFT_DIR = ".t3pack";
const PACK_DRAFT_FILENAME = "draft.pack.json";

interface DecisionApiAnswer {
  readonly choice?: unknown;
  readonly probabilities?: unknown;
  readonly noul?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDecisionApiResponse(
  value: unknown,
): value is { readonly answers: Readonly<Record<string, DecisionApiAnswer>> } {
  return isPlainRecord(value) && isPlainRecord(value["answers"]);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface LabelAndRecordTurnInput {
  readonly turnId: string;
  readonly projectId: string;
  readonly workspaceCwd: string;
  readonly createdAt: string;
  readonly labeling: TurnLabelingInput;
  readonly changedFiles: ReadonlyArray<string>;
}

/**
 * The whole pipeline for one turn: label it, and if it's worth keeping,
 * fold it into the workspace's pack draft file. Never fails — every error
 * path logs a warning and returns, by design (see module doc comment).
 */
export const labelAndRecordTurn = (input: LabelAndRecordTurnInput) =>
  Effect.gen(function* () {
    const config = yield* PackDraftEnvConfig.asEffect();
    if (Option.isNone(config.apiKey)) {
      return;
    }
    const apiKey = config.apiKey.value;

    const state = buildTurnLabelState(input.labeling);
    const questions = buildTurnLabelQuestions();

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(config.decisionApiUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: config.decisionModel, state, questions }),
        }),
      catch: (cause) => new Error(`Pack draft labeling request failed: ${describeCause(cause)}`),
    }).pipe(
      Effect.filterOrFail(
        (res) => res.ok,
        (res) => new Error(`Pack draft labeling model responded with ${res.status}.`),
      ),
      Effect.flatMap((res) =>
        Effect.tryPromise({
          try: () => res.json() as Promise<unknown>,
          catch: (cause) => new Error(`Pack draft labeling model returned an unreadable response: ${describeCause(cause)}`),
        }),
      ),
    );

    if (!isDecisionApiResponse(response)) {
      yield* Effect.logWarning("pack_draft.labeling_bad_shape", { turnId: input.turnId });
      return;
    }

    const label = parseTurnLabelAnswers(response.answers);
    if (label === null) {
      yield* Effect.logWarning("pack_draft.labeling_unparseable", { turnId: input.turnId });
      return;
    }
    if (!shouldKeepLabeledTurn(label)) {
      return;
    }

    const entry: PackDraftEntry = {
      turnId: input.turnId,
      createdAt: input.createdAt,
      userPrompt: input.labeling.userPrompt,
      assistantSummary: input.labeling.assistantSummary,
      changedFiles: input.changedFiles,
      outcome: label.outcome,
      outcomeConfidence: label.outcomeConfidence,
      findingCategory: label.findingCategory,
      findingCategoryConfidence: label.findingCategoryConfidence,
      worthKeeping: label.worthKeeping,
    };

    yield* appendEntryToDraftFile({
      workspaceCwd: input.workspaceCwd,
      projectId: input.projectId,
      entry,
      now: input.createdAt,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("pack_draft.turn_labeling_failed", { turnId: input.turnId, cause }),
    ),
  );

const appendEntryToDraftFile = (input: {
  readonly workspaceCwd: string;
  readonly projectId: string;
  readonly entry: PackDraftEntry;
  readonly now: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const draftDir = path.join(input.workspaceCwd, PACK_DRAFT_DIR);
    const draftPath = path.join(draftDir, PACK_DRAFT_FILENAME);

    const existing = yield* fileSystem.readFileString(draftPath).pipe(
      Effect.map((contents): PackDraft | null => {
        try {
          return JSON.parse(contents) as PackDraft;
        } catch {
          return null;
        }
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

    const draft =
      existing ??
      createEmptyPackDraft({
        packDraftId: crypto.randomUUID(),
        projectId: input.projectId,
        now: input.now,
      });
    const nextDraft = appendPackDraftEntry(draft, input.entry, input.now);

    yield* fileSystem.makeDirectory(draftDir, { recursive: true });
    yield* fileSystem.writeFileString(draftPath, `${JSON.stringify(nextDraft, null, 2)}\n`);
  });
