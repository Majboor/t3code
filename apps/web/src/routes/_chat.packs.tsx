import { createFileRoute } from "@tanstack/react-router";

import { PackBrowserPage } from "../components/packBrowser/PackBrowserPage";

export const Route = createFileRoute("/_chat/packs")({
  component: PackBrowserPage,
});
