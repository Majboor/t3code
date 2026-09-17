import { Config, Effect, Layer, Option } from "effect";

import {
  PromptbarClient,
  PromptbarError,
  type PromptbarClientShape,
  type PromptbarResolution,
} from "../Services/PromptbarClient.ts";

const PromptbarEnvConfig = Config.all({
  baseUrl: Config.url("T3CODE_PROMPTBAR_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
});

const make: Effect.Effect<PromptbarClientShape> = Effect.gen(function* () {
  const { baseUrl } = yield* PromptbarEnvConfig;

  const resolve: PromptbarClientShape["resolve"] = (text, k = 5) =>
    Effect.gen(function* () {
      if (baseUrl === undefined) {
        return yield* new PromptbarError({ message: "Promptbar is not configured on this instance." });
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(new URL("/resolve", baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, k }),
          }),
        catch: (cause) =>
          new PromptbarError({ message: `Could not reach the promptbar service: ${String(cause)}` }),
      });
      if (!response.ok) {
        return yield* new PromptbarError({
          message: `Promptbar service returned ${response.status}.`,
          status: response.status,
        });
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<PromptbarResolution>,
        catch: () => new PromptbarError({ message: "Promptbar service returned a malformed response." }),
      });
      return body;
    });

  return { resolve };
});

export const PromptbarClientLive = Layer.effect(PromptbarClient, make);
