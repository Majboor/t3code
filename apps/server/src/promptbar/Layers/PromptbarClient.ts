import { Config, Effect, Layer, Option } from "effect";

import { PromptbarClient, PromptbarError, type PromptbarClientShape } from "../Services/PromptbarClient.ts";

const PromptbarEnvConfig = Config.all({
  classifierUrl: Config.string("T3CODE_PROMPTBAR_CLASSIFIER_URL").pipe(
    Config.withDefault("http://192.168.18.201:18090"),
  ),
});

/**
 * STUB pending the real hybrid-retrieval build (FTS5 BM25 + dense/Qdrant +
 * RRF fusion + classifier intent routing, see PromptbarClient.ts's module
 * doc). Always reports "not configured" so callers fail closed instead of
 * silently returning fabricated candidates. Replace this Layer body, not the
 * Service interface in ../Services/PromptbarClient.ts - that shape is frozen
 * and other work builds against it directly.
 */
const make = Effect.gen(function* () {
  yield* PromptbarEnvConfig;

  const resolve: PromptbarClientShape["resolve"] = () =>
    Effect.fail(
      new PromptbarError({ message: "Promptbar hybrid retrieval is not implemented on this instance yet." }),
    );

  return { resolve };
});

export const PromptbarClientLive = Layer.effect(PromptbarClient, make);
