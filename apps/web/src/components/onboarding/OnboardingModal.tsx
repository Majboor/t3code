"use client";

import type {
  CompleteOnboardingInput,
  OnboardingExperience,
  OnboardingFocus,
  OnboardingRole,
} from "@t3tools/contracts";
import { useState } from "react";

import { submitOnboarding } from "../../environments/primary";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

interface Question<TValue extends string> {
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly value: TValue; readonly label: string }>;
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

  return (
    <Dialog open modal>
      <DialogPopup className="max-w-md">
        <div className="flex items-center justify-between">
          <DialogTitle>{current.title}</DialogTitle>
          <span className="text-xs text-muted-foreground">
            {step + 1} of {STEPS.length}
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-2">
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
        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" disabled={submitting} onClick={skip}>
            Skip for now
          </Button>
          <Button size="sm" disabled={submitting || !selected} onClick={advance}>
            {step < STEPS.length - 1 ? "Next" : "Done"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
