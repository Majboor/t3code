import { Config, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { defaultPacksDir, loadPromptbarPacks, type PromptbarPackDefinition } from "../PackSource.ts";
import { rebuildFtsIndex, searchFtsPhrasings, type FtsHit } from "../PackFts.ts";
import { resolveEffectiveIntent, type IntentScores } from "../intentRouting.ts";
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
  type PromptbarZone,
} from "../Services/PromptbarClient.ts";

const PromptbarEnvConfig = Config.all({
  classifierUrl: Config.string("T3CODE_PROMPTBAR_CLASSIFIER_URL").pipe(
    Config.withDefault("http://192.168.18.201:18090"),
  ),
  embeddingUrl: Config.string("T3CODE_EMBEDDING_URL").pipe(
    Config.withDefault("http://192.168.18.201:9400"),
  ),
  qdrantUrl: Config.string("T3CODE_QDRANT_URL").pipe(Config.withDefault("http://192.168.18.201:6333")),
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

function isClassifyResponse(value: unknown): value is ClassifyResponse {
  if (!isPlainRecord(value)) return false;
  const intent = value["intent"];
  const all = value["all"];
  return (
    (intent === "ACTION" || intent === "QUESTION" || intent === "STATEMENT" || intent === "CONTINUATION") &&
    typeof value["confidence"] === "number" &&
    (value["zone"] === "attach" || value["zone"] === "suggest" || value["zone"] === "silent") &&
    isPlainRecord(all) &&
    typeof all["ACTION"] === "number" &&
    typeof all["QUESTION"] === "number" &&
    typeof all["STATEMENT"] === "number" &&
    typeof all["CONTINUATION"] === "number"
  );
}

function isEmbedResponse(value: unknown): value is EmbedResponse {
  return isPlainRecord(value) && Array.isArray(value["vector"]) && typeof value["dim"] === "number";
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

  const postJson = (url: string, body: unknown) =>
    Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
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

  const classify = (text: string) =>
    postJson(`${config.classifierUrl}/classify`, { text }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) => new PromptbarError({ message: `The classifier returned an unreadable response: ${describeCause(cause)}` }),
        }),
      ),
      Effect.flatMap((json) =>
        isClassifyResponse(json)
          ? Effect.succeed(json)
          : Effect.fail(new PromptbarError({ message: "The classifier's response did not match the expected shape." })),
      ),
    );

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
          params: pack.params,
        });
      }
      return candidates;
    });

  const resolve: PromptbarClientShape["resolve"] = (input) =>
    Effect.gen(function* () {
      const k = input.k ?? 5;
      const classified = yield* classify(input.text);
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
      return {
        intent: "ACTION",
        confidence: effective.confidence,
        zone: effective.zone,
        candidates,
        skipAgent: computeSkipAgent(candidates),
        note: effective.note,
      };
    });

  return { resolve } satisfies PromptbarClientShape;
});

export const PromptbarClientLive = Layer.effect(PromptbarClient, make);
