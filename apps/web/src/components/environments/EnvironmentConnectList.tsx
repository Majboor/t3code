import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, Loader2Icon, MonitorSmartphoneIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  reconnectSavedEnvironment,
  removeSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  classifyEnvironmentFailure,
  describeListedEnvironment,
  type ListedEnvironmentTone,
} from "./environmentConnect.logic";

const TONE_DOT_CLASS: Record<ListedEnvironmentTone, string> = {
  positive: "bg-success",
  pending: "bg-warning",
  negative: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

const TONE_TEXT_CLASS: Record<ListedEnvironmentTone, string> = {
  positive: "text-muted-foreground",
  pending: "text-muted-foreground",
  negative: "text-destructive/90",
  idle: "text-muted-foreground",
};

function StatusDot({ tone }: { tone: ListedEnvironmentTone }) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center">
      {tone === "pending" ? (
        <span className="absolute size-2.5 animate-ping rounded-full bg-warning/60 duration-2000" />
      ) : null}
      <span className={cn("size-2 rounded-full", TONE_DOT_CLASS[tone])} />
    </span>
  );
}

function hostLabel(httpBaseUrl: string): string {
  try {
    return new URL(httpBaseUrl).host;
  } catch {
    return httpBaseUrl;
  }
}

function EnvironmentRow({
  environmentId,
  isActive,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly isActive: boolean;
  readonly onSelect: ((environmentId: EnvironmentId) => void) | undefined;
}) {
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId] ?? null);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId] ?? null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const presentation = describeListedEnvironment({
    connectionState: runtime?.connectionState ?? "disconnected",
    authState: runtime?.authState ?? "unknown",
    lastError: runtime?.lastError ?? null,
    lastConnectedAt: record?.lastConnectedAt ?? null,
    isRetrying,
  });

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      await reconnectSavedEnvironment(environmentId);
    } catch (error) {
      const failure = classifyEnvironmentFailure(error, {
        target: record ? hostLabel(record.httpBaseUrl) : null,
      });
      toastManager.add({
        type: "error",
        title: failure.title,
        description: failure.message,
      });
    } finally {
      setIsRetrying(false);
    }
  }, [environmentId, record]);

  const handleRemove = useCallback(async () => {
    setIsRemoving(true);
    try {
      await removeSavedEnvironment(environmentId);
      toastManager.add({
        type: "success",
        title: "Environment removed",
        description: record
          ? `${record.label} is no longer connected from this browser.`
          : "That environment is no longer connected from this browser.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not remove that environment",
        description: error instanceof Error ? error.message : "Removing the environment failed.",
      });
      setIsRemoving(false);
    }
  }, [environmentId, record]);

  if (!record) {
    return null;
  }

  const host = hostLabel(record.httpBaseUrl);

  return (
    <li
      className={cn(
        "flex flex-col gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-5",
        isActive ? "bg-accent/35" : null,
      )}
      data-environment-state={presentation.state}
      data-testid="environment-row"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-1">
          <StatusDot tone={presentation.tone} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{record.label}</p>
            {isActive ? (
              <span className="rounded-full border border-border/70 px-1.5 py-px text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                In use
              </span>
            ) : null}
          </div>
          <p className={cn("mt-0.5 text-xs leading-relaxed", TONE_TEXT_CLASS[presentation.tone])}>
            {presentation.statusText}
          </p>
          <button
            type="button"
            className="mt-1 inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={() => copyToClipboard(record.httpBaseUrl, undefined)}
            title="Copy this environment's address"
          >
            {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            <span className="truncate">{isCopied ? "Copied" : host}</span>
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:justify-end">
        {presentation.state === "connected" && !isActive && onSelect ? (
          <Button size="xs" variant="outline" onClick={() => onSelect(environmentId)}>
            Work here
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={!presentation.canRetry || isRemoving}
          onClick={() => void handleRetry()}
        >
          {isRetrying ? <Loader2Icon className="animate-spin" /> : null}
          {presentation.retryLabel}
        </Button>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={isRemoving}
          onClick={() => void handleRemove()}
        >
          {isRemoving ? "Removing…" : "Remove"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Every environment this browser has saved, with the state it is actually in.
 *
 * Adapted from upstream's `CloudEnvironmentConnectRows`: status dot, one line
 * of state under the name, and the action that matters on the right. The
 * states differ because ours are reached directly rather than through a relay.
 */
export function EnvironmentConnectList({
  emptyState,
  onSelect,
}: {
  readonly emptyState?: React.ReactNode;
  readonly onSelect?: (environmentId: EnvironmentId) => void;
}) {
  const savedById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentIds = useMemo(
    () =>
      Object.values(savedById)
        .toSorted((left, right) => left.label.localeCompare(right.label))
        .map((record) => record.environmentId),
    [savedById],
  );

  if (environmentIds.length === 0) {
    return (
      emptyState ?? (
        <div className="flex flex-col items-center gap-2 px-5 py-9 text-center">
          <MonitorSmartphoneIcon className="size-5 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">No environments yet</p>
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            An environment is a machine running the T3 server — usually the one in front of you.
            Connect one and its projects show up here.
          </p>
        </div>
      )
    );
  }

  return (
    <ul className="flex flex-col">
      {environmentIds.map((environmentId) => (
        <EnvironmentRow
          key={environmentId}
          environmentId={environmentId}
          isActive={activeEnvironmentId === environmentId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
