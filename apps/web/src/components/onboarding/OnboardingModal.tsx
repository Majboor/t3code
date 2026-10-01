"use client";

import type {
  CompleteOnboardingInput,
  OnboardingExperience,
  OnboardingFocus,
  OnboardingRole,
} from "@t3tools/contracts";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import {
  Building2Icon,
  CheckIcon,
  ExternalLinkIcon,
  GaugeIcon,
  LayersIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { submitOnboarding } from "../../environments/primary";
import { GLM_EFFORT_TIER_MODEL_LABEL } from "../../glmEffortTiers";
import { PROVIDER_LABELS, type ProviderName } from "../settings/providerAccounts.logic";
import { Button } from "../ui/button";

interface Question<TValue extends string> {
  readonly title: string;
  readonly options: ReadonlyArray<{
    readonly value: TValue;
    readonly label: string;
  }>;
}

interface StepVisual {
  readonly icon: LucideIcon;
  readonly eyebrow: string;
  readonly headline: string;
  readonly subcopy: string;
}

const ROLE_QUESTION: Question<OnboardingRole> = {
  title: "What best describes you?",
  options: [
    { value: "individual", label: "Individual developer" },
    { value: "startup", label: "Startup or small team" },
    { value: "agency", label: "Agency" },
    { value: "enterprise", label: "Enterprise" },
    { value: "student", label: "Student" },
  ],
};

const EXPERIENCE_QUESTION: Question<OnboardingExperience> = {
  title: "How familiar are you with AI coding tools?",
  options: [
    { value: "new", label: "New to this" },
    { value: "some", label: "Some experience" },
    { value: "experienced", label: "Very experienced" },
  ],
};

const FOCUS_QUESTION: Question<OnboardingFocus> = {
  title: "What's your primary focus?",
  options: [
    { value: "backend", label: "Backend" },
    { value: "frontend", label: "Frontend" },
    { value: "fullstack", label: "Full-stack" },
    { value: "unsure", label: "Not sure yet" },
  ],
};

const QUESTIONS = [ROLE_QUESTION, EXPERIENCE_QUESTION, FOCUS_QUESTION] as const;

/**
 * The last step is not a question, so it is addressed by index rather than
 * living in `QUESTIONS`: nothing it collects is submitted with the answers.
 */
const PROVIDERS_STEP = QUESTIONS.length;
const STEP_COUNT = QUESTIONS.length + 1;

/**
 * Where every "connect a provider" affordance in the app already points. The
 * panel there owns the whole sign-in — it asks the server to start it, shows
 * the URL and the code, and takes the code back — so this step routes to it
 * rather than growing a second copy of that flow inside a modal.
 */
const PROVIDER_CONNECT_ROUTE = "/settings/connections" as const;

/**
 * The two providers a person brings themselves. GLM is deliberately not in
 * this list: its key is minted per account at signup and healed server-side,
 * so there is nothing here for someone to connect.
 */
const PROVIDER_OFFERS: ReadonlyArray<{
  readonly provider: ProviderName;
  readonly blurb: string;
}> = [
  { provider: "codex", blurb: "Sign in with your own ChatGPT plan." },
  { provider: "claude", blurb: "Sign in with your own Claude plan." },
];

const STEP_VISUALS: ReadonlyArray<StepVisual> = [
  {
    icon: Building2Icon,
    eyebrow: "Any size team",
    headline: "One agent, wired into how you actually ship.",
    subcopy:
      "Solo, startup or enterprise — the same GLM-5.3 agent connects to your repos and deploy targets from day one.",
  },
  {
    icon: GaugeIcon,
    eyebrow: "Effort, tuned to you",
    headline: "High, medium, or low effort. You pick the dial.",
    subcopy:
      "New to AI coding tools or years in — the effort-tier slider adapts the model to the task, not the other way around.",
  },
  {
    icon: LayersIcon,
    eyebrow: "Packs for the job",
    headline: "Backend, frontend, or full-stack — there's a pack for it.",
    subcopy:
      "LogicPacks ships deployment, analytics and delivery packs so the agent already knows how your stack wants to be shipped.",
  },
  {
    icon: SparklesIcon,
    eyebrow: "Nothing to set up",
    headline: "You can start right now. The other two are optional.",
    subcopy: `${GLM_EFFORT_TIER_MODEL_LABEL.high} is included with every account and is already running for you. ${PROVIDER_LABELS.codex} and ${PROVIDER_LABELS.claude} are subscriptions you bring, and only you ever run on them.`,
  },
];

/**
 * Shown once after signup — a short, always-skippable questionnaire that only
 * ever sets the *initial* default for three settings (org/agency visibility,
 * "vibe mode," the API usage tab). Every one of them stays independently
 * toggleable in Settings afterward regardless of what's answered here.
 *
 * It ends on a step that is not a question at all, because arriving in the
 * product with no idea which models are live is the thing new accounts
 * actually got wrong: GLM is already working and Codex/Claude are not, and
 * only the second half of that is something a person can act on. That step is
 * an introduction, not a gate — it skips like every other one.
 */
export function OnboardingModal({ onDone }: { readonly onDone: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [role, setRole] = useState<OnboardingRole | null>(null);
  const [experience, setExperience] = useState<OnboardingExperience | null>(null);
  const [focus, setFocus] = useState<OnboardingFocus | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const finish = async (input: CompleteOnboardingInput) => {
    setSubmitting(true);
    try {
      await submitOnboarding(input);
    } catch {
      // Onboarding is a courtesy, not a gate — if it fails to save, the user
      // still gets into the product with the same defaults skipping would
      // have produced (the server applies them whenever preferences are
      // first read with no row yet).
    } finally {
      onDone();
    }
  };

  const onProvidersStep = step === PROVIDERS_STEP;

  /**
   * Skipping a question means "I would rather not say", so it submits nothing.
   * Skipping the last step means something else entirely — the questions are
   * already answered by then and the only thing left to decline is connecting
   * a provider — so it keeps what was given instead of throwing it away.
   */
  const skip = () =>
    void finish(
      onProvidersStep ? { role, experience, focus } : { role: null, experience: null, focus: null },
    );

  const current = onProvidersStep ? null : QUESTIONS[step];
  if (!onProvidersStep && !current) return null;

  const selected = step === 0 ? role : step === 1 ? experience : focus;

  const choose = (value: string) => {
    if (step === 0) setRole(value as OnboardingRole);
    else if (step === 1) setExperience(value as OnboardingExperience);
    else setFocus(value as OnboardingFocus);
  };

  const advance = () => {
    if (step < STEP_COUNT - 1) {
      setStep(step + 1);
      return;
    }
    void finish({ role, experience, focus });
  };

  /**
   * Record the answers first, *then* route. This panel is `fixed inset-0
   * z-[110]`, so navigating while it is still mounted would land on the
   * connections page with the questionnaire covering it — and the person
   * would have to find the skip button to see what they just asked for.
   */
  const connectProvider = () => {
    void finish({ role, experience, focus }).then(() => navigate({ to: PROVIDER_CONNECT_ROUTE }));
  };

  const visual: StepVisual = STEP_VISUALS[step] ?? STEP_VISUALS[0]!;
  const VisualIcon = visual.icon;

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        {/* z-[110]: above ProductTourOverlay's z-[100] - onboarding gates the
            whole app, including the tour, so it must never render underneath
            a tour tooltip that started before this account had answered it. */}
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[110] bg-black/60" />
        <DialogPrimitive.Popup
          aria-label="Welcome questionnaire"
          className="fixed inset-0 z-[110] flex flex-col overflow-y-auto bg-background text-foreground outline-none lg:flex-row"
        >
          {/* Left: dark visual panel. Deliberately fixed-dark regardless of
              the app's own light/dark setting, same way the reference
              onboarding kept its marketing panel dark — it's brand surface,
              not app chrome. */}
          <div className="relative flex min-h-56 shrink-0 flex-col justify-between overflow-hidden bg-neutral-950 px-8 py-10 text-neutral-100 sm:px-12 sm:py-12 lg:min-h-0 lg:w-1/2 lg:px-16 lg:py-16">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-24 -left-24 size-96 rounded-full bg-primary/25 blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 bottom-0 size-72 rounded-full bg-primary/10 blur-3xl"
            />

            <span className="relative text-sm font-semibold tracking-tight text-neutral-100">
              {APP_BASE_NAME}
            </span>

            <div className="relative mt-10 flex flex-col gap-6 lg:mt-0">
              <div className="flex size-11 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                <VisualIcon className="size-5 text-neutral-100" />
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
                  {visual.eyebrow}
                </span>
                <h2 className="max-w-sm text-2xl font-semibold tracking-tight text-balance">
                  {visual.headline}
                </h2>
                <p className="max-w-sm text-sm leading-relaxed text-neutral-400">
                  {visual.subcopy}
                </p>
              </div>
            </div>

            <div className="relative mt-10 flex gap-1.5 lg:mt-0">
              {Array.from({ length: STEP_COUNT }, (_, index) => (
                <span
                  key={index}
                  className={
                    index === step
                      ? "h-1.5 w-6 rounded-full bg-neutral-100 transition-all"
                      : "h-1.5 w-1.5 rounded-full bg-white/20 transition-all"
                  }
                />
              ))}
            </div>
          </div>

          {/* Right: the actual form, on the app's own (light/dark-aware) theme. */}
          <div className="flex flex-1 flex-col justify-center px-8 py-10 sm:px-12 lg:w-1/2 lg:px-16">
            <div className="mx-auto w-full max-w-sm">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Welcome to {APP_BASE_NAME}</span>
                <span className="text-xs text-muted-foreground">
                  {step + 1} of {STEP_COUNT}
                </span>
              </div>
              <DialogPrimitive.Title className="mt-2 font-heading text-xl font-semibold">
                {current ? current.title : "What you can run right now"}
              </DialogPrimitive.Title>

              {current ? (
                <div className="mt-6 flex flex-col gap-2">
                  {current.options.map((option) => {
                    const isSelected = selected === option.value;
                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant="outline"
                        className={
                          isSelected
                            ? "justify-between border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                            : "justify-between"
                        }
                        disabled={submitting}
                        onClick={() => choose(option.value)}
                      >
                        {option.label}
                        {isSelected ? <CheckIcon className="size-4 text-primary" /> : null}
                      </Button>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-6 flex flex-col gap-3" data-testid="onboarding-providers-step">
                  {/* The part that needs no action at all, stated first so the
                      two buttons underneath read as optional rather than as a
                      wall between this person and the product. */}
                  <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <CheckIcon className="size-4 text-success" />
                      {GLM_EFFORT_TIER_MODEL_LABEL.high} is included, and already working
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      Your {APP_BASE_NAME} account comes with its own key. Nothing to connect,
                      nothing to paste, and it is yours alone — start a thread and it runs.
                    </p>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {PROVIDER_LABELS.codex} and {PROVIDER_LABELS.claude} are subscriptions you
                    bring. Connect one now, or any time from Settings.
                  </p>

                  {PROVIDER_OFFERS.map((offer) => (
                    <Button
                      key={offer.provider}
                      type="button"
                      variant="outline"
                      className="h-auto justify-between px-3 py-2.5 text-left"
                      data-testid="onboarding-connect-provider"
                      data-provider={offer.provider}
                      disabled={submitting}
                      onClick={connectProvider}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          Connect {PROVIDER_LABELS[offer.provider]}
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {offer.blurb}
                        </span>
                      </span>
                      <ExternalLinkIcon className="size-4" />
                    </Button>
                  ))}
                </div>
              )}

              <div className="mt-8 flex items-center justify-between">
                <Button variant="ghost" size="sm" disabled={submitting} onClick={skip}>
                  Skip for now
                </Button>
                <Button
                  size="sm"
                  disabled={submitting || (!onProvidersStep && !selected)}
                  onClick={advance}
                >
                  {step < STEP_COUNT - 1 ? "Next" : "Done"}
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
