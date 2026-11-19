import { Suspense } from "react";
import { TeamOverview } from "@/components/StatsHub";

export const metadata = { title: "Team overview" };

export default function Page() {
  return <Suspense><TeamOverview /></Suspense>;
}
