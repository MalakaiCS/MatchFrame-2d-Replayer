import { Suspense } from "react";
import { MultiRound } from "@/components/MultiRound";

export const metadata = { title: "Rounds together" };

export default function Page() {
  return <Suspense><MultiRound /></Suspense>;
}
