import "../../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { OnboardingModal } from "./OnboardingModal";

// The modal posts the answers on its way out of every exit it offers, so the
// only thing worth faking is the network call itself. `vi.hoisted` because
// `vi.mock` runs before the module body does.
const { submitOnboardingMock } = vi.hoisted(() => ({
  submitOnboardingMock: vi.fn(async () => undefined),
}));

vi.mock("../../environments/primary", async () => {
  const actual = await vi.importActual<typeof import("../../environments/primary")>(
    "../../environments/primary",
  );
  return { ...actual, submitOnboarding: submitOnboardingMock };
});

/**
 * The modal is portalled into `document.body`, so rendering it is enough to
 * find it — but its last step navigates, and `useNavigate` needs a real router
 * with the connections route actually present. Without that route a passing
 * test would only prove that clicking did nothing.
 */
async function renderModal(onDone: () => void) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <OnboardingModal onDone={onDone} />,
  });
  const connectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/connections",
    component: () => <div>provider accounts panel</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, connectionsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    router,
    screen: await render(<RouterProvider router={router as never} />),
  };
}

/** Walk the three personalization questions, answering one option on each. */
async function answerQuestions() {
  for (const label of ["Individual developer", "New to this", "Backend"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
}

describe("OnboardingModal", () => {
  afterEach(() => {
    submitOnboardingMock.mockClear();
    document.body.innerHTML = "";
  });

  it("ends on a step that says GLM is already working and offers the two that aren't", async () => {
    const { screen } = await renderModal(vi.fn());
    try {
      await answerQuestions();

      await expect.element(page.getByTestId("onboarding-providers-step")).toBeInTheDocument();
      // The whole point of the step: the free one needs no action, and is said
      // to need no action.
      expect(document.body.textContent ?? "").toContain("GLM-5.3 is included");
      await expect.element(page.getByText("Connect Codex")).toBeInTheDocument();
      await expect.element(page.getByText("Connect Claude")).toBeInTheDocument();
      // There is no "Connect GLM", because there is nothing to connect.
      expect(document.body.textContent ?? "").not.toContain("Connect GLM");
    } finally {
      await screen.unmount();
    }
  });

  it("sends Connect Codex to the real provider panel and gets out of its way", async () => {
    const onDone = vi.fn();
    const { router, screen } = await renderModal(onDone);
    try {
      await answerQuestions();
      await page.getByText("Connect Codex").click();

      // Both halves matter. Routing without finishing would leave the
      // full-screen questionnaire sitting on top of the page it just opened.
      await vi.waitFor(() => {
        expect(router.state.location.pathname).toBe("/settings/connections");
      });
      expect(onDone).toHaveBeenCalled();
      expect(submitOnboardingMock).toHaveBeenCalledWith({
        role: "individual",
        experience: "new",
        focus: "backend",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("stays skippable on the last step, and keeps the answers that were given", async () => {
    const onDone = vi.fn();
    const { router, screen } = await renderModal(onDone);
    try {
      await answerQuestions();
      // Skipping is how the e2e harness clears this overlay, so it has to be
      // here on the step that was added after the questions too.
      await page.getByRole("button", { name: "Skip for now", exact: true }).click();

      await vi.waitFor(() => {
        expect(onDone).toHaveBeenCalled();
      });
      expect(submitOnboardingMock).toHaveBeenCalledWith({
        role: "individual",
        experience: "new",
        focus: "backend",
      });
      expect(router.state.location.pathname).toBe("/");
    } finally {
      await screen.unmount();
    }
  });
});
