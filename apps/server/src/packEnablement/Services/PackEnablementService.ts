import { Context } from "effect";
import type { Effect } from "effect";

import {
  PackEnablementError,
  type PackDisableInput,
  type PackEnableInput,
  type PackEnableResult,
  type PackListEnablementsInput,
  type PackListEnablementsResult,
} from "@t3tools/contracts";

export { PackEnablementError };

export interface PackEnablementServiceShape {
  /**
   * Records that a project intends to use a pack. Nothing is installed and no
   * requirement is satisfied — what comes back is the list of what the pack
   * asked for and whether the project has it, which is the only honest thing
   * this can produce without running anything.
   */
  readonly enable: (
    input: PackEnableInput,
  ) => Effect.Effect<PackEnableResult, PackEnablementError>;

  readonly disable: (input: PackDisableInput) => Effect.Effect<void, PackEnablementError>;

  readonly list: (
    input: PackListEnablementsInput,
  ) => Effect.Effect<PackListEnablementsResult, PackEnablementError>;
}

export class PackEnablementService extends Context.Service<
  PackEnablementService,
  PackEnablementServiceShape
>()("t3/packEnablement/Services/PackEnablementService") {}
