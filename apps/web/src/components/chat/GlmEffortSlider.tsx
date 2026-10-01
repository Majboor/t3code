import { memo, useState } from "react";
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "../ui/slider";
import {
  GLM_EFFORT_TIER_LABEL,
  GLM_EFFORT_TIER_MODEL,
  GLM_EFFORT_TIER_MODEL_LABEL,
  GLM_EFFORT_TIERS,
  tierForGlmModel,
} from "../../glmEffortTiers";

export interface GlmEffortSliderProps {
  model: string;
  onModelChange: (model: string) => void;
}

/**
 * Replaces a raw model checklist with a draggable slider — the position IS
 * the choice (drag across the tiers, e.g. Low/High), not a list you click
 * into. Tier count is whatever `GLM_EFFORT_TIERS` lists; each snap position
 * is a genuinely different real model (`glmEffortTiers.ts`), dragging calls
 * `onModelChange` with that real model id on every step crossed, wired by the
 * caller into the same `onProviderModelChange` path any other model change
 * already uses — this component has no opinion on how the switch happens.
 */
export const GlmEffortSlider = memo(function GlmEffortSlider({
  model,
  onModelChange,
}: GlmEffortSliderProps) {
  const initialTier = tierForGlmModel(model) ?? "high";
  const initialIndex = GLM_EFFORT_TIERS.indexOf(initialTier);
  const [index, setIndex] = useState(
    initialIndex === -1 ? GLM_EFFORT_TIERS.length - 1 : initialIndex,
  );
  const tier = GLM_EFFORT_TIERS[index] ?? "high";

  return (
    <div className="px-3 py-2.5">
      <div className="mb-2 text-center font-medium text-sm">
        {GLM_EFFORT_TIER_MODEL_LABEL[tier]}
      </div>
      <Slider
        value={index}
        min={0}
        max={GLM_EFFORT_TIERS.length - 1}
        step={1}
        onValueChange={(value) => {
          const nextIndex = typeof value === "number" ? value : value[0];
          if (nextIndex === undefined || nextIndex === index) return;
          setIndex(nextIndex);
          const nextTier = GLM_EFFORT_TIERS[nextIndex];
          if (nextTier) onModelChange(GLM_EFFORT_TIER_MODEL[nextTier]);
        }}
      >
        <SliderControl>
          <SliderTrack>
            <SliderIndicator />
            {GLM_EFFORT_TIERS.map((_, tickIndex) => (
              <span
                key={tickIndex}
                aria-hidden="true"
                className="-translate-y-1/2 absolute top-1/2 size-1 rounded-full bg-background"
                style={{ left: `${(tickIndex / (GLM_EFFORT_TIERS.length - 1)) * 100}%` }}
              />
            ))}
            <SliderThumb />
          </SliderTrack>
        </SliderControl>
      </Slider>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        {GLM_EFFORT_TIERS.map((tierOption) => (
          <span key={tierOption}>{GLM_EFFORT_TIER_LABEL[tierOption]}</span>
        ))}
      </div>
    </div>
  );
});
