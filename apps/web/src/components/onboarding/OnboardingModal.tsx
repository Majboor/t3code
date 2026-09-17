"use client";

import type {
  CompleteOnboardingInput,
  OnboardingExperience,
  OnboardingFocus,
  OnboardingRole,
} from "@t3tools/contracts";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Building2Icon, GaugeIcon, LayersIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { submitOnboarding } from "../../environments/primary";
import { Button } from "../ui/button";

interface Question<TValue extends string> {
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly value: TValue; readonly label: string }>;
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

const STEPS = [ROLE_QUESTION, EXPERIENCE_QUESTION, FOCUS_QUESTION] as const;

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
];

/**
 * Shown once after signup — a short, always-skippable questionnaire that only
 * ever sets the *initial* default for three settings (org/agency visibility,
 * "vibe mode," the API usage tab). Every one of them stays independently
 * toggleable in Settings afterward regardless of what's answered here.
 */
export function OnboardingModal({ onDone }: { readonly onDone: () => void }) {
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

  const skip = () => void finish({ role: null, experience: null, focus: null });

  const current = STEPS[step];
  if (!current) return null;

  const selected = step === 0 ? role : step === 1 ? experience : focus;

  const choose = (value: string) => {
    if (step === 0) setRole(value as OnboardingRole);
    else if (step === 1) setExperience(value as OnboardingExperience);
    else setFocus(value as OnboardingFocus);
  };

  const advance = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    void finish({ role, experience, focus });
  };

  const visual: StepVisual = STEP_VISUALS[step] ?? STEP_VISUALS[0]!;
  const VisualIcon = visual.icon;

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Popup
          aria-label="Welcome questionnaire"
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background text-foreground outline-none lg:flex-row"
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
                <p className="max-w-sm text-sm leading-relaxed text-neutral-400">{visual.subcopy}</p>
              </div>
            </div>

            <div className="relative mt-10 flex gap-1.5 lg:mt-0">
              {STEPS.map((_, index) => (
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
                <span className="text-sm text-muted-foreground">
                  Welcome to {APP_BASE_NAME}
                </span>
                <span className="text-xs text-muted-foreground">
                  {step + 1} of {STEPS.length}
                </span>
              </div>
              <DialogPrimitive.Title className="mt-2 font-heading text-xl font-semibold">
                {current.title}
              </DialogPrimitive.Title>

              <div className="mt-6 flex flex-col gap-2">
                {current.options.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={selected === option.value ? "secondary" : "outline"}
                    className="justify-start"
                    disabled={submitting}
                    onClick={() => choose(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>

              <div className="mt-8 flex items-center justify-between">
                <Button variant="ghost" size="sm" disabled={submitting} onClick={skip}>
                  Skip for now
                </Button>
                <Button size="sm" disabled={submitting || !selected} onClick={advance}>
                  {step < STEPS.length - 1 ? "Next" : "Done"}
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
