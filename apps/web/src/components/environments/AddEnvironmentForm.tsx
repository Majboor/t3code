import { CheckIcon, Loader2Icon, PlugZapIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { addSavedEnvironment, type SavedEnvironmentRecord } from "~/environments/runtime";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  classifyEnvironmentFailure,
  classifyEnvironmentInput,
  resolveAddEnvironmentNextStep,
  type EnvironmentFailure,
  type EnvironmentInputMode,
} from "./environmentConnect.logic";

const MODES: ReadonlyArray<{ readonly value: EnvironmentInputMode; readonly label: string }> = [
  { value: "pairing-url", label: "Pairing link" },
  { value: "host-code", label: "Host and code" },
];

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor: string }) {
  return (
    <label
      className="block text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase"
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

function FailureNotice({ failure }: { failure: EnvironmentFailure }) {
  return (
    <div
      className="rounded-lg border border-destructive/30 bg-destructive/6 px-3.5 py-3"
      data-testid="add-environment-failure"
      data-failure-kind={failure.kind}
      role="alert"
    >
      <p className="text-sm font-medium text-destructive">{failure.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-destructive/85">{failure.message}</p>
      {failure.detail && failure.detail !== failure.message ? (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-destructive/70 underline-offset-2 hover:underline">
            <span className="group-open:hidden">What the machine actually said</span>
            <span className="hidden group-open:inline">Hide details</span>
          </summary>
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-destructive/75">
            {failure.detail}
          </p>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The form behind every way of adding an environment — the standalone surface,
 * the dialog, and the settings page all render this one.
 *
 * It takes either half of the pair: a pairing link that carries its own token,
 * or a host with a code typed beside it. Pasting a link into the host field
 * moves the form to link mode rather than failing on submit.
 */
export function AddEnvironmentForm({
  autoFocus = false,
  onAdded,
  submitLabel = "Connect",
}: {
  readonly autoFocus?: boolean;
  readonly onAdded?: (record: SavedEnvironmentRecord) => void;
  readonly submitLabel?: string;
}) {
  const [mode, setMode] = useState<EnvironmentInputMode>("pairing-url");
  const [label, setLabel] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [host, setHost] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [failure, setFailure] = useState<EnvironmentFailure | null>(null);
  const [addedRecord, setAddedRecord] = useState<SavedEnvironmentRecord | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const nextStep = useMemo(
    () => resolveAddEnvironmentNextStep({ mode, label, pairingUrl, host, pairingCode }),
    [host, label, mode, pairingCode, pairingUrl],
  );
  const isReady = nextStep.kind === "ready";

  const handleHostChange = useCallback((value: string) => {
    // Somebody handed the whole link and it landed in the wrong box. Move the
    // form rather than making them read an error to find that out.
    if (classifyEnvironmentInput(value) === "pairing-url") {
      setPairingUrl(value);
      setMode("pairing-url");
      return;
    }
    setHost(value);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (nextStep.kind !== "ready" || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setFailure(null);
    setAddedRecord(null);
    try {
      const record = await addSavedEnvironment(nextStep.submit);
      setAddedRecord(record);
      setLabel("");
      setPairingUrl("");
      setHost("");
      setPairingCode("");
      onAdded?.(record);
    } catch (error) {
      setFailure(
        classifyEnvironmentFailure(error, {
          target: mode === "pairing-url" ? readHostname(pairingUrl) : host.trim(),
        }),
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [host, isSubmitting, mode, nextStep, onAdded, pairingUrl]);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div
        className="flex gap-1 rounded-lg border border-border/60 bg-muted/40 p-1"
        role="radiogroup"
        aria-label="How you are connecting"
      >
        {MODES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="radio"
            aria-checked={mode === entry.value}
            className={cn(
              "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              mode === entry.value
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
            disabled={isSubmitting}
            onClick={() => {
              setMode(entry.value);
              setFailure(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {mode === "pairing-url" ? (
        <div className="space-y-1.5">
          <FieldLabel htmlFor="add-environment-pairing-url">Pairing link</FieldLabel>
          <Input
            id="add-environment-pairing-url"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            autoFocus={autoFocus}
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            placeholder="https://my-laptop.local:3210/pair#token=…"
            spellCheck={false}
            value={pairingUrl}
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="add-environment-host">Host</FieldLabel>
            <Input
              id="add-environment-host"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              autoFocus={autoFocus}
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => handleHostChange(event.currentTarget.value)}
              placeholder="my-laptop.local:3210"
              spellCheck={false}
              value={host}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="add-environment-code">Pairing code</FieldLabel>
            <Input
              id="add-environment-code"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              placeholder="Paste the code"
              spellCheck={false}
              value={pairingCode}
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel htmlFor="add-environment-label">Name it (optional)</FieldLabel>
        <Input
          id="add-environment-label"
          autoComplete="off"
          disabled={isSubmitting}
          nativeInput
          onChange={(event) => setLabel(event.currentTarget.value)}
          placeholder="Studio Mac"
          spellCheck={false}
          value={label}
        />
      </div>

      <p
        className="text-xs leading-relaxed text-muted-foreground"
        data-testid="add-environment-hint"
      >
        {nextStep.hint}
      </p>

      {failure ? <FailureNotice failure={failure} /> : null}

      {addedRecord && !failure ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/6 px-3.5 py-3"
          data-testid="add-environment-success"
        >
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
          <div>
            <p className="text-sm font-medium text-foreground">{addedRecord.label} is connected</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              It will reconnect on its own whenever that machine is running.
            </p>
          </div>
        </div>
      ) : null}

      <Button className="w-full" disabled={!isReady || isSubmitting} type="submit">
        {isSubmitting ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />}
        {isSubmitting ? "Connecting…" : submitLabel}
      </Button>
    </form>
  );
}

function readHostname(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return new URL(trimmed).host;
  } catch {
    return null;
  }
}
