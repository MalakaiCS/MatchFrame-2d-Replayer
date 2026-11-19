import { Suspense } from "react";
import { StatsHub } from "@/components/StatsHub";

export const metadata = { title: "Stats" };

export default function Page() {
  return <Suspense><StatsHub /></Suspense>;
}
