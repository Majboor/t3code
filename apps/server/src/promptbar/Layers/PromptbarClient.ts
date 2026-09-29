import { Config, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { defaultPacksDir, loadPromptbarPacks, type PromptbarPackDefinition } from "../PackSource.ts";
import { rebuildFtsIndex, searchFtsPhrasings, type FtsHit } from "../PackFts.ts";
import { resolveEffectiveIntent, zoneForConfidence, type IntentScores } from "../intentRouting.ts";
import {
  applyDecisionRelevance,
  buildDecisionQuestions,
  buildDecisionState,
  parseDecisionAnswers,
  type DecisionQuestion,
} from "../PackDecision.ts";
import { buildIntentQuestion, parseIntentAnswer } from "../IntentClassification.ts";
import {
  bestRankPerPack,
  computeSkipAgent,
  normalizeRrfScores,
  reciprocalRankFusion,
  topFusedPackIds,
  type RetrievalHit,
} from "../retrieval.ts";
import {
  PromptbarClient,
  PromptbarError,
  type PromptbarCandidate,
  type PromptbarClientShape,
  type PromptbarIntent,
  type PromptbarResolveInput,
  type PromptbarZone,
} from "../Services/PromptbarClient.ts";

const PromptbarEnvConfig = Config.all({
  embeddingUrl: Config.string("T3CODE_EMBEDDING_URL").pipe(
    Config.withDefault("http://192.168.18.201:9400"),
  ),
  qdrantUrl: Config.string("T3CODE_QDRANT_URL").pipe(Config.withDefault("http://192.168.18.201:6333")),
});

/**
 * Typed-decision model config — today OpenRouter's `typesafe/jev-1.13`,
 * doing double duty as both stage 1 (intent classification, replacing the
 * old bespoke classifier service — its quality was the reason for the
 * switch) and stage 3 (pack disambiguation when retrieval's own top
 * candidates are too close to call). Swapping to a self-hosted
 * GLiClass-style model later is changing `decisionApiUrl`/`decisionModel`/
 * the request-building in `callDecisionModel`, nothing else in `resolve()`
 * — the rest of the pipeline only ever sees this module's own parsed
 * shapes (`IntentClassification.ts`/`PackDecision.ts`), never the
 * provider's own response format.
 *
 * Absent API key fails `classify` outright (same "typed not-configured
 * error" convention this module has always had for its classifier — there
 * is no fallback classifier anymore, this replaced it) but only degrades
 * the stage-3 step (retrieval's own ranking stands alone without it) —
 * stage 3 was always optional, stage 1 never was.
 */
const PromptbarDecisionEnvConfig = Config.all({
  apiKey: Config.string("T3CODE_OPENROUTER_API_KEY").pipe(Config.option),
  decisionApiUrl: Config.string("T3CODE_DECISION_API_URL").pipe(
    Config.withDefault("https://openrouter.ai/api/alpha/decisions"),
  ),
  decisionModel: Config.string("T3CODE_DECISION_MODEL").pipe(Config.withDefault("typesafe/jev-1.13")),
});

/** Each hybrid-retrieval leg pulls this many phrasing-level hits before fusion; the spec calls for "top ~20". */
const RETRIEVAL_LEG_LIMIT = 20;
const QDRANT_PHRASINGS_COLLECTION = "pack_phrasings";

interface ClassifyResponse {
  readonly intent: PromptbarIntent;
  readonly confidence: number;
  readonly zone: PromptbarZone;
  readonly all: IntentScores;
}

interface EmbedResponse {
  readonly model: string;
  readonly dim: number;
  readonly vector: ReadonlyArray<number>;
}

interface QdrantSearchResponse {
  readonly result: ReadonlyArray<{
    readonly id: number | string;
    readonly score: number;
    readonly payload?: {
      readonly pack_id?: string;
      readonly name?: string;
      readonly description?: string;
      readonly matched_phrasing?: string;
    };
  }>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEmbedResponse(value: unknown): value is EmbedResponse {
  return isPlainRecord(value) && Array.isArray(value["vector"]) && typeof value["dim"] === "number";
}

interface DecisionApiResponse {
  readonly answers: Readonly<
    Record<string, { readonly noul?: unknown; readonly choice?: unknown; readonly probabilities?: unknown }>
  >;
}

function isDecisionApiResponse(value: unknown): value is DecisionApiResponse {
  return isPlainRecord(value) && isPlainRecord(value["answers"]);
}

/**
 * `PromptbarError` (frozen, in `../Services/PromptbarClient.ts`) carries only
 * `message`/`status`, no `cause` — unlike `PersistenceSqlError` and most of
 * this codebase's other tagged errors. Folding the cause's own message in
 * here is how that detail survives into an HTTP error body instead of being
 * silently dropped.
 */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const make = Effect.gen(function* () {
  const config = yield* PromptbarEnvConfig.asEffect();
  const decisionConfig = yield* PromptbarDecisionEnvConfig.asEffect();
  const sql = yield* SqlClient.SqlClient;

  const packs = yield* loadPromptbarPacks(defaultPacksDir());
  const packsById = new Map<string, PromptbarPackDefinition>(packs.map((pack) => [pack.id, pack]));

  yield* rebuildFtsIndex(packs).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError(
      (error) => new PromptbarError({ message: `Failed to build the pack phrasing index: ${error.message}` }),
    ),
  );

  yield* Effect.log("promptbar.packs.indexed", { count: packs.length, ids: packs.map((p) => p.id) });

  const postJson = (url: string, body: unknown, extraHeaders?: Record<string, string>) =>
    Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...extraHeaders },
          body: JSON.stringify(body),
        }),
      catch: (cause) => new PromptbarError({ message: `Request to ${url} failed: ${describeCause(cause)}` }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response)
          : Effect.fail(
              new PromptbarError({
                message: `${url} responded with ${response.status}.`,
                status: response.status,
              }),
            ),
      ),
    );

  /** Shared by both stage 1 (classify) and stage 3 (judgeCandidates) — the only difference between them is how each treats a missing API key or a failure. */
  const callDecisionModel = (apiKey: string, state: string, questions: unknown) =>
    postJson(
      decisionConfig.decisionApiUrl,
      { model: decisionConfig.decisionModel, state, questions },
      { authorization: `Bearer ${apiKey}` },
    ).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) => new PromptbarError({ message: `Decision model returned an unreadable response: ${describeCause(cause)}` }),
        }),
      ),
      Effect.flatMap((json) =>
        isDecisionApiResponse(json)
          ? Effect.succeed(json)
          : Effect.fail(new PromptbarError({ message: "The decision model's response did not match the expected shape." })),
      ),
    );

  /**
   * Stage 1: was the bespoke classifier service, now the same typed-decision
   * model as stage 3, asked a `choice` question over the four intents.
   * `zone` is never asked for — it has always been a pure function of
   * confidence alone (`zoneForConfidence`). No API key configured is a hard
   * failure here (unlike stage 3): there is no fallback classifier anymore.
   */
  const classify = (text: string, recentContext: PromptbarResolveInput["recentContext"]) =>
    Effect.gen(function* () {
      if (Option.isNone(decisionConfig.apiKey)) {
        return yield* new PromptbarError({
          message: "The intent decision model is not configured (T3CODE_OPENROUTER_API_KEY missing).",
        });
      }
      const state = buildDecisionState(recentContext, text);
      const response = yield* callDecisionModel(decisionConfig.apiKey.value, state, buildIntentQuestion());
      const parsed = parseIntentAnswer(response.answers);
      if (parsed === null) {
        return yield* new PromptbarError({
          message: "The intent decision model's response did not include a usable intent answer.",
        });
      }
      const confidence = parsed.probabilities[parsed.intent];
      return {
        intent: parsed.intent,
        confidence,
        zone: zoneForConfidence(confidence),
        all: parsed.probabilities,
      } satisfies ClassifyResponse;
    });

  const embed = (text: string) =>
    postJson(`${config.embeddingUrl}/embed`, { text }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) => new PromptbarError({ message: `The embedding service returned an unreadable response: ${describeCause(cause)}` }),
        }),
      ),
      Effect.flatMap((json) =>
        isEmbedResponse(json)
          ? Effect.succeed(json.vector)
          : Effect.fail(new PromptbarError({ message: "The embedding service's response did not match the expected shape." })),
      ),
    );

  const denseSearch = (vector: ReadonlyArray<number>, limit: number) =>
    postJson(`${config.qdrantUrl}/collections/${QDRANT_PHRASINGS_COLLECTION}/points/search`, {
      vector,
      limit,
      with_payload: true,
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<QdrantSearchResponse>,
          catch: (cause) => new PromptbarError({ message: `Qdrant returned an unreadable response: ${describeCause(cause)}` }),
        }),
      ),
      Effect.map(
        (body): ReadonlyArray<RetrievalHit> =>
          body.result.flatMap((point) => (point.payload?.pack_id ? [{ packId: point.payload.pack_id }] : [])),
      ),
    );

  /**
   * Both legs degrade independently rather than failing `resolve` outright:
   * retrieval's whole job is recall, and a temporarily-unreachable embedding
   * service or a bad BM25 query should mean "fall back to the other leg",
   * not "the composer can no longer suggest a pack at all" (which is
   * strictly worse for the user than one leg's worth of candidates).
   */
  const denseLeg = (text: string) =>
    embed(text).pipe(
      Effect.flatMap((vector) => denseSearch(vector, RETRIEVAL_LEG_LIMIT)),
      Effect.catch((error) =>
        Effect.logWarning("promptbar.dense_leg_failed", { message: error.message }).pipe(
          Effect.as([] as ReadonlyArray<RetrievalHit>),
        ),
      ),
    );

  const bm25Leg = (text: string) =>
    searchFtsPhrasings(text, RETRIEVAL_LEG_LIMIT).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch((error) =>
        Effect.logWarning("promptbar.bm25_leg_failed", { message: error.message }).pipe(
          Effect.as([] as ReadonlyArray<FtsHit>),
        ),
      ),
    );

  const retrieveCandidates = (text: string, k: number) =>
    Effect.gen(function* () {
      const [dense, bm25] = yield* Effect.all([denseLeg(text), bm25Leg(text)], { concurrency: "unbounded" });

      const fused = reciprocalRankFusion([bestRankPerPack(bm25), bestRankPerPack(dense)]);
      const normalized = normalizeRrfScores(fused, 2);
      const top = topFusedPackIds(normalized, k);

      const candidates: PromptbarCandidate[] = [];
      for (const { packId, score } of top) {
        const pack = packsById.get(packId);
        if (pack === undefined) {
          yield* Effect.logWarning("promptbar.candidate_pack_unknown", { packId });
          continue;
        }
        candidates.push({
          packId: pack.id,
          name: pack.name,
          description: pack.description,
          retrievalScore: score,
          decisionRelevance: null,
          params: pack.params,
        });
      }
      return candidates;
    });

  /**
   * Stage 3: only runs when retrieval's own top candidates were too close to
   * call. Returns `null` (not a failure) whenever the decision step can't
   * meaningfully run or help — no API key configured, nothing to judge, or
   * the call itself failed — so `resolve` always has retrieval's ranking to
   * fall back to.
   */
  const judgeCandidates = (state: string, candidates: ReadonlyArray<PromptbarCandidate>) =>
    Effect.gen(function* () {
      if (Option.isNone(decisionConfig.apiKey) || candidates.length === 0) {
        return null;
      }
      const questions: Record<string, DecisionQuestion> = buildDecisionQuestions(candidates);
      const parsed = yield* callDecisionModel(decisionConfig.apiKey.value, state, questions).pipe(
        // A stage-3 failure degrades to "retrieval's ranking stands alone",
        // the same posture the two retrieval legs already take individually
        // — never sink the whole `resolve` call over it.
        Effect.catch((error) =>
          Effect.logWarning("promptbar.decision_model_failed", { message: error.message }).pipe(
            Effect.as(null),
          ),
        ),
      );

      return parsed === null ? null : parseDecisionAnswers(parsed.answers, candidates);
    });

  const resolve: PromptbarClientShape["resolve"] = (input) =>
    Effect.gen(function* () {
      const k = input.k ?? 5;
      const classified = yield* classify(input.text, input.recentContext);
      const effective = resolveEffectiveIntent(classified, input.isFirstMessageInSession);

      if (effective.intent !== "ACTION") {
        return {
          intent: effective.intent,
          confidence: effective.confidence,
          zone: effective.zone,
          candidates: [],
          skipAgent: false,
          note: effective.note,
        };
      }

      const candidates = yield* retrieveCandidates(input.text, k);
      let finalCandidates = candidates;
      let skipAgent = computeSkipAgent(candidates);

      if (!skipAgent && candidates.length > 1) {
        const state = buildDecisionState(input.recentContext, input.text);
        const relevance = yield* judgeCandidates(state, candidates);
        if (relevance !== null) {
          finalCandidates = applyDecisionRelevance(candidates, relevance);
          skipAgent = computeSkipAgent(
            finalCandidates.map((candidate) => ({
              retrievalScore: candidate.decisionRelevance ?? candidate.retrievalScore,
            })),
          );
        }
      }

      return {
        intent: "ACTION",
        confidence: effective.confidence,
        zone: effective.zone,
        candidates: finalCandidates,
        skipAgent,
        note: effective.note,
      };
    });

  return { resolve } satisfies PromptbarClientShape;
});

export const PromptbarClientLive = Layer.effect(PromptbarClient, make);
