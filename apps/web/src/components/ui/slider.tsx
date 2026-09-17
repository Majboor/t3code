"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

function Slider({ className, ...props }: SliderPrimitive.Root.Props) {
  return <SliderPrimitive.Root className={cn("relative", className)} {...props} />;
}

function SliderControl({ className, ...props }: SliderPrimitive.Control.Props) {
  return (
    <SliderPrimitive.Control
      className={cn("relative flex w-full touch-none items-center py-2 select-none", className)}
      {...props}
    />
  );
}

function SliderTrack({ className, ...props }: SliderPrimitive.Track.Props) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn("relative h-1.5 w-full grow rounded-full bg-border", className)}
      {...props}
    />
  );
}

function SliderIndicator({ className, ...props }: SliderPrimitive.Indicator.Props) {
  return (
    <SliderPrimitive.Indicator
      className={cn("absolute h-full rounded-full bg-foreground/70", className)}
      {...props}
    />
  );
}

function SliderThumb({ className, ...props }: SliderPrimitive.Thumb.Props) {
  return (
    <SliderPrimitive.Thumb
      className={cn(
        "block size-4.5 cursor-grab rounded-full border-2 border-foreground/70 bg-background shadow-sm outline-none transition-transform active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-[dragging]:scale-110",
        className,
      )}
      {...props}
    />
  );
}

export { Slider, SliderControl, SliderTrack, SliderIndicator, SliderThumb };
