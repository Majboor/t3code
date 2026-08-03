import { Context } from "effect";
import type { Effect, Scope } from "effect";

import type { TenantRuntimeLifecycleSchedulerError } from "../runtimeLifecycleScheduler.ts";
import type { TenantRuntimeLifecycleSchedulerResult } from "../runtimeLifecycleScheduler.ts";

export interface TenantRuntimeLifecycleOwnerShape {
  readonly runOnce: Effect.Effect<
    TenantRuntimeLifecycleSchedulerResult,
    TenantRuntimeLifecycleSchedulerError
  >;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class TenantRuntimeLifecycleOwner extends Context.Service<
  TenantRuntimeLifecycleOwner,
  TenantRuntimeLifecycleOwnerShape
>()("t3/tenancy/Services/TenantRuntimeLifecycleOwner") {}
