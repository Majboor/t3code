import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { GlmEffortSlider } from "./GlmEffortSlider";

function dragThumbTo(container: HTMLElement, targetX: number) {
  // The thumb's own outer div (what a real pointer actually touches) is the
  // one with `data-index` — the nested `<input type="range">` inside it is
  // visually hidden (clip-path) and only carries the implicit ARIA role.
  const thumb = container.querySelector("[data-index]") as HTMLElement;
  const track = container.querySelector('[data-slot="slider-track"]') as HTMLElement;
  const thumbRect = thumb.getBoundingClientRect();
  const trackRect = track.getBoundingClientRect();
  const startX = thumbRect.left + thumbRect.width / 2;
  const startY = thumbRect.top + thumbRect.height / 2;
  const endX = trackRect.left + trackRect.width * targetX;

  thumb.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      clientX: startX,
      clientY: startY,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 1,
    }),
  );
  // Base UI's slider control listens for `pointermove`/`pointerup` on the
  // document once a drag starts (see `SliderControl.js`'s `onPointerDown`) —
  // it also bails out of a move if `event.buttons === 0`, so the held button
  // must be reflected on every move event, same as a real held-mouse drag.
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((endX - startX) * i) / steps;
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: x,
        clientY: startY,
        pointerId: 1,
        isPrimary: true,
        buttons: 1,
      }),
    );
  }
  document.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      clientX: endX,
      clientY: startY,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 0,
    }),
  );
}

describe("GlmEffortSlider", () => {
  it("shows the real model name for the starting tier and drags to a different real model", async () => {
    const onModelChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <GlmEffortSlider model="z-ai/glm-5.3-flash-uncensored" onModelChange={onModelChange} />,
      { container: host },
    );

    expect(document.body.textContent ?? "").toContain("GLM-5.3 Flash (Uncensored)");

    // Drag from the High (rightmost) position to the far left — Low.
    dragThumbTo(host, 0);

    await vi.waitFor(() => {
      expect(onModelChange).toHaveBeenCalledWith("deepseek/deepseek-v4.1-flash");
    });
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("DeepSeek Flash");
    });

    await screen.unmount();
    host.remove();
  });

  it("dragging to the middle position selects the Medium (DeepSeek Thinking) model", async () => {
    const onModelChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <GlmEffortSlider model="z-ai/glm-5.3-flash-uncensored" onModelChange={onModelChange} />,
      { container: host },
    );

    dragThumbTo(host, 0.5);

    await vi.waitFor(() => {
      expect(onModelChange).toHaveBeenCalledWith("deepseek/deepseek-v4.1-flash-thinking");
    });

    await screen.unmount();
    host.remove();
  });
});
