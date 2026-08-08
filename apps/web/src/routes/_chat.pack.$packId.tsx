import { createFileRoute } from "@tanstack/react-router";

import { PackDetailPage } from "../components/packDashboard/PackDetailPage";
import { parsePackRouteSearch } from "../components/packDashboard/packDetail.logic";

function PackDetailRouteView() {
  const { packId } = Route.useParams();
  const { version } = Route.useSearch();

  return <PackDetailPage packId={packId} {...(version ? { version } : {})} />;
}

export const Route = createFileRoute("/_chat/pack/$packId")({
  validateSearch: (search) => parsePackRouteSearch(search),
  component: PackDetailRouteView,
});
