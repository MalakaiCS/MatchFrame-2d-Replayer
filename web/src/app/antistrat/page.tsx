import { Suspense } from "react";
import { AntiStrat } from "@/components/AntiStrat";

export const metadata = { title: "Anti-strat" };

export default function Page() {
  return <Suspense><AntiStrat /></Suspense>;
}
